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
                                     ├── /                 static files (exported Next.js; login shell)
                                     ├── /api/auth/*       login/logout/me (session issue/verify)
                                     └── /api/*  ──auth──> VyOS HTTPS API https://127.0.0.1:4443
                                                           (form `key` field injected here)
```

nginx is the sole owner of :443; the VyOS API is pinned to loopback on :4443
(`service https listen-address 127.0.0.1` + `port 4443`, injected at first
boot) and serves its own TLS with a self-signed certificate.

The browser never sees the VyOS API key. All privileged config/commit calls go
through the VyOS HTTP API (`vyos-http-api-tools`).

### Authentication

Security model ported from the vyos-fabric project; credentials are the users
configured on VyOS itself.

- `POST /api/auth/login` reads `system login user` via the local VyOS API and
  verifies the password against that user's `encrypted-password` sha512-crypt
  hash **in-process** (the daemon is an unprivileged `DynamicUser`, so
  PAM//etc/shadow is not an option — and the VyOS config tree is the source of
  truth for users anyway). Unknown user, locked account, and wrong password all
  return the same `401 invalid credentials`, with a dummy hash round so timing
  doesn't leak which usernames exist.
- Sessions are JWTs (HS256, 24 h) carried in an `HttpOnly; SameSite=Lax;
  Secure` cookie — JS can never read the token, and cross-site POSTs don't
  carry it. The signing secret is generated on first start into the systemd
  `StateDirectory` (`/var/lib/quartzfire-webui/jwt.secret`, 0600).
- **Every** `/api/*` route — including the VyOS API proxy — sits behind the
  auth middleware; only `/auth/login`, `/auth/logout`, and the static SPA are
  public. The session cookie is stripped before requests are forwarded to the
  VyOS API.

### Zero-touch API key

`scripts/register-api-key` generates a unique key per device
(`/etc/quartzfire/vyos-api.key`) and injects it into `config.boot` with
`vyos.configtree` (equivalent to `set service https api rest`, `set service
https api keys id quartzfire key '<key>'`, plus `listen-address 127.0.0.1` /
`port 4443` on fresh systems), so the **normal boot commit** applies it.

It is invoked from the image's default preconfig hook
(`/config/scripts/vyos-preconfig-bootup.script`, shipped via
`data/live-build-config/includes.chroot/...`): `vyos-router` restores that hook
from the rootfs whenever it is missing and runs it after `config.boot` is
created and migrated but **before** it is loaded — the only moment the file is
guaranteed to exist and editable pre-commit. (`/config` itself is bind-mounted
only at the *end* of vyos-router startup; the persisted file lives at
`/opt/vyatta/etc/config/config.boot`.) `quartzfire-register-api-key.service`
also runs it before vyos-router as belt-and-braces for non-first boots and dev
boxes.

The script is idempotent — once the key is in `config.boot`, later boots are a
no-op. It deliberately does **not** open a runtime `ConfigSession`/commit at
boot: a leaked boot-time session can wedge every subsequent config session on
the box ("can't initialize output").

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
vyos_api_url  = "https://127.0.0.1:4443"
vyos_api_key_file = "/etc/quartzfire/vyos-api.key"
www_root      = "/usr/share/quartzfire-webui/www"
jwt_secret_file = "/var/lib/quartzfire-webui/jwt.secret"
cookie_secure = true               # set false only for plain-HTTP local dev
session_hours = 24
```

## Status

Login is implemented end-to-end: the sign-in page (Quartz design system, at
`/`) authenticates against VyOS-configured users, and the whole `/api/*`
surface — including the VyOS proxy — requires a session. `/dashboard` is a
placeholder behind the auth guard; the real console views come next.
