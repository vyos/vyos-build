//! Minimal IP/L4 header parsing for the queue path.
//!
//! NFQUEUE delivers packets at the network layer (the IP header is the start
//! of the payload); the VLAN id, when the flow is tagged, comes from NFQUEUE
//! metadata rather than the payload, so this module only needs IPv4/IPv6 +
//! TCP/UDP enough to build a flow key and locate the L4 payload. We keep our
//! own tiny parser rather than pulling the whole packet through a heavier
//! library on the hot path.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

pub const IPPROTO_TCP: u8 = 6;
pub const IPPROTO_UDP: u8 = 17;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FiveTuple {
    pub proto: u8,
    pub src: IpAddr,
    pub dst: IpAddr,
    pub src_port: u16,
    pub dst_port: u16,
}

#[derive(Debug, Clone, Copy)]
pub struct Parsed {
    pub tuple: FiveTuple,
    /// TCP flags byte (0 for UDP) — used by the reset path.
    pub tcp_flags: u8,
    /// TCP sequence / ack (host order); 0 for UDP. Needed to craft a RST.
    pub tcp_seq: u32,
    pub tcp_ack: u32,
}

impl Parsed {
    pub fn is_tcp(&self) -> bool {
        self.tuple.proto == IPPROTO_TCP
    }

    pub fn tcp_syn(&self) -> bool {
        self.tcp_flags & 0x02 != 0
    }

    pub fn tcp_ack_flag(&self) -> bool {
        self.tcp_flags & 0x10 != 0
    }
}

/// Parse an IPv4/IPv6 packet with a TCP or UDP payload. Returns None for
/// anything else (non-IP, fragments we can't key, unsupported L4) — those
/// flows are simply accepted without classification.
pub fn parse(buf: &[u8]) -> Option<Parsed> {
    let version = buf.first()? >> 4;
    match version {
        4 => parse_v4(buf),
        6 => parse_v6(buf),
        _ => None,
    }
}

fn parse_v4(buf: &[u8]) -> Option<Parsed> {
    if buf.len() < 20 {
        return None;
    }
    let ihl = (buf[0] & 0x0f) as usize * 4;
    if ihl < 20 || buf.len() < ihl {
        return None;
    }
    let proto = buf[9];
    // Non-first fragment (offset != 0) has no L4 header — don't misparse.
    let frag_off = u16::from_be_bytes([buf[6], buf[7]]) & 0x1fff;
    if frag_off != 0 {
        return None;
    }
    let src = IpAddr::V4(Ipv4Addr::new(buf[12], buf[13], buf[14], buf[15]));
    let dst = IpAddr::V4(Ipv4Addr::new(buf[16], buf[17], buf[18], buf[19]));
    parse_l4(buf, ihl, proto, src, dst)
}

fn parse_v6(buf: &[u8]) -> Option<Parsed> {
    if buf.len() < 40 {
        return None;
    }
    let mut next = buf[6];
    let mut off = 40;
    let src = IpAddr::V6(Ipv6Addr::from(<[u8; 16]>::try_from(&buf[8..24]).ok()?));
    let dst = IpAddr::V6(Ipv6Addr::from(<[u8; 16]>::try_from(&buf[24..40]).ok()?));
    // Walk a bounded number of extension headers to reach TCP/UDP.
    for _ in 0..8 {
        match next {
            IPPROTO_TCP | IPPROTO_UDP => return parse_l4(buf, off, next, src, dst),
            // hop-by-hop(0), routing(43), dest-opts(60): 8-byte-unit length.
            0 | 43 | 60 => {
                if buf.len() < off + 2 {
                    return None;
                }
                let hdr_len = (buf[off + 1] as usize + 1) * 8;
                next = buf[off];
                off += hdr_len;
            }
            _ => return None, // fragment(44), ESP, etc. — not classified
        }
    }
    None
}

fn parse_l4(buf: &[u8], l4_off: usize, proto: u8, src: IpAddr, dst: IpAddr) -> Option<Parsed> {
    match proto {
        IPPROTO_TCP => {
            if buf.len() < l4_off + 20 {
                return None;
            }
            let src_port = u16::from_be_bytes([buf[l4_off], buf[l4_off + 1]]);
            let dst_port = u16::from_be_bytes([buf[l4_off + 2], buf[l4_off + 3]]);
            let seq = u32::from_be_bytes(buf[l4_off + 4..l4_off + 8].try_into().ok()?);
            let ack = u32::from_be_bytes(buf[l4_off + 8..l4_off + 12].try_into().ok()?);
            let flags = buf[l4_off + 13];
            Some(Parsed {
                tuple: FiveTuple { proto, src, dst, src_port, dst_port },
                tcp_flags: flags,
                tcp_seq: seq,
                tcp_ack: ack,
            })
        }
        IPPROTO_UDP => {
            if buf.len() < l4_off + 8 {
                return None;
            }
            let src_port = u16::from_be_bytes([buf[l4_off], buf[l4_off + 1]]);
            let dst_port = u16::from_be_bytes([buf[l4_off + 2], buf[l4_off + 3]]);
            Some(Parsed {
                tuple: FiveTuple { proto, src, dst, src_port, dst_port },
                tcp_flags: 0,
                tcp_seq: 0,
                tcp_ack: 0,
            })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // IPv4 + TCP SYN, src 10.0.0.1:1234 -> dst 10.0.0.2:443
    fn v4_tcp() -> Vec<u8> {
        let mut p = vec![
            0x45, 0x00, 0x00, 0x28, // ver/ihl, tos, total len
            0x00, 0x00, 0x00, 0x00, // id, flags/frag=0
            0x40, IPPROTO_TCP, 0x00, 0x00, // ttl, proto, csum
            10, 0, 0, 1, // src
            10, 0, 0, 2, // dst
        ];
        p.extend_from_slice(&[
            0x04, 0xd2, 0x01, 0xbb, // sport 1234, dport 443
            0x00, 0x00, 0x00, 0x01, // seq
            0x00, 0x00, 0x00, 0x00, // ack
            0x50, 0x02, 0xff, 0xff, // data offset 5, flags SYN
            0x00, 0x00, 0x00, 0x00,
        ]);
        p
    }

    #[test]
    fn parses_v4_tcp() {
        let p = parse(&v4_tcp()).unwrap();
        assert_eq!(p.tuple.proto, IPPROTO_TCP);
        assert_eq!(p.tuple.src_port, 1234);
        assert_eq!(p.tuple.dst_port, 443);
        assert_eq!(p.tuple.src, "10.0.0.1".parse::<IpAddr>().unwrap());
        assert!(p.is_tcp());
        assert!(p.tcp_syn());
        assert!(!p.tcp_ack_flag());
        assert_eq!(p.tcp_seq, 1);
    }

    #[test]
    fn rejects_v4_fragment_tail() {
        let mut p = v4_tcp();
        p[6] = 0x00;
        p[7] = 0x05; // fragment offset != 0
        assert!(parse(&p).is_none());
    }

    #[test]
    fn parses_v6_udp() {
        let mut p = vec![0x60, 0, 0, 0, 0, 8, IPPROTO_UDP, 64];
        p.extend_from_slice(&[0u8; 16]); // src ::
        let mut dst = [0u8; 16];
        dst[15] = 1;
        p.extend_from_slice(&dst); // dst ::1
        p.extend_from_slice(&[0x00, 0x35, 0x30, 0x39, 0x00, 0x08, 0x00, 0x00]); // sport 53 dport 12345
        let parsed = parse(&p).unwrap();
        assert_eq!(parsed.tuple.proto, IPPROTO_UDP);
        assert_eq!(parsed.tuple.src_port, 53);
        assert_eq!(parsed.tuple.dst_port, 12345);
    }

    #[test]
    fn rejects_non_ip_and_truncated() {
        assert!(parse(&[]).is_none());
        assert!(parse(&[0x25]).is_none()); // version 2
        assert!(parse(&[0x45, 0x00]).is_none()); // truncated v4
    }
}
