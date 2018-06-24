VyOS toplevel build
===================

This repository is for building the VyOS version 1.2.0 and above.
For VyOS 1.1.x, use the build-iso repository.

# Table Of Contents
- [About](#what-is-vyos)
- [Build VyOS](#building-vyos-installation-images)
- [Development Process](#development-process)

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

To build a VyOS image, you need Debian 8 "Jessie" environment (with
jessie-backports repository). You can create it with
[debootstrap](https://wiki.debian.org/Debootstrap) on Debian, Ubuntu and many
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

## General

Please identify yourself when you submit patches or Pull Requests via GitHub by
configuring your Git client:

```bash
$ git config --global user.name "Random J. Hacker"
$ git config --global user.email jrandomhacker@example.net
```

If you do not wan't to change your global Git configuration you can omit `--global`
from the command above and run it in your VyOS repository filder instead.

```bash
$ cd vyos-build
$ git config user.name "Random J. Hacker"
$ git config user.email jrandomhacker@example.net
```

To verify your current configuration you can always run `$ git config --list`.

## Rules
To have clean and easy to maintain repositories for VyOS we should agree on
some basic rules when working with the repositories. A clean repository eases
the automatic generation of e.g. changelog files.

A good approach for writing commit messages is actually to have a look at the
file(s) history by invoking `git log path/to/file.txt`. Please note that this
guideline has been created after the repository lived for several years, thus
not every commit is a nice example.

Please ensure that for changes on the VyOS codebase there is an appropriate
[Phabricator task](https://phabricator.vyos.net/).

### Commit Message

#### Auto-Generated from Git client
Automatic generated headlines (e.g. generated by `git revert <sha1>` or
`git merge <remote>/<branch>`) are not subject to our rules! This can result in
commit messages like:

* `Revert "T703: add 'nmap' to utils package list"`
* `Merge pull request #15 from mtudosoiu/current`

#### Generic Rules
In general, use an editor to create your commit messages rather than passing
them on the command line. The format should be and is inspired by [this blog
post](http://tbaggery.com/2008/04/19/a-note-about-git-commit-messages.html).
These rules should apply not only to the vyos-build repository but all submodules
used by this super project or repositories under the VyOS GitHub project.

* A single, short, summary of the commit (recommended 50 characters or less,
max. 72) - the headline
  * Prefix the changed component, e.g. `Txyz:` for a task ID and a component e.g.
  `NAT:` or `SNMP:`
  * There should be no dot (`.`) at the headlines end

* Followed by a blank line

* Followed by a message describing the details
  * Document what/why/how something has been changed, this makes life easier
  during `git bisect`
  * Remaining text should be wrapped at 72 characters
    * Makes reading commit logs easier on the command line with `git log`
  * Where applicable a reference to a previous commit **must** be made
    * After commit 17de291859 `("T561: split vyos and debian repos.")` a
	regression was discovered at bar, baz

* If your commit is to be cherry-picked from a public available branch, mark
where it has been picked from!
  * Always use the `git cherry-pick -x` or manually add this line:
  `(cherry picked from commit <ID>)`

* Every change set must be consistent (self containing)
  * Do not commit independent changes in one change set, use
  `git add --patch` instead!

* A single blank line on the end

##### Examples
Commit https://github.com/vyos/vyos-build/commit/3af1486d48
`("T596: replace + in new version format by -")`

```
T596: replace + in new version format by -

The new version scheme was introduced in commit d2e4f63 ("T596: use a more
descriptive dev build version format.". It superseeded the old
999.something version numbers.

New version numbers for rolling releases are in the form of
vyos-1.2.0-rolling+201806062125-amd64.iso but the '+' sign will be
replaced by '%2B' when e.g. downloading the file via http(s), this may be
confusing.
```

Commit https://github.com/vyos/vyos-build/commit/7cffba7a60
`("T697: add openssh-client to the utils package list")`

```
T697: add openssh-client to the utils package list

VyOS scripts do not use it, but people certainlt do.
```


## Naming Conventions

### Git Tags
Tag naming convention is `VYOS_<arch>_<MAJOR>.<MINOR>.<BUGFIX>(-RC)`.

#### Examples
* `VYOS_X86-64_1.2.0-rc1`
* `VYOS_X86-64_1.2.0-rc2`
* `VYOS_X86-64_1.2.0`
* `VYOS_ARM_1.2.0-rc1`

## Git Branches
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

For release branch naming we use chemical elements:

* `hydrogen`
* `helium`
* `lithium`

Other branches for e.g. feature development/refactoring should be named
something like:
* `dev/feature/frr`
* `dev/feature/my-cool-feature`
* `dev/refactoring/build`

Branches on user forks can have any name consisting out of the following
characters: lower case letters, numbers, hyphen, dot. This is to address an
issue that came up during a system migration. Examples for user forks
should only be seen as a hint!

## Changelog

New VyOS versions should always have a ChangeLog file. By using the above rules
this process can be automated using the follwoing Git alias:

```
[alias]
    changelog = "!f() { r=${1:-`git describe --tags --abbrev=0`..HEAD}; echo "Changelog for $(basename $(pwd)) $r"; git log --reverse --no-merges --format='  * %s' $r; }; f"
```

Which would produce something like this when generating the ChangeLog file about
what happened between commit https://github.com/vyos/vyos-build/commit/82d7ddb
and HEAD.

```bash
Changelog for vyos-build 82d7ddb...HEAD
  * Master branch README.
  * Use os.makedirs instead of distutils stuff, make the configure script more verbose, pretty print build-config.json
  * Typo fixes and improvements for the readme
  * T697: move lsof and iftop to the utils package list.
  * T697: add openssh-client to the utils package list. VyOS scripts do not use it, but people certainlt do.
  * T703: add 'nmap' to utils package list
  * Revert "Master branch README."
  * Break overly long lines.
  * README.md: use live-build instead of live-helper
  * README.md: make it look more fancy
  * README.md: place QEMU and VMWare in dedicated chapter
  * README.md: add general Git commit rules
  * README.md: add TOC for better navigation
```
