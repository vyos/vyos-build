# AGENTS.md — vyos/vyos-build

## Project purpose
Top-level VyOS image builder. Orchestrates the multi-step build that produces a hybrid live ISO from Debian packages and VyOS-specific `.deb`s. The official starting point for anyone building a VyOS image from source.

## Tech stack
- Python entry-point (`build-vyos-image`) + `Makefile` wrapper.
- Container-based build via `docker/` (Dockerfile pulls Debian + tooling).
- Debian `live-build` (forked) consumed at ISO assembly time.
- Configuration: TOML (`data/defaults.toml`, `data/build-flavors/*.toml`).

## Build / test / run
```
make generic                                    # builds the generic flavor
./build-vyos-image generic                      # equivalent direct call
make test ISO_PATH=...                          # smoketest via scripts/check-qemu-install
scripts/check-qemu-install --smoketest --iso build/live-image-amd64.hybrid.iso
```
Run inside the build container (`cd docker && docker build -t vyos/vyos-build .`). No git submodules — packages are pulled from `https://packages.vyos.net/repositories/<train>` at runtime.

## Repository layout
- `build-vyos-image` — Python entry-point.
- `Makefile` — flavor dispatcher (`make <flavor>` → `./build-vyos-image <flavor>`).
- `data/defaults.toml` — defaults: `debian_distribution = "bookworm"`, `vyos_mirror = "https://packages.vyos.net/repositories/current"`, `vyos_branch = "current"`, `release_train = "current"`, `kernel_version = "6.6.135"`, `bootloaders = "syslinux,grub-efi"`.
- `data/build-flavors/` — per-flavor TOML descriptors (`generic.toml` ships canonical).
- `docker/` — build container.
- `scripts/` — `check-qemu-install` (smoketest harness), helper scripts.
- `tools/`, `packages/` — supporting assets.

## Cross-repo context
- Consumes per-package builds listed in `VyOS-Networks/vyos-build-packages/repos.toml` (the canonical 14-repo set: `vyos-1x`, `vyos-utils`, `vyos-cloud-init`, `vyos-http-api-tools`, `live-boot`, `hvinfo`, `ipaddrcheck`, `udp-broadcast-relay`, `vyatta-bash`, `vyatta-biosdevname`, `vyatta-cfg`, `vyatta-wanloadbalance`, `libvyosconfig`, `vyos-user-utils`).
- ISO assembly delegates to `vyos/vyos-live-build` (Debian live-build fork).
- Release-train builds run from `VyOS-Networks/vyos-stream-builds`. Nightly ISO trigger is `vyos/vyos-nightly-build`.
- Smoketests inside the QEMU harness exercise `vyos-1x`'s `smoketest/` suite.

## Conventions
- Commit/PR title: `component: T12345: description`. Phorge IDs at https://vyos.dev. Enforced by `check-pr-message.yml` reusable.
- Linting: ruff, darker, unused-imports, J2 lint (note: workflow file is named `linit-j2.yml` in this repo — known cosmetic typo). All inherited from `vyos/.github@current`.
- Mergify config (`mergify.yml`) present: single rule that adds `conflicts` label.

## Mirror relationship
**Live consumer** of the gen-1 PR mirror pipeline (`pr-mirror-repo-sync.yml`). Mirror twin: `VyOS-Networks/vyos-build`. Edit canonical side only.

## Notes for future contributors
- No `git submodule init` needed — packages come from the apt mirror at build time.
- Bumping `data/defaults.toml`'s `debian_distribution` or `kernel_version` is a coordinated change touching multiple build-set repos. Open a Phorge task and coordinate with maintainers.
- Reusable workflow `trigger_rebuild_packages.yml` fires REST `workflow_dispatch` into `$REMOTE_OWNER/vyos-build-packages` (REMOTE_OWNER = VyOS-Networks). The dispatcher runs as `vyosbot`.
- For new flavors, add a `data/build-flavors/<flavor>.toml` and document the resulting `make <flavor>` target.
