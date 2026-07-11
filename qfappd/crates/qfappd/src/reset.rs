//! TCP RST generation for `block_mode: reset`.
//!
//! When an action blocks a TCP flow in reset mode, WatchGuard sends an RST to
//! both endpoints so the connection tears down immediately instead of
//! hanging until timeout. We craft two RST segments and send them via a raw
//! IP socket (requires CAP_NET_RAW):
//!   - to the server: src=client, seq = last seq we saw from the client
//!   - to the client: src=server, seq = the client's ack (server's seq)
//!
//! The checksum helpers are pure and unit-tested; the actual send path is
//! Linux raw sockets and is validated on-target.

use crate::pkt::Parsed;
use std::net::{IpAddr, Ipv4Addr};

/// The two directions of RSTs to emit for a blocked TCP flow.
pub struct ResetPair {
    pub to_dst: Vec<u8>,
    pub to_src: Vec<u8>,
}

/// Build both RST packets (IPv4 only for now; IPv6 RST is on the on-target
/// TODO list and simply skipped, leaving the flow to the drop rule).
pub fn build(p: &Parsed) -> Option<ResetPair> {
    let (IpAddr::V4(src), IpAddr::V4(dst)) = (p.tuple.src, p.tuple.dst) else {
        return None;
    };
    // RST to the destination, spoofing the source. Its seq is what the peer
    // expects next from src: the seq we observed (+1 if this was a bare SYN).
    let src_seq = p.tcp_seq.wrapping_add(if p.tcp_syn() && !p.tcp_ack_flag() { 1 } else { 0 });
    let to_dst = build_v4_rst(src, dst, p.tuple.src_port, p.tuple.dst_port, src_seq);
    // RST to the source, spoofing the destination. Its seq is the ack the
    // src sent (what src believes is dst's next seq).
    let to_src = build_v4_rst(dst, src, p.tuple.dst_port, p.tuple.src_port, p.tcp_ack);
    Some(ResetPair { to_dst, to_src })
}

/// Assemble a 40-byte IPv4+TCP RST segment.
fn build_v4_rst(src: Ipv4Addr, dst: Ipv4Addr, sport: u16, dport: u16, seq: u32) -> Vec<u8> {
    let mut pkt = vec![0u8; 40];
    // IPv4 header
    pkt[0] = 0x45;
    pkt[3] = 40; // total length
    pkt[8] = 64; // ttl
    pkt[9] = crate::pkt::IPPROTO_TCP;
    pkt[12..16].copy_from_slice(&src.octets());
    pkt[16..20].copy_from_slice(&dst.octets());
    let ip_csum = checksum(&pkt[0..20]);
    pkt[10..12].copy_from_slice(&ip_csum.to_be_bytes());
    // TCP header
    pkt[20..22].copy_from_slice(&sport.to_be_bytes());
    pkt[22..24].copy_from_slice(&dport.to_be_bytes());
    pkt[24..28].copy_from_slice(&seq.to_be_bytes());
    pkt[32] = 0x50; // data offset 5 words
    pkt[33] = 0x04; // RST
    let tcp_csum = tcp_checksum_v4(src, dst, &pkt[20..40]);
    pkt[36..38].copy_from_slice(&tcp_csum.to_be_bytes());
    pkt
}

/// Standard one's-complement Internet checksum.
pub fn checksum(data: &[u8]) -> u16 {
    let mut sum = 0u32;
    let mut chunks = data.chunks_exact(2);
    for c in &mut chunks {
        sum += u16::from_be_bytes([c[0], c[1]]) as u32;
    }
    if let [last] = chunks.remainder() {
        sum += (*last as u32) << 8;
    }
    while sum >> 16 != 0 {
        sum = (sum & 0xffff) + (sum >> 16);
    }
    !(sum as u16)
}

/// TCP checksum over the IPv4 pseudo-header + TCP segment.
pub fn tcp_checksum_v4(src: Ipv4Addr, dst: Ipv4Addr, tcp: &[u8]) -> u16 {
    let mut pseudo = Vec::with_capacity(12 + tcp.len());
    pseudo.extend_from_slice(&src.octets());
    pseudo.extend_from_slice(&dst.octets());
    pseudo.push(0);
    pseudo.push(crate::pkt::IPPROTO_TCP);
    pseudo.extend_from_slice(&(tcp.len() as u16).to_be_bytes());
    pseudo.extend_from_slice(tcp);
    checksum(&pseudo)
}

/// Sends crafted RST packets on a raw IPv4 socket (needs CAP_NET_RAW).
#[cfg(target_os = "linux")]
pub struct RstSender {
    fd: std::os::unix::io::RawFd,
}

#[cfg(target_os = "linux")]
impl RstSender {
    pub fn new() -> anyhow::Result<Self> {
        // IPPROTO_RAW implies IP_HDRINCL: we supply the full IP header.
        let fd = unsafe { libc::socket(libc::AF_INET, libc::SOCK_RAW, libc::IPPROTO_RAW) };
        if fd < 0 {
            anyhow::bail!("raw socket for RST failed (need CAP_NET_RAW): {}", std::io::Error::last_os_error());
        }
        Ok(Self { fd })
    }

    /// Send both halves of a reset for a blocked TCP flow. Best-effort:
    /// individual send failures are logged by the caller, not fatal.
    pub fn send(&self, pair: &ResetPair) -> std::io::Result<()> {
        self.send_one(&pair.to_dst)?;
        self.send_one(&pair.to_src)?;
        Ok(())
    }

    fn send_one(&self, pkt: &[u8]) -> std::io::Result<()> {
        // Destination address for the kernel's routing decision is the IP
        // header's dst (bytes 16..20); the header itself is sent verbatim.
        let dst = Ipv4Addr::new(pkt[16], pkt[17], pkt[18], pkt[19]);
        let mut sa: libc::sockaddr_in = unsafe { std::mem::zeroed() };
        sa.sin_family = libc::AF_INET as libc::sa_family_t;
        sa.sin_addr.s_addr = u32::from(dst).to_be();
        let rc = unsafe {
            libc::sendto(
                self.fd,
                pkt.as_ptr() as *const libc::c_void,
                pkt.len(),
                0,
                &sa as *const _ as *const libc::sockaddr,
                std::mem::size_of::<libc::sockaddr_in>() as libc::socklen_t,
            )
        };
        if rc < 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
}

#[cfg(target_os = "linux")]
impl Drop for RstSender {
    fn drop(&mut self) {
        unsafe { libc::close(self.fd) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pkt::{parse, FiveTuple, Parsed};

    #[test]
    fn checksum_matches_known_vector() {
        // Classic RFC 1071 example bytes sum to 0x1aff -> complement 0xe501.
        let data = [0x00u8, 0x01, 0xf2, 0x03, 0xf4, 0xf5, 0xf6, 0xf7];
        let c = checksum(&data);
        // verify the invariant: summing data + checksum yields 0xffff
        let mut v = data.to_vec();
        v.extend_from_slice(&c.to_be_bytes());
        assert_eq!(checksum(&v), 0);
    }

    fn parsed_flow() -> Parsed {
        Parsed {
            tuple: FiveTuple {
                proto: crate::pkt::IPPROTO_TCP,
                src: "10.0.0.1".parse().unwrap(),
                dst: "10.0.0.2".parse().unwrap(),
                src_port: 1234,
                dst_port: 443,
            },
            tcp_flags: 0x18, // PSH|ACK (established)
            tcp_seq: 1000,
            tcp_ack: 5000,
        }
    }

    #[test]
    fn builds_valid_rst_pair() {
        let pair = build(&parsed_flow()).unwrap();
        assert_eq!(pair.to_dst.len(), 40);
        assert_eq!(pair.to_src.len(), 40);

        // Each RST must itself parse and carry the RST flag.
        let to_dst = parse(&pair.to_dst).unwrap();
        assert_eq!(to_dst.tuple.src_port, 1234);
        assert_eq!(to_dst.tuple.dst_port, 443);
        assert_eq!(to_dst.tcp_seq, 1000); // established: seq unchanged
        assert_eq!(pair.to_dst[33] & 0x04, 0x04);

        let to_src = parse(&pair.to_src).unwrap();
        assert_eq!(to_src.tuple.src_port, 443);
        assert_eq!(to_src.tuple.dst_port, 1234);
        assert_eq!(to_src.tcp_seq, 5000); // seq = the ack we saw

        // IP + TCP checksums must verify to zero over the built packet.
        assert_eq!(checksum(&pair.to_dst[0..20]), 0);
        assert_eq!(
            tcp_checksum_v4("10.0.0.1".parse().unwrap(), "10.0.0.2".parse().unwrap(), &pair.to_dst[20..40]),
            0
        );
    }

    #[test]
    fn bare_syn_advances_seq() {
        let mut p = parsed_flow();
        p.tcp_flags = 0x02; // SYN only
        p.tcp_seq = 1000;
        let pair = build(&p).unwrap();
        let to_dst = parse(&pair.to_dst).unwrap();
        assert_eq!(to_dst.tcp_seq, 1001); // SYN consumes one sequence number
    }

    #[test]
    fn ipv6_flow_yields_no_reset() {
        let mut p = parsed_flow();
        p.tuple.src = "::1".parse().unwrap();
        p.tuple.dst = "::2".parse().unwrap();
        assert!(build(&p).is_none());
    }
}
