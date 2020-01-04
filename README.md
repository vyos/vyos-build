VyOS toplevel build
===================

This repository is for building the VyOS versions 1.2.x and above. For VyOS 1.1,
use the [build-iso](https://github.com/vyos/build-iso) repository.

For the most up-to-date documentation, please read the online build guide at
[docs.vyos.io](https://docs.vyos.io/en/crux/contributing/build-vyos.html).

# What is VyOS

VyOS is an open source operating system for network devices (routers, firewalls
and so on). If you want to use it in your network, check out download and
installation instructions at https://vyos.io

If you want to modify VyOS and/or join its development, read on.

VyOS is not new. It is a fork of Vyatta Core that was created when the open
source version of it was discontinued. If you are a Vyatta Core user, you can
upgrade your installation to VyOS.

# What is this repository?

VyOS is a GNU/Linux distribution based on Debian. Just like any other
distribution, it consists of multiple packages.

Some packages are taken from the upstream, while other are modified or written
from scratch by VyOS developers. Every package maintained by the VyOS team has
its own git repository. VyOS image build is therefore a multi-step process.
Packages are compiled first, then an ISO is built from Debian packages and our
own packages.

This is the top level repository that contains links to repositories with VyOS
specific packages (organized as Git submodules) and scripts and data that are
used for building those packages and the installation image.

# Structure of this repository

There are several directories with their own purpose:

   build/    Used for temporary files used for the build and for build artifacts
   scripts/  Scripts that are used for the build process
   data/     Data required for building the ISO (such as boot splash)
   tools/    Scripts that are used for maintainer's tasks automation and other
             purposes, but not during ISO build process

# Building VyOS installation images

## Prerequisites

To build a VyOS 1.2.0 image, you need Debian 8 "Jessie" environment (with
jessie-backports repository).

If you do not have a Debian Jessie machine, you may create a chroot environment
with the [debootstrap](https://wiki.debian.org/Debootstrap) tool.

For example, on another version of Debian or another Debian-based distro, these
commands will work:

```bash
$ sudo apt-get install debootstrap
$ sudo debootstrap jessie vyos-chroot
$ sudo chroot vyos-chroot

$ echo "deb http://deb.debian.org/debian jessie-backports main" >> /etc/apt/sources.list
$ apt-get update
```

If you are working on a Debian Jessie machine, no special preparation is needed,
you only need to enable jessie-backports and install build dependencies. An
up-to-date dependency list can be found in our [Dockerfile](docker/Dockerfile).

Several packages are required for building the ISO:
* `python3`
* `live-build`
* `pbuilder`
* `python3-pystache`

The `./configure` script will warn you if any dependencies are missing. Individual
packages may have other build dependencies. If some dependencies are missing,
package build scripts will tell you.

## Building the ISO image inside a docker container

Using our [Dockerfile](docker/Dockerfile) you create your own Docker container
that is used to build a VyOS ISO image or other required VyOS packages. The
[Dockerfile](docker/Dockerfile) contains some of the most used packages needed
to build a VyOS ISO, a qemu image, and several of the submodules. Please note
that this is not complete and only gives you a brief overview!

```
squashfs-tools           # Required for squashfs file system
git                      # Required, for cloning the source
autoconf                 # Required, for generating build scripts
dpkg-dev                 # Required, used in build scripts
live-build               # Required, for ISO build
syslinux                 # Required, for ISO build
genisoimage              # Required, for ISO build
make                     # Required, for ISO build
lsb-release              # Required, used by configure script
fakechroot               # Required, for ISO build
devscripts               # Optional, for building submodules (kernel etc)
kernel-package           # Optional, for building the kernel
libtool                  # Optional, for building certain packages (vyatta-op-vpn)
libglib2.0-dev           # Optional, for building vyatta-cfg
libboost-filesystem-dev  # Optional, for building vyatta-cfg
libapt-pkg-dev           # Optional, for building vyatta-cfg
flex                     # Optional, for building vyatta-cfg
bison                    # Optional, for building vyatta-cfg
libperl-dev              # Optional, for building vyatta-cfg
libnfnetlink-dev         # Optional, for building vyatta-cfg-vpn
vim                      # Optional, vim, vi, nano or other text editor
jq                       # Optional, for qemu build
qemu-system-x86          # Optional, for qemu build
qemu-utils               # Optional, for qemu build
packer                   # Optional, for qemu build
quilt                    # Optional, for building vyos-1x
python3-lxml             # Optional, for building vyos-1x
python3-setuptools       # Optional, for building vyos-1x
python3-nose             # Optional, for building vyos-1x
python3-coverage         # Optional, for building vyos-1x
...
```

To build the docker image ensure you have a working [Docker](https://www.docker.com)
environment and then run the following commands:

```bash
$ docker build -t vyos-builder docker
```

Run the newly built container:
```bash
$ docker run --rm -it --privileged -v $(pwd):/vyos -w /vyos vyos-builder bash
```

This will drop you into a bash shell with this vyos-build repo mounted at
`/vyos`. Then follow the instructions bellow to build the VyOS ISO and QEMU
image.

```bash
vyos_bld@948a2be7c52c:/vyos$ uname -a
Linux 948a2be7c52c 3.16.0-7-amd64 #1 SMP Debian 3.16.59-1 (2018-10-03) x86_64 GNU/Linux
```

**NOTE:**

* Docker container must be run with `--privileged` flag
* We recommended to run the container with a volume mapped in order to easy
  export built VyOS ISO images to the "external" world
* UNIX ownership is automatically inherited from your host directory but can be
  altered by specifying the following environment variables when running the
  container: `-e GOSU_UID=$(id -u)` and/or `-e GOSU_GID=$(id -g)`

After the Docker container is running you can follow up the instructions below in
order to build the VyOS ISO image.

## Building subpackages inside Docker

Prior to building packages you need to checkout and update the submodules you want to compile

```bash
$ git submodule update --init packages/PACKAGENAME
$ cd packages/PACKAGENAME
$ git checkout BRANCH
```

`PACKAGENAME` is the name of the package you want to compile
`BRANCH` is `crux` for VyOS 1.2.x, latest rolling releases use `current`

Fetching all submodules at once and update them to the recent remote branches
`HEAD` is done by calling:

```bash
$ git submodule update --init --recursive
$ git submodule update --remote
```

### Building packages

The [scripts/build-submodules](scripts/build-submodules) script is used to
automate the process of building (in the future) all VyOS related packages that
are not part of the upstream Debian version. Execute it in the root of the
`vyos-build` directory to start compilation on all supported packages that are
checked out.

The easiest way to compile is with the above mentioned [Docker](docker/Dockerfile)
container, it includes all dependencies for compiling supported packages.

```bash
$ docker run --rm -it -v $(pwd):/vyos -w /vyos \
             --sysctl net.ipv6.conf.lo.disable_ipv6=0 \
             vyos-builder \
             ./scripts/build-submodules
```

**NOTE:** `--sysctl net.ipv6.conf.lo.disable_ipv6=0` is required to build the
`vyos-strongswan` package

**NOTE:** Prior to executing this script you need to create or build the Docker
container and checkout all packages you want to compile.

### Building a single package

The script above runs all package build inside the Docker container, this is also
possible to do by hand using:

Executed from the root of `vyos-build`

```bash
$ docker run --rm -it -v $(pwd):/vyos -w /vyos/packages/PACKAGENAME \
             --sysctl net.ipv6.conf.lo.disable_ipv6=0 \
             vyos-builder \
             dpkg-buildpackage -uc -us -tc -b
```

**NOTE:** `--sysctl net.ipv6.conf.lo.disable_ipv6=0` is only needed when
building `vyos-strongswan` and can be ignored on other packages.

**NOTE:** Prior to executing this you need to checkout and update the submodules
you want to recompile!

**NOTE:** `vyos-strongswan` will only compile on a Linux system, running on macOS
or Windows might result in a unittest deadlock (it never exits).

Packages that are known to not build using this procedure (as of now):

```
vyatta-util     - Not needed anymore
vyatta-quagga   - Not needed anymore
vyos-1x         - Unmet build dependencies: whois libvyosconfig0
vyos-frr        - A lot of requirements, scary stuff...
vyos-kernel     - Need special build instructions
vyos-wireguard  - Needs special build instructions
```

## Building the ISO image

Before you can build an image, you need to configure your build.

To build an image, use the following commands:

```bash
$ ./configure
$ make iso
```

The `./configure` script has a number of options that you can see by calling it
with `--help`

## Building the images for virtualization platforms

### QEMU

Run following command after building the ISO image.

```bash
$ make qemu
```

### VMware

Run following command after building the QEMU image.

```bash
$ make vmware
```

# Development process

## Git branches

The default branch that contains the most recent VyOS code is called `current`
rather than `master`. We know it's confusing, but it's not easy to fix. In a
nutshell, the code we inherited from Vyatta Core had its `master` branch so out
of sync with everything it was beyond any repair. Vyatta developers used to create
a new branch not when a release is ready for code freeze, but rather before
starting to work on a new release. This is hard to change in existing code, so
this is just the way it is, for now.

All new code goes to the `current` branch. When it's time for a code freeze, a
new branch is created for the release, and new code from `current` is backported
to the release branch as needed.

In packages that originate from VyOS the master branch is kept in sync with
`current`, but we still use `current` as default branch for uniformity. When the
last legacy package is gone, we will switch to using the `master` branch and
retire `current`.

For branch naming we switched to use constellations:
* `crux`
* ...
