# Copyright (C) 2018-2021 VyOS maintainers and contributors
#
# This program is free software; you can redistribute it and/or modify
# in order to easy exprort images built to "external" world
# it under the terms of the GNU General Public License version 2 or later as
# published by the Free Software Foundation.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program.  If not, see <http://www.gnu.org/licenses/>.

# Must be run with --privileged flag, recommended to run the container with a
# volume mapped in order to easy export images

# This Dockerfile is installable on both x86, x86-64, armhf and arm64 systems
ARG ARCH=
FROM ${ARCH}debian:buster

# It is also possible to emulate an arm system inside docker,
# execution of this emulated system needs to be executed on an x86 or x86-64 host.

# To install using a non-native cpu instructionset use the `--build-arg ARCH=<ARCH>/`
# Supported architectures:
#     arm32v6/
#     arm32v7/
#     arm64v8/
# Example bo byukd natively:
#     docker build -t vyos-build:current .
# Example to build on armhf:
#     docker build -t vyos-build:current-armhf --build-arg ARCH=arm32v7/ .
# Example to build on arm64:
#     docker build -t vyos-build:current-arm64 --build-arg ARCH=arm64v8/ .

# On some versions of docker the emulation framework is not installed by default and
# you need to install qemu, qemu-user-static and register qemu inside docker manually using:
# `docker run --rm --privileged multiarch/qemu-user-static:register --reset`


LABEL authors="VyOS Maintainers <maintainers@vyos.io>"

ENV DEBIAN_FRONTEND noninteractive

# Standard shell should be bash not dash
RUN echo "dash dash/sh boolean false" | debconf-set-selections && \
    dpkg-reconfigure dash

RUN echo -e 'APT::Install-Recommends "0";\nAPT::Install-Suggests "0";' > /etc/apt/apt.conf.d/01norecommends

RUN apt-get update && apt-get install -y \
      dialog \
      apt-utils \
      locales

RUN echo "en_US.UTF-8 UTF-8" > /etc/locale.gen && locale-gen
ENV LANG en_US.utf8

ENV OCAML_VERSION 4.12.0

RUN apt-get update && apt-get install -y \
      vim \
      vim-autopep8 \
      nano \
      git \
      curl \
      sudo \
      mc \
      pbuilder \
      devscripts \
      lsb-release \
      libtool \
      libapt-pkg-dev \
      flake8 \
      pkg-config \
      debhelper \
      gosu \
      po4a \
      openssh-client \
      jq

# Packages needed for vyos-build
RUN apt-get update && apt-get install -y \
      build-essential \
      python3-pystache \
      squashfs-tools \
      genisoimage \
      fakechroot \
      python3-git \
      python3-pip \
      python3-flake8 \
      python3-autopep8

# Syslinux and Grub2 is only supported on x86 and x64 systems
RUN if dpkg-architecture -ii386 || dpkg-architecture -iamd64; then \
      apt-get update && apt-get install -y \
        syslinux \
        grub2; \
    fi

#
# Building libvyosconf requires a full configured OPAM/OCaml setup
#
RUN apt-get update && apt-get install -y \
      debhelper \
      libffi-dev \
      libpcre3-dev \
      unzip

# Update certificate store to not crash ocaml package install
# Apply fix for https in curl running on armhf
RUN dpkg-reconfigure ca-certificates; \
    if dpkg-architecture -iarmhf; then \
      echo "cacert=/etc/ssl/certs/ca-certificates.crt" >> ~/.curlrc; \
    fi


# Installing OCAML needed to compile libvyosconfig
RUN curl https://raw.githubusercontent.com/ocaml/opam/master/shell/install.sh \
      --output /tmp/opam_install.sh --retry 10 --retry-delay 5 && \
    sed -i 's/read BINDIR/BINDIR=""/' /tmp/opam_install.sh && sh /tmp/opam_install.sh && \
    opam init --root=/opt/opam --comp=${OCAML_VERSION} --disable-sandboxing --no-setup

RUN eval $(opam env --root=/opt/opam --set-root) && opam install -y \
      pcre re

RUN eval $(opam env --root=/opt/opam --set-root) && opam install -y \
      num \
      ctypes.0.16.0 \
      ctypes-foreign \
      ctypes-build \
      containers

# Build VyConf which is required to build libvyosconfig
RUN eval $(opam env --root=/opt/opam --set-root) && \
    opam pin add vyos1x-config https://github.com/vyos/vyos1x-config.git#550048b3 -y

# Packages needed for libvyosconfig
RUN apt-get update && apt-get install -y \
      quilt \
      libpcre3-dev \
      libffi-dev

# Build libvyosconfig
RUN eval $(opam env --root=/opt/opam --set-root) && \
    git clone https://github.com/vyos/libvyosconfig.git /tmp/libvyosconfig && \
    cd /tmp/libvyosconfig && git checkout 5138b5eb && \
    dpkg-buildpackage -uc -us -tc -b && \
    dpkg -i /tmp/libvyosconfig0_*_$(dpkg-architecture -qDEB_HOST_ARCH).deb

# Install open-vmdk
RUN wget -O /tmp/open-vmdk-master.zip https://github.com/vmware/open-vmdk/archive/master.zip && \
    unzip -d /tmp/ /tmp/open-vmdk-master.zip && \
    cd /tmp/open-vmdk-master/ && \
    make && \
    make install

#
# live-build: building with local packages fails due to missing keys
# https://bugs.debian.org/cgi-bin/bugreport.cgi?bug=941691
# https://salsa.debian.org/live-team/live-build/merge_requests/30
#
RUN wget https://salsa.debian.org/jestabro-guest/live-build/commit/63425b3e4f7ad3712ced4c9a3584ef9851c0355a.patch \
      -O /tmp/63425b3e4f7ad3712ced4c9a3584ef9851c0355a.patch && \
    git clone https://salsa.debian.org/live-team/live-build.git /tmp/live-build && \
    cd /tmp/live-build && git checkout debian/1%20190311 && \
    patch -p1 < /tmp/63425b3e4f7ad3712ced4c9a3584ef9851c0355a.patch && \
    dch -n "Applying fix for missing archive keys" && \
    dpkg-buildpackage -us -uc && \
    sudo dpkg -i ../live-build*.deb

#
# live-build: building in docker fails with mounting /proc | /sys
#
# https://bugs.debian.org/cgi-bin/bugreport.cgi?bug=919659
# https://bugs.debian.org/cgi-bin/bugreport.cgi?bug=921815
# https://salsa.debian.org/installer-team/debootstrap/merge_requests/26
#
RUN wget https://salsa.debian.org/klausenbusk-guest/debootstrap/commit/a9a603b17cadbf52cb98cde0843dc9f23a08b0da.patch \
      -O /tmp/a9a603b17cadbf52cb98cde0843dc9f23a08b0da.patch && \
    git clone https://salsa.debian.org/installer-team/debootstrap /tmp/debootstrap && \
    cd /tmp/debootstrap && git checkout 1.0.114 && \
    patch -p1 < /tmp/a9a603b17cadbf52cb98cde0843dc9f23a08b0da.patch && \
    dch -n "Applying fix for docker image compile" && \
    dpkg-buildpackage -us -uc && \
    sudo dpkg -i ../debootstrap*.deb

#
# Install Packer
#
RUN if dpkg-architecture -ii386 || dpkg-architecture -iamd64; then \
      export LATEST="$(curl -s https://checkpoint-api.hashicorp.com/v1/check/packer | \
      jq -r -M '.current_version')"; \
      echo "url https://releases.hashicorp.com/packer/${LATEST}/packer_${LATEST}_linux_amd64.zip" |\
        curl -K- | gzip -d > /usr/bin/packer && \
      chmod +x /usr/bin/packer; \
    fi

# Packages needed for vyatta-cfg
RUN apt-get update && apt-get install -y \
      autotools-dev \
      libglib2.0-dev \
      libboost-filesystem-dev \
      libapt-pkg-dev \
      libtool \
      flex \
      bison \
      libperl-dev \
      autoconf \
      automake \
      pkg-config \
      cpio

# Packages needed for vyatta-cfg-firewall
RUN apt-get update && apt-get install -y \
      autotools-dev \
      autoconf \
      automake \
      cpio

# Packages needed for Linux Kernel
# gnupg2 is required by Jenkins for the TAR verification
RUN apt-get update && apt-get install -y \
      gnupg2 \
      rsync \
      libncurses5-dev \
      flex \
      bison \
      bc \
      kmod \
      cpio

# Packages needed for Accel-PPP
RUN apt-get update && apt-get install -y \
      liblua5.3-dev \
      libssl1.1 \
      libssl-dev \
      libpcre3-dev

# Packages needed for Wireguard
RUN apt-get update && apt-get install -y \
      debhelper-compat \
      dkms \
      pkg-config \
      systemd

# Packages needed for iproute2
RUN apt-get update && apt-get install -y \
      bison \
      debhelper \
      flex \
      iptables-dev \
      libatm1-dev \
      libcap-dev \
      libdb-dev \
      libbsd-dev \
      libelf-dev \
      libmnl-dev \
      libselinux1-dev \
      linux-libc-dev \
      pkg-config \
      po-debconf \
      zlib1g-dev

# Prerequisites for building rtrlib
# see http://docs.frrouting.org/projects/dev-guide/en/latest/building-frr-for-debian8.html
RUN apt-get update && apt-get install -y \
      cmake \
      dpkg-dev \
      debhelper \
      libssh-dev \
      doxygen

# Build rtrlib release 0.6.3
RUN export RTRLIB_VERSION="0.6.3" && export ARCH=$(dpkg-architecture -qDEB_HOST_ARCH) && \
    wget -P /tmp https://github.com/rtrlib/rtrlib/archive/v${RTRLIB_VERSION}.tar.gz && \
    tar xf /tmp/v${RTRLIB_VERSION}.tar.gz -C /tmp && \
    cd /tmp/rtrlib-${RTRLIB_VERSION} && dpkg-buildpackage -uc -us -tc -b && \
    dpkg -i ../librtr0*_${ARCH}.deb ../librtr-dev*_${ARCH}.deb ../rtr-tools*_${ARCH}.deb

# Upgrading to FRR 7.5 requires a more recent version of libyang which is only
# available from Debian Bullseye
RUN echo "deb http://deb.debian.org/debian/ bullseye main" \
      > /etc/apt/sources.list.d/bullseye.list && \
    apt-get update && apt-get install -y -t bullseye \
      libyang-dev \
      libyang1; \
    rm -f /etc/apt/sources.list.d/bullseye.list

# Packages needed to build FRR itself
# https://github.com/FRRouting/frr/blob/master/doc/developer/building-libyang.rst
# for more info
RUN apt-get update && apt-get install -y \
      bison \
      chrpath \
      debhelper \
      flex \
      gawk \
      install-info \
      libc-ares-dev \
      libcap-dev \
      libjson-c-dev \
      libpam0g-dev \
      libpcre3-dev \
      libpython3-dev \
      libreadline-dev \
      librtr-dev \
      libsnmp-dev \
      libssh-dev \
      libsystemd-dev \
      libyang-dev \
      lsb-base \
      pkg-config \
      python3 \
      python3-dev \
      python3-pytest \
      python3-sphinx \
      texinfo

# Packages needed for hvinfo
RUN apt-get update && apt-get install -y \
      gnat \
      gprbuild

# Packages needed for vyos-1x
RUN apt-get update && apt-get install -y \
      fakeroot \
      libzmq3-dev \
      python3 \
      python3-setuptools \
      python3-sphinx \
      python3-xmltodict \
      python3-lxml \
      python3-nose \
      python3-netifaces \
      python3-jinja2 \
      python3-psutil \
      python3-coverage \
      quilt \
      whois

# Packages needed for vyos-1x-xdp package, gcc-multilib is not available on
# arm64 but required by XDP
RUN if dpkg-architecture -ii386 || dpkg-architecture -iamd64; then \
      apt-get update && apt-get install -y \
        gcc-multilib \
        clang \
        llvm \
        libelf-dev \
        libpcap-dev \
        build-essential; \
      git clone https://github.com/libbpf/libbpf.git /tmp/libbpf && \
        cd /tmp/libbpf && git checkout b91f53ec5f1aba2 && cd src && make install; \
    fi

# Packages needed for vyos-xe-guest-utilities
RUN apt-get update && apt-get install -y \
      golang

# Packages needed for ipaddrcheck
RUN apt-get update && apt-get install -y \
      libcidr0 \
      libcidr-dev \
      check

# Packages needed for vyatta-quagga
RUN apt-get update && apt-get install -y \
      libpam-dev \
      libcap-dev \
      libsnmp-dev \
      gawk

# Packages needed for vyos-strongswan
RUN apt-get update && apt-get install -y \
      bison \
      bzip2 \
      debhelper \
      dh-apparmor \
      dpkg-dev \
      flex \
      gperf \
      iptables-dev \
      libcap-dev \
      libcurl4-openssl-dev \
      libgcrypt20-dev \
      libgmp3-dev \
      libkrb5-dev \
      libldap2-dev \
      libnm-dev \
      libpam0g-dev \
      libsqlite3-dev \
      libssl-dev \
      libsystemd-dev \
      libtool \
      libxml2-dev \
      pkg-config \
      po-debconf \
      systemd \
      tzdata \
      python-setuptools \
      python3-stdeb

# Packages needed for vyos-opennhrp
RUN apt-get update && apt-get install -y \
      libc-ares-dev

# Packages needed for Qemu test-suite
# This is for now only supported on i386 and amd64 platforms
RUN if dpkg-architecture -ii386 || dpkg-architecture -iamd64; then \
      apt-get update && apt-get install -y \
        python3-pexpect \
        qemu-system-x86 \
        qemu-utils \
        qemu-kvm; \
    fi

# Packages needed for building vmware and GCE images
# This is only supported on i386 and amd64 platforms
RUN if dpkg-architecture -ii386 || dpkg-architecture -iamd64; then \
     apt-get update && apt-get install -y \
      kpartx \
      parted \
      udev \
      grub-pc \
      grub2-common; \
    fi

# Packages needed for vyos-cloud-init
RUN apt-get update && apt-get install -y \
      pep8 \
      pyflakes \
      python3-configobj \
      python3-httpretty \
      python3-jsonpatch \
      python3-mock \
      python3-oauthlib \
      python3-pep8 \
      python3-pyflakes \
      python3-serial \
      python3-unittest2 \
      python3-yaml \
      python3-jsonschema \
      python3-contextlib2 \
      python3-pytest-cov \
      cloud-utils

# Packages needed for libnss-mapuser & libpam-radius
RUN apt-get update && apt-get install -y \
      libaudit-dev

# Install utillities for building grub and u-boot images
RUN if dpkg-architecture -iarm64; then \
    apt-get update && apt-get install -y \
      dosfstools \
      u-boot-tools \
      grub-efi-$(dpkg-architecture -qDEB_HOST_ARCH); \
    elif dpkg-architecture -iarmhf; then \
    apt-get update && apt-get install -y \
      dosfstools \
      u-boot-tools \
      grub-efi-arm; \
    fi

# Packages needed for libnftnl
RUN apt-get update && apt-get install -y \
      debhelper-compat \
      libmnl-dev \
      libtool \
      pkg-config

# Packages needed for nftables
RUN apt-get update && apt-get install -y \
      asciidoc-base \
      automake \
      bison \
      debhelper-compat \
      dh-python \
      docbook-xsl \
      flex \
      libgmp-dev \
      libjansson-dev \
      libmnl-dev \
      libreadline-dev \
      libtool \
      libxtables-dev \
      python3-all \
      python3-setuptools \
      xsltproc

# Packages needed for libnetfilter-conntrack
RUN apt-get update && apt-get install -y \
      debhelper-compat \
      libmnl-dev \
      libnfnetlink-dev \
      libtool

# Packages needed for conntrack-tools
RUN apt-get update && apt-get install -y \
      bison \
      debhelper \
      flex \
      libmnl-dev \
      libnetfilter-cthelper0-dev \
      libnetfilter-cttimeout-dev \
      libnetfilter-queue-dev \
      libnfnetlink-dev \
      libsystemd-dev \
      autoconf \
      automake \
      libtool

# Packages needed for wide-dhcpv6
RUN apt-get update && apt-get install -y \
      bison \
      debhelper \
      flex \
      libfl-dev \
      rsync

# Packages needed for vyos-http-api-tools
RUN apt-get update && apt-get install -y \
      dh-virtualenv \
      python3-venv

#
# fpm: a command-line program designed to help you build packages (e.g. deb)
#
RUN apt-get update && apt-get install -y \
      ruby \
      ruby-dev \
      rubygems \
      build-essential
RUN gem install --no-document fpm

# Allow password-less 'sudo' for all users in group 'sudo'
RUN sed "s/^%sudo.*/%sudo\tALL=(ALL) NOPASSWD:ALL/g" -i /etc/sudoers && \
    chmod a+s /usr/sbin/useradd /usr/sbin/groupadd /usr/sbin/gosu /usr/sbin/usermod

# Ensure sure all users have access to our OCAM installation
RUN echo "$(opam env --root=/opt/opam --set-root)" >> /etc/skel/.bashrc

# Cleanup
RUN rm -rf /tmp/*

# Disable mouse in vim
RUN echo -e "set mouse=\nset ttymouse=" > /etc/vim/vimrc.local

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
