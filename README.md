VyOS toplevel build
===================

# What is VyOS

VyOS is an open source operating system for network devices (routers, firewalls
and so on). If you want to use it in your network, check out download and
installation instructions at https://vyos.io

If you want to modify VyOS and/or join its development, read on.

VyOS is not new. It is a fork of Vyatta Core that was created when the open
source version of it was discontinued. If you are a Vyatta Core user, you can
upgrade your installation to VyOS.

# About this repository

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

# Repository Structure

There are several directories with their own purpose:

 * `build/`   Used for temporary files used for the build and for build artifacts
 * `scripts/` Scripts that are used for the build process
 * `data/`    Data required for building the ISO (e.g. boot splash/configs)
 * `tools/`   Scripts that are used for maintainer's tasks automation and other
              purposes, but not during ISO build process

# Building installation images

## Prerequisites

To build a VyOS 1.2.0 image, you need Debian 8 "Jessie" environment (with
jessie-backports repository).

If you are working on a Debian Jessie machine, no special preparation is needed,
you only need to enable jessie-backports and install build dependencies.

If you are interested which individual packages are required please check our
[Dockerfile](docker/Dockerfile) which holds the most complete documentation
of required packages. Listing individual packages here tend to be always
outdated. We try to list required packages in groups through their inheritance
in the [Dockerfile](docker/Dockerfile).

### Debootstrap

If you do not have a Debian Jessie machine, you may create a chroot environment
with the [debootstrap](https://wiki.debian.org/Debootstrap) tool.

For example, on another version of Debian or another Debian-based distro, these
commands will work:

```bash
$ sudo apt-get install debootstrap
$ sudo debootstrap jessie vyos-chroot
$ sudo chroot vyos-chroot

$ echo "deb http://archive.debian.org/debian/ jessie-backports main" >> /etc/apt/sources.list
$ apt-get update -o Acquire::Check-Valid-Until=false
```

**NOTE:** We recommend to use the Docker build method

### Docker

**NOTE:** Currently the image can only be build with docker on Linux system 

Using our [Dockerfile](docker/Dockerfile) you create your own Docker container
that is used to build a VyOS ISO image or other required VyOS packages. The
[Dockerfile](docker/Dockerfile) contains some of the most used packages needed
to build a VyOS ISO, a qemu image, and several of the submodules.

To build the docker image ensure you have a working [Docker](https://www.docker.com)
environment and then run the following commands:

```bash
$ docker build -t vyos-builder docker
```

Run newly built container:
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

## Building the ISO image

The `./configure` script will warn you if any dependencies are missing. Individual
packages may have other build dependencies. If some dependencies are missing,
package build scripts will tell you.

```bash
$ ./configure --help
usage: configure [-h] [--build-by BUILD_BY] [--version VERSION]
                 [--pbuilder-debian-mirror PBUILDER_DEBIAN_MIRROR]
                 [--debian-security-mirror DEBIAN_SECURITY_MIRROR]
                 [--architecture ARCHITECTURE] [--vyos-mirror VYOS_MIRROR]
                 [--build-type BUILD_TYPE] [--debian-mirror DEBIAN_MIRROR]
                 [--debug] [--custom-apt-entry CUSTOM_APT_ENTRY]
                 [--custom-apt-key CUSTOM_APT_KEY]
                 [--custom-package CUSTOM_PACKAGE]

optional arguments:
  -h, --help            show this help message and exit
  --build-by BUILD_BY   Builder identifier (e.g. jrandomhacker@example.net)
  --version VERSION     Version number (release builds only)
  --pbuilder-debian-mirror PBUILDER_DEBIAN_MIRROR
                        Debian repository mirror for pbuilder env bootstrap
  --debian-security-mirror DEBIAN_SECURITY_MIRROR
                        Debian security updated mirror
  --architecture ARCHITECTURE
                        Image target architecture (amd64 or i386 or armhf)
  --vyos-mirror VYOS_MIRROR
                        VyOS package mirror
  --build-type BUILD_TYPE
                        Build type, release or development
  --debian-mirror DEBIAN_MIRROR
                        Debian repository mirror for ISO build
  --debug               Enable debug output
  --custom-apt-entry CUSTOM_APT_ENTRY
                        Custom APT entry
  --custom-apt-key CUSTOM_APT_KEY
                        Custom APT key file
  --custom-package CUSTOM_PACKAGE
                        Custom package to install from repositories
```

Before you can build an image, you need to configure your build.

Each build needs to run the `./configure` step first where you can extend your
ISO by additional packages (`--custom-package`) or specify who build this nice
ISO image (`--build-by`). If you have local Debian mirrors, you can select them
by `--debian-mirror` or `--debian-security-mirror`.

```bash
$ ./configure --custom-package vim --build-by jrandom@hacker.com
$ sudo make iso
```

After some time you will find the resulting ISO image in the `build` folder.

### Building images for virtualization platforms

#### QEMU

Run following command after building the ISO image.

```bash
$ make qemu
```

#### VMware

Run following command after building the QEMU image.

```bash
$ make vmware
```

## Building subpackages inside Docker

VyOS requires a bunch of packages which are VyOS specific and thus can not be
found in any Debian Upstream mirrror. Those packages can be found at the VyOS
GitHub project (https://github.com/vyos) and there is a nice helper script
available to build and list those individual packages.

[scripts/build-packages](scripts/build-packages) provides an easy interface
to automate the process of building all VyOS related packages that are not part
of the upstream Debian version. Execute it in the root of the `vyos-build`
directory to start compilation.

```bash
$  scripts/build-packages -h
usage: build-packages [-h] [-v] [-c] [-l] [-b BUILD [BUILD ...]] [-f] [-p]

optional arguments:
  -h, --help            show this help message and exit
  -v, --verbose         Increase logging verbosity for each occurance
  -c, --clean           Re-clone required Git repositories
  -l, --list-packages   List all packages to build
  -b BUILD [BUILD ...], --build BUILD [BUILD ...]
                        Whitespace separated list of packages to build
  -f, --fetch           Fetch sources only, no build
  -p, --parallel        Build on all CPUs
```

Git repositoriers are automatically fetched and build on demand. If you wan't to
work offline you can fetch all source code first with the `-f` option.

The easiest way to compile is with the above mentioned [Docker](docker/Dockerfile)
container, it includes all dependencies for compiling supported packages.

```bash
$ docker run --rm -it -v $(pwd):/vyos -w /vyos \
             --sysctl net.ipv6.conf.lo.disable_ipv6=0 \
             vyos-builder scripts/build-packages
```

**NOTE:** `--sysctl net.ipv6.conf.lo.disable_ipv6=0` is required to build the
`vyos-strongswan` package

**NOTE:** Prior to executing this script you need to create or build the Docker
container and checkout all packages you want to compile.

### Building single package(s)

The script above runs all package build inside the Docker container, this is also
possible to do by hand using:

Executed from the root of `vyos-build`

```bash
$ docker run --rm -it -v $(pwd):/vyos -w /vyos/packages/PACKAGENAME \
             --sysctl net.ipv6.conf.lo.disable_ipv6=0 \
             vyos-builder scripts/build-packages -b <package>
```

**NOTE:** `--sysctl net.ipv6.conf.lo.disable_ipv6=0` is only needed when
building `vyos-strongswan` and can be ignored on other packages.

**NOTE:** `vyos-strongswan` will only compile on a Linux system, running on macOS
or Windows might result in a unittest deadlock (it never exits).

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

Post-1.2.0 branches are named after constellations sorted by from smallest to largest.
There are 88 of them, here's the [complete list](https://en.wikipedia.org/wiki/IAU_designated_constellations_by_area).

* 1.2.0: `crux` (Southern Cross)
* Future 1.3.0: `equuleus`
* ...
