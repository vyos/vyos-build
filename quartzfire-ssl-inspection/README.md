# quartzfire-ssl-inspection

WatchGuard-style **SSL Inspection** for QuartzFire: Squid `ssl_bump` as the
**sole** TLS terminator, a self-signed inspection CA, transparent
interface-scoped interception, a do-not-inspect (splice) list, a plain-HTTP CA
distribution page on `:4126`, and a **pre-wired but idle** ICAP seam for a
future content filter.

One Rust multi-call binary (`qzssl`) owns the `service quartzfire
ssl-inspection` VyOS config nodes, the CA lifecycle, the CA-distribution page,
the Squid build-capability probe, and the status plumbing the WebUI reads.

> **Read `docs/design.md` before touching this.** The binding architecture rule:
> Squid owns TLS and the *one* CA; a future e2guardian/c-icap engine attaches
> behind Squid over ICAP in **plaintext** mode and must never do its own TLS
> MITM or hold its own CA.

## Build

```sh
./build-deb.sh        # → ../packages/quartzfire-ssl-inspection_*.deb (rust:1-bookworm)
cargo test            # pure-logic suite (runs anywhere; no squid/vyos needed)
```

`build-vyos-image` bakes every `packages/*.deb` into the ISO. The `quartzfire`
flavor adds `squid-openssl` to its apt list (stock `squid` lacks bump support).

## Verify the ICAP seam locally

```sh
tests/icap-echo/smoke.sh   # squid-openssl + throwaway ICAP echo in Docker
```

Proves bumped **plaintext** HTTP reaches ICAP for REQMOD + RESPMOD, and that a
configured-but-down filter fails **closed**. Tears everything down afterward.
