VyOS toplevel build
===================

For the most up-to-date documentation, please read the online build guide at
[docs.vyos.io](https://docs.vyos.io/en/latest/contributing/build-vyos.html).

# What is VyOS

VyOS is an open source operating system for network devices (routers, firewalls
and so on). If you want to use it in your network, check out download and
installation instructions at https://docs.vyos.io/en/latest/installation/index.html

If you want to modify VyOS and/or join its development, read on.

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

 * `build/`    Used for temporary files used for the build and for build artifacts
 * `data/`     Data required for building the ISO (e.g. boot splash/configs)
 * `packages/` This directory can hold arbitrary *.deb
               packages which will be embeded into the resulting ISO.
               Among other things those packages will be: Linux Kernel, FRR,
               Netfiler...
 * `scripts/`  Scripts that are used for the build process
 * `tools/`    Scripts that are used for maintainer's tasks automation and other
               purposes, but not during ISO build process
 * `vars/`     Jenkins Pipeline library for reusable functions

# Building VyOS

In order to have a single manual and not maintining multiple copies the
instructions on how to build VyOS either in a Docker container or natively can
be found in our [Documentation - Build VyOS](https://docs.vyos.io/en/latest/contributing/build-vyos.html).

# Development Branches

The default branch that contains the most recent VyOS code is called `current`.
We may or may not eventually switch to `main`.

All new code goes to the `current` branch. When a new LTS release is ready for feature freeze, a
new branch is created for the release, and new code from `current` is backported
to the release branch as needed.

Post-1.2.0 branches are named after constellations sorted by area from smallest
to largest. There are 88 of them, here's the
[complete list](https://en.wikipedia.org/wiki/IAU_designated_constellations_by_area).

Existing branches:

* VyOS 1.4: `sagitta` (Arrow) [LTS]
* VyOS 1.3: `equuleus` (Little Horse) [LTS]
* VyOS 1.2: `crux` (Southern Cross) [Unsupported]

The next LTS release will be VyOS 1.5 `circinus` (Compasses).
