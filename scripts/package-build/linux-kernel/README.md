# Build
```
./build.py --config package.toml --packages linux-kernel accel-ppp xxx
```

# About

VyOS runs on a custom Linux Kernel (which is 6.6) at the time of this writing.
This repository holds build scripts that are used to build the Custom Kernel
(x86_64/amd64 at the moment) and all required out-of tree modules.

VyOS does not utilize the build in Intel Kernel drivers for its NICs as those
Kernels sometimes lack features e.g. configurable receive-side-scaling queues.
On the other hand we ship additional not mainlined features as WireGuard VPN.

## Kernel

The Kernel is build from the vanilla repositories hosted at https://git.kernel.org.
VyOS requires two additional patches to work which are stored in the patches/kernel
folder.

### Config

The Kernel configuration used is [x86_64_vyos_defconfig](x86_64_vyos_defconfig)
which will be copied on demand during the Pipeline run into the `arch/x86/configs`
directory of the Kernel source tree.

Other configurations can be added in the future easily.

### Modules

VyOS utilizes several Out-of-Tree modules (e.g. WireGuard, Accel-PPP and Intel
network interface card drivers). Module source code is retrieved from the
upstream repository and - when needed - patched so it can be build using this
pipeline.
