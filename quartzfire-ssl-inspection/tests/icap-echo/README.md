# ICAP-seam smoke test

Proves the SSL-inspection **ICAP seam** end-to-end with a real `squid-openssl`,
so the future content-filter engine (e2guardian in ICAP mode, c-icap/ClamAV) is
demonstrably a **drop-in** — no change to the TLS layer or the CA.

```sh
./smoke.sh          # Linux / WSL
wsl bash smoke.sh   # Windows (Docker Desktop + WSL)
```

It runs one throwaway `debian:bookworm` container that:

1. asserts `squid-openssl` has `--with-openssl` **and** `--enable-icap-client`
   (the build guard — a stock `squid` fails here);
2. generates the inspection CA, inits the certgen DB, starts a local self-signed
   HTTPS origin, the `icap_echo.py` no-op ICAP server, and a `ssl-bump` Squid
   with `bypass=off`;
3. drives a bumped HTTPS request and asserts the **echo received decrypted
   plaintext** for both **REQMOD** (`GET /hello`) and **RESPMOD** (the origin
   response) — this is the whole point: Squid bumps *before* adaptation, so the
   ICAP engine never needs its own TLS;
4. stops the echo and asserts the request **fails closed** (Squid does not
   return the origin's 200) — the `fail-mode closed` guarantee.

Everything is torn down with `--rm`. Nothing is installed on the host.

> The container uses a forward-proxy `http_port … ssl-bump` to drive a bump
> without an interface to intercept; the device itself uses transparent
> `https_port … intercept ssl-bump` (same ssl_bump + ICAP wiring). The on-device
> transparent-interception and commit-confirm acceptance steps are documented in
> `../../docs/design.md`.
