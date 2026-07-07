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

`quartzfire-register-api-key.service` runs on first boot and:

1. generates a unique key per device (`/etc/quartzfire/vyos-api.key`), and
2. registers it in the VyOS config via the config API (equivalent to
   `set service https api keys id quartzfire key '<key>'`) and commits/saves it.

So the appliance is usable with no manual API setup. The service is idempotent —
once the key is persisted to `config.boot`, later boots are a no-op.

## Build

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
vyos_api_url  = "http://127.0.0.1:8080"
vyos_api_key_file = "/etc/quartzfire/vyos-api.key"
www_root      = "/usr/share/quartzfire-webui/www"
```

## Status

Skeleton. TODOs are marked inline; the proxy, static serving, and packaging are
wired end-to-end but the frontend is a single placeholder page and the VyOS API
surface is not yet mapped to UI.
