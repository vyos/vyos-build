VyOS toplevel build
===================

# Important!

This repository is for building the VyOS version 1.2.0 and above.
For VyOS 1.1.x, use the build-iso repository.


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
   data/     Data required for buildng the ISO (such as boot splash)
   tools/    Scripts that are used for maintainer's tasks automation and other
             purposes, but not during ISO build process

# Building VyOS installation images

## Prerequisites

To build a VyOS image, you need Debian 8 "Jessie" environment (with jessie-backports repository).
You can create it with [debootstrap](https://wiki.debian.org/Debootstrap) on Debian, Ubuntu and many
other distributions. To create a Debian 8 "Jessie" environment under vyos-chroot
directory, run these commands:

Note: This is on Debian/Ubuntu, adjust it for your favorite distro package manager!

```bash
$ sudo apt-get install debootstrap
$ sudo debootstrap jessie vyos-chroot
$ sudo chroot vyos-chroot

$ echo "deb http://deb.debian.org/debian jessie-backports main" >> /etc/apt/sources.list
$ apt-get update
```

Several packages are required for building the ISO:
* `python3`
* `live-build`
* `pbuilder`
* `python3-pystache`

The `./configure` script will warn you if any dependencies are missing. Individual
packages may have other build dependencies. If some dependencies are missing,
package build scripts will tell you.

## Building the ISO image inside a docker container

Using our `Dockerfile` you can create your own Docker container that can be used
to build a VyOS ISO image. The `Dockerfile` contains some of the most used
packages needed for a VyOS build ISO process.

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
```

To build the docker image:
```
docker build -t vyos-builder $PATH_TO_Dockerfile
```

To run the docker image:
```
docker run --privileged -v /HOST_PATH/images:/vyos --name=vyos_node_builder -d vyos-builder bash
```

NOTE:

* Docker container must be run with `--privileged` flag
* We recommended to run the container with a volume mapped in order to easy
  export built VyOS ISO images to the "external" world

To connect to the docker image once is running:
```
docker exec -it vyos_node_builder bash
```

After the docker container is running you can git clone the vyos-build repository
inside the container and follow up the bellow instructions in order to build the
VyOS ISO image

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
of sync with everything it was beyong any repair. Vyatta developers used to create
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

For branch naming we use chemical elements:
* hydrogen
* helium
* lithium
* ...
