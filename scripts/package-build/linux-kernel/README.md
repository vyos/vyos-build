# Build
```
./build.py --config package.toml --packages linux-kernel accel-ppp xxx
```

# About

VyOS runs on a custom Linux Kernel. The version built is pinned by
`kernel_version` in [data/defaults.toml](../../../data/defaults.toml). This
repository holds the build scripts used to build the custom Kernel for
x86_64/amd64 and arm64, plus all required out-of-tree modules.

VyOS does not utilize the build in Intel Kernel drivers for its NICs as those
Kernels sometimes lack features e.g. configurable receive-side-scaling queues.
On the other hand we ship additional not mainlined features as WireGuard VPN.

## Kernel

The Kernel is build from the vanilla repositories hosted at https://git.kernel.org.
VyOS requires a few additional patches to work which are stored in the
patches/kernel folder. They are applied *before* the Kernel configuration is
generated, as a patch may introduce new Kconfig symbols.

### Config

The Kernel configuration is assembled by `build-kernel.sh` using the Kernel's own
`scripts/kconfig/merge_config.sh`:

* a per-architecture base configuration, selected from `dpkg --print-architecture`
  * amd64 -> [config/x86/vyos_defconfig](config/x86/vyos_defconfig)
  * arm64 -> [config/arm64/vyos_defconfig](config/arm64/vyos_defconfig)
* all feature snippets in [config/](config/) (`config/*.config`), merged on top of
  the base in file name order
* a temporary snippet enabling module signing, generated at build time when
  `data/certificates/*.pem` are present

`merge_config.sh` concatenates all of the above, runs `make alldefconfig`, and
then verifies that every requested line appears verbatim in the resulting
`.config`. Any that does not is reported as:

```
Value requested for CONFIG_FOO not in final .config
```

These warnings are deliberately **not** suppressed - they are the only signal we
get when a snippet silently stops taking effect (symbol removed upstream,
dependency no longer met, or a value overridden by a `select`). Treat a new
warning as a bug to be investigated, not as noise.

#### Regenerating a base configuration

The per-architecture base configurations are full `.config` dumps and must be
regenerated whenever they fall far enough behind the Kernel version that the
warnings above become unmanageable. Build natively on the target architecture
and run:

```bash
cd scripts/package-build/linux-kernel/linux
scripts/kconfig/merge_config.sh ../config/<arch>/vyos_defconfig ../config/*.config
cd ..
cp linux/.config config/<arch>/vyos_defconfig
# host specific values - these differ per builder and must never be committed
sed -i -E '/^CONFIG_(CC_VERSION_TEXT|GCC_VERSION|CLANG_VERSION|LLD_VERSION|RUSTC_VERSION|RUSTC_LLVM_VERSION|AS_VERSION|LD_VERSION|PAHOLE_VERSION)=/d' config/<arch>/vyos_defconfig
# injected at build time from data/certificates - must never be committed
sed -i -E '/^CONFIG_SYSTEM_TRUSTED_KEYS=/d' config/<arch>/vyos_defconfig
```

Re-running `merge_config.sh` against the regenerated file must now produce a
byte identical `.config` - that fixed point is the proof the file is canonical.
Verify there is no functional change by diffing the produced `.config` from
before and after, never the `vyos_defconfig` files themselves.

Note that `build-kernel.sh` starts with `git reset --hard` and `git clean -fdx`
inside `linux/`, so anything you want to keep from a previous run has to be
copied out of that directory first.

### Modules

VyOS utilizes several Out-of-Tree modules (e.g. WireGuard, Accel-PPP and Intel
network interface card drivers). Module source code is retrieved from the
upstream repository and - when needed - patched so it can be build using this
pipeline.
