VyOS toplevel build
===================

# WARNING

This is repository is for the ongoing work on porting VyOS to Debian Jessie. It is not yet ready to use.
For building stable release images, refer to the vyos/build-iso repository.

# What is VyOS

VyOS is an open source operating system for network devices (routers, firewalls and so on).
If you want to use it in your network, check out download and installation instructions at http://vyos.net

If you want to modify VyOS and/or join its development, read on.

# What is this repository?

VyOS is a GNU/Linux distribution based on Debian. Just like any other distribution, it consists of multiple
packages.

Some packages are taken from the upstream, while other are modified or written from scratch by VyOS developers.
Every package maintained by the VyOS team has its own git repository. VyOS image build is therefore a multi-step
process. Packages are compiled first, then an ISO is built from Debian packages and our own packages.

This is the top level repository that contains links to repositories with VyOS-specific packages (organized
as git submodules) and scripts and data that are used for building those packages and the installation image.

# Structure of this repository

There are several directories with their own purpose:

    build/    Used for temporary files used for the build and for build artifacts
    scripts/  Contains scripts that are used for the build process
    data/     Contains data required for buildng the ISO (such as boot splash)
    tools/    Contains scripts that are used for maintainer's tasks automation
              and other purposes, but not in ISO build process

# Building VyOS installation images

## Prerequisites

To build a VyOS image, you need a machine that runs Debian Jessie. Other build hosts are not supported.

Several packages are required for building the ISO and all packages, namely live-build, pbuilder, and dev-scripts.
Individual packages may have other build dependencies. If some packages are missing, build scripts will tell you.

## Building the ISO image

Before you can build an image, you need to configure your build. 

To build an image, use the following commands:
    ./configure
    make iso

The ./configure script has a number of options that you can see by calling it with --help
