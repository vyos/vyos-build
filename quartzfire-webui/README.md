# QuartzFire WebUI

Web management interface for QuartzFire (a VyOS-based firewall OS).

- **`backend/`** — Rust (axum) daemon. Serves the exported frontend as static
  files and reverse-proxies `/api/*` to the local VyOS HTTP API, injecting the
  API key server-side so it never reaches the browser.
- **`frontend/`** — Next.js app built with `output: 'export'` → static HTML/JS/CSS.
  No Node.js runtime on the appliance.
- **`debian/`** — packaging that produces a single `quartzfire-webui_*.deb`:
  installs the backend binary + exported frontend, ships a systemd unit and an
  nginx snippet, and enables both in `postinst`.

## Architecture

```
browser ──https──> nginx :443 ──> quartzfire-webui (axum) :8443
                                     ├── /             static files (exported Next.js)
                                     └── /api/*  ──>   VyOS HTTPS API https://127.0.0.1
                                                       (form `key` field injected here)
```

The browser never sees the VyOS API key. All privileged config/commit calls go
through the VyOS HTTP API (`vyos-http-api-tools`).

### Zero-touch API key

`quartzfire-register-api-key.service` runs **before** `vyos-router.service` and:

1. generates a unique key per device (`/etc/quartzfire/vyos-api.key`), and
2. injects it into `/config/config.boot` with `vyos.configtree` (equivalent to
   `set service https api rest` + `set service https api keys id quartzfire
   key '<key>'`), so the normal boot config load applies it.

So the appliance is usable with no manual API setup. The service is idempotent —
once the key is in `config.boot`, later boots are a no-op. It deliberately does
**not** open a runtime `ConfigSession`/commit at boot: a leaked boot-time
session can wedge every subsequent config session on the box.

## Build

For the full Windows/WSL2 workflow (environment setup, ISO build, flashing,
troubleshooting) see [`docs/build-wsl.md`](../docs/build-wsl.md). Quick version:

```
# 1. Frontend → static export
cd frontend && npm ci && npm run build      # emits ../backend/www

# 2. Backend + package
cd .. && dpkg-buildpackage -us -uc -b        # emits ../quartzfire-webui_*.deb

# 3. Fold into the ISO
cp ../quartzfire-webui_*.deb ../packages/    # picked up by build-vyos-image
cd .. && make quartzfire
```

## Runtime config

`/etc/quartzfire/webui.toml` (installed by the package, override on device):

```toml
listen        = "127.0.0.1:8443"   # nginx proxies to this
vyos_api_url  = "https://127.0.0.1"
# vyos_api_host = "vyos"           # Host header (defaults to /etc/hostname)
vyos_api_key_file = "/etc/quartzfire/vyos-api.key"
www_root      = "/usr/share/quartzfire-webui/www"
```

## Status

Skeleton. TODOs are marked inline; the proxy, static serving, and packaging are
wired end-to-end but the frontend is a single placeholder page and the VyOS API
surface is not yet mapped to UI.
