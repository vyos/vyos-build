# Building QuartzFire on Windows (WSL2)

End-to-end guide to build a QuartzFire ISO — the VyOS base **plus** the
QuartzFire WebUI — from a Windows workstation using WSL2 and Docker.

There are two build stages:

1. **The WebUI package** (`quartzfire-webui_*.deb`) — Rust backend + Next.js
   frontend, built in a Debian container with a current Rust toolchain.
2. **The ISO** — the VyOS `live-build` process (in the `vyos/vyos-build`
   container) that bakes every `packages/*.deb` into a bootable image.

> **Two hard requirements, learned the hard way** (see [Troubleshooting](#troubleshooting)):
> 1. The repo **must live on the WSL2 ext4 filesystem** (`~/…`), **not** on
>    `/mnt/c/…`. The ISO build does a `debootstrap` that creates device nodes,
>    which the Windows-mounted filesystem cannot do.
> 2. Use the **Linux Docker engine inside WSL** (`docker.io`), not Docker Desktop
>    bind-mounting a Windows path — same device-node problem.

---

## 0. One-time environment setup

### Install WSL2 + Ubuntu

From an **elevated PowerShell** on Windows:

```powershell
wsl --install -d Ubuntu
```

Reboot if prompted, then open the **Ubuntu** shell for everything below.

### Install Docker and git (inside WSL)

```bash
sudo apt-get update
sudo apt-get install -y docker.io git
sudo usermod -aG docker "$USER"
```

Close and reopen the Ubuntu shell so the `docker` group membership takes effect.
Verify you are on the **Linux** engine (not Docker Desktop):

```bash
docker info --format '{{.OperatingSystem}}'    # expect a Linux distro, e.g. "Debian GNU/Linux 12"
docker run --rm hello-world                     # sanity check
```

### Clone the repo onto ext4 (NOT /mnt/c)

```bash
cd ~
git clone https://github.com/quartzsystems/quartz-fire.git quartz-fire
cd quartz-fire

findmnt -no FSTYPE -T .        # MUST print: ext4   (if it says 9p/drvfs, you are on /mnt/c — move it)
```

If you have an existing checkout on the Windows drive, copy it over once:

```bash
cp -r /mnt/c/Users/<you>/Documents/GitHub/.../quartz-fire ~/quartz-fire
```

---

## 1. Build the WebUI `.deb`

```bash
bash quartzfire-webui/build-deb.sh
```

What it does (all inside a `rust:1-bookworm` container, so no toolchain pollutes
your WSL):

- installs `build-essential nodejs npm debhelper devscripts`
- restores exec bits on the `debian/` maintainer scripts (Windows checkouts drop them)
- exports the Next.js frontend to `quartzfire-webui/backend/www` (`npm run build`)
- runs `dpkg-buildpackage -us -uc -b`
- copies the resulting `quartzfire-webui_*.deb` into **`packages/`**

The first run pulls the base image and compiles all Rust crates, so expect a few
minutes. Success ends with the `.deb` listed under `packages/`.

> The build script auto-installs everything in `packages/*.deb` into the ISO
> (see `scripts/image-build/build-vyos-image`), so no other wiring is needed.

---

## 2. Build the ISO

Build the VyOS build container once, then run the flavor build inside it:

```bash
docker build -t vyos/vyos-build docker

docker run --rm -it --privileged \
  -v "$(pwd)":/vyos -w /vyos \
  vyos/vyos-build bash

#  ── inside the container ──
make quartzfire
exit
```

- `--privileged` is required — `live-build`/`debootstrap` create device nodes and
  loop-mount the squashfs.
- The `quartzfire` flavor is defined in `data/build-flavors/quartzfire.toml`.
- Output: **`build/live-image-amd64.hybrid.iso`**.

---

## 3. Copy the ISO to Windows

```bash
ls -lh ~/quartz-fire/build/*.iso
cp ~/quartz-fire/build/*.iso /mnt/c/Users/<you>/Downloads/
```

Or open the folder in Explorer and drag it out:

```bash
cd ~/quartz-fire/build && explorer.exe .
# opens \\wsl.localhost\Ubuntu\home\<you>\quartz-fire\build\
```

Write it to USB with [Rufus](https://rufus.ie) / [balenaEtcher](https://etcher.balena.io)
(hybrid ISO → use DD/raw image mode), or attach it directly to a VM
(Hyper-V, VirtualBox, QEMU).

---

## 4. Boot & verify (zero-touch)

Boot the ISO. Default live credentials: **`vyos` / `vyos`**.

### Networking — DHCP on the single interface

```shell
show interfaces                       # find the NIC name (usually eth0)

configure
set interfaces ethernet eth0 address dhcp
set interfaces ethernet eth0 description 'WAN'
commit ; save
run show interfaces ethernet eth0     # note the assigned IP → <box-ip>
exit
```

### The API key is automatic

No manual `set service https api keys …` step — `quartzfire-register-api-key.service`
generates a per-device key and registers it on first boot. Confirm:

```shell
journalctl -u quartzfire-register-api-key.service -b --no-pager
show configuration commands | match "https api"      # the key line should already be present
```

### Open the WebUI

Browse to **`https://<box-ip>/`** (real port 443 — QuartzFire's nginx serves the
SPA and proxies `/api` to the VyOS API). The page should report
**"connected to VyOS API."**

---

## Rebuild loop (fast iteration)

After changing WebUI source:

```bash
bash quartzfire-webui/build-deb.sh                                   # rebuild deb → packages/
docker run --rm -it --privileged -v "$(pwd)":/vyos -w /vyos vyos/vyos-build bash -c 'make quartzfire'
cp build/*.iso /mnt/c/Users/<you>/Downloads/
```

For a truly clean ISO rebuild, run `make clean` (or `make purge`) inside the
container first.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `mknod: … Operation not supported` / `mounted with noexec or nodev` during `make quartzfire` | Repo is on `/mnt/c` (9p/drvfs) or bind-mounted via Docker Desktop — can't create device nodes | Move the repo to WSL2 ext4 (`~/…`); use `docker.io` inside WSL. Verify `findmnt -no FSTYPE -T .` prints `ext4` |
| `build-deb.sh: Permission denied` | Script lost its exec bit in a Windows checkout | `bash quartzfire-webui/build-deb.sh`, or `chmod +x` + `git update-index --chmod=+x` |
| `dpkg-checkbuilddeps: Unmet build dependencies: build-essential:native cargo rustc` | `build-essential` missing; Debian's `cargo`/`rustc` (1.63) too old for axum 0.7 | Handled by `build-deb.sh` (installs `build-essential`; toolchain comes from the `rust:1-bookworm` image). `cargo`/`rustc` are intentionally **not** in `debian/control` |
| API `ss ... grep 8080` shows nothing | VyOS has no public TCP API port; it fronts the API via nginx :443 → `/run/api.sock` | Backend targets `https://127.0.0.1` (:443), not `:8080` |
| WebUI page loads but "API not reachable" | Proxied `/api` request hits the WebUI's own `default_server` and loops (Host mismatch) | Backend sends `Host: <hostname>` so nginx routes to VyOS's block. Confirm VyOS's `server_name` == system hostname |
| Register service re-commits every boot | (Fixed) `return_value()` reads empty session config in op-mode | Uses `return_effective_value()`; `save_config('/config/config.boot')` persists |
| `Unit quartzfire-register-api-key.service could not be found`; nothing on :443 | `dh_installsystemd` skips `debian/<pkg>.<name>.service` without `--name` | `override_dh_installsystemd` calls `dh_installsystemd --name=quartzfire-register-api-key`. That service also configures `service https`, which starts nginx on :443 |
| Backend log shows `vyos_api_host: "debian"` | Read `/etc/hostname` (build-chroot value) instead of the live hostname | Default now reads `/proc/sys/kernel/hostname` (= `vyos`) |
| WebUI reaches VyOS but gets `404` on `/api/*` (503 would mean api off) | `service https api rest` not enabled — the key alone doesn't mount the REST endpoints | `set service https api rest`. The register service now sets this automatically alongside the key |
| CRLF / bad shebang errors in container | Windows line endings on shell/maintainer scripts | `.gitattributes` in `quartzfire-webui/` forces LF; re-checkout if already corrupted |

---

## Reference: paths & ports

| Thing | Value |
|---|---|
| ISO output | `build/live-image-amd64.hybrid.iso` |
| WebUI deb | `packages/quartzfire-webui_*.deb` |
| Backend config | `/etc/quartzfire/webui.toml` |
| API key (per device) | `/etc/quartzfire/vyos-api.key` |
| Backend listen | `127.0.0.1:8443` (nginx fronts it on :443) |
| VyOS API target | `https://127.0.0.1` → `/run/api.sock` |
| Static frontend | `/usr/share/quartzfire-webui/www` |
| Register service | `quartzfire-register-api-key.service` |
