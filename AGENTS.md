# VyOS ISO build AGENTS.md file

## Project purpose

Top-level VyOS image builder. Orchestrates the multi-step build that produces
a hybrid live ISO from Debian packages and VyOS-specific `.deb`s. The official
starting point for anyone building a VyOS image from source. The ISO is
bootable on both BIOS and UEFI systems.

## Tech stack

- Python entry-point for ISO image build is (`build-vyos-image`) and some
  `Makefile` wrappers.
- Container-based build via `docker/` (`Dockerfile` pulls Debian + tooling).
- Debian `live-build` (forked at https://github.com/vyos/vyos-live-build)
  consumed at ISO assembly time as prebuilt `.deb` package.
- Configuration: TOML used as markup language which supports merging multiple
  snippets into one final configuration. Best suited for inheritance. TOML
  files used during build can be found here:
  * `data/architectures/*.toml`
  * `data/build-flavors/*.toml`
  * `data/build-types/*.toml`
  * `data/defaults.toml`
- TOML files are combined by `build-vyos-image` into a single Python dict and
  used to instruct `live-build` to create the ISO image.

## Build instructions

```
make generic                            # builds the generic flavor
./build-vyos-image generic              # equivalent direct call
```

- Must run inside the build container. Container `Dockerfile` located in `docker`
  folder. Use `docker build -t vyos/vyos-build docker` from top-level dir.
- Git submodules are not in use. Prebuilt binary packages are pulled from
  `https://packages.vyos.net/repositories/<train>` at build time.

## Testing instructions

- Requires ISO image generated from build instructions
- `Makefile` has several targets starting with `test*`. Each target tests a
  different path of the resulting image.
- The `test-ci-qcow2` target requires a QCOW2 image being generated as special
  flavor and is used to validate cloud-init by providing the necessary seed
  data. Exclude this from automated tests.
- Test framework is orchestrated by `scripts/check-qemu-install` and internally
  also referred to as smoketests.
- There is no need to run all tests all the time, a single smoketest like the
  one named `test_protocols_bgp.py` can be executed by:
  `make test -- --match protocols_bgp`
- Test framework must run as user `root` to spawn QEMU VMs.

## Repository layout

- `build-vyos-image` - Python entry-point.
- `Makefile` - flavor dispatcher (`make <flavor>` → `./build-vyos-image <flavor>`).
- `data/defaults.toml` - Holds cross-flavor defaults like Linux Kernel version,
  URL to VyOS Debian package repository, release branch/train or bootloaders
- `data/build-flavors/` - per-flavor TOML descriptors (`generic.toml` ships
  canonical).
- `docker/` - build container.
- `scripts/` - `check-qemu-install` (smoketest harness), helper scripts.
- `tools/`, `packages/` - supporting assets.

## Cross-repo context

- All listed packages can be found in the GitHub `vyos` organisation
- Consumes pre-built `*.deb` packages. The most important ones are:
  * `vyos-1x` CLI representation and all configure/op-mode scripts
  * `vyos-cloud-init` our Cloud-init handler
  * `vyos-http-api-tools` HTTP API RESTful and GraphQL
  * `live-boot` fork with custom patches not yet upstreamed
  * `hvinfo` tool to get information from running Hypervisor
  * `vyatta-bash` fork of bash to implement CLI completion help
  * `vyatta-biosdevname` get NIC information also from Hypervisor platforms
  * `vyatta-cfg` referred to as the old configuration backend running CStore.
    It is old but very much in operation.
- ISO assembly delegates to `vyos/vyos-live-build` (Debian live-build fork)
  instead of the upstream live-build version.
- Smoketests inside the QEMU harness exercise `vyos-1x`'s `smoketest/` suite.

## PR instructions

- Commit/PR title must follow: `component: T1234: description`. Phorge IDs at
  https://vyos.dev. Enforced by `check-pr-message.yml` reusable workflow.
- See also `CONTRIBUTING.md` for further hints on the commit messages.
- Linting: unused-imports (Pylint) and J2 lint (note: workflow file is named
  `linit-j2.yml` in this repo — known cosmetic typo). Both inherited from
  `vyos/.github@production`.
- PR conflicts are flagged automatically via `check-pr-conflicts.yml` (reusable
  `check-pr-merge-conflict.yml` from `vyos/.github@production`).

## Notes for future contributors

- No `git submodule init` needed - packages come from the apt mirror at build
  time.
- Bumping `data/defaults.toml`'s `debian_distribution` or `kernel_version` is a
  coordinated change touching multiple build-set repos.
  Open a Phorge task and coordinate with maintainers.
- Reusable workflow `trigger_rebuild_packages.yml` fires REST
  `workflow_dispatch` into `$REMOTE_OWNER/vyos-build-packages` (REMOTE_OWNER =
  the private side). The dispatcher runs as `vyosbot`.
- For new flavors, add a `data/build-flavors/<flavor>.toml` and document the
  resulting `make <flavor>` target.