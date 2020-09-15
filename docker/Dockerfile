# Copyright (C) 2018 VyOS maintainers and contributors
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

RUN apt-get update && apt-get install -y \
      vim \
      vim-autopep8 \
      nano \
      git \
      curl \
      sudo \
      mc \
      build-essential \
      pbuilder \
      devscripts \
      squashfs-tools \
      genisoimage \
      lsb-release \
      fakechroot \
      libtool \
      libapt-pkg-dev \
      quilt \
      python3-lxml \
      python3-setuptools \
      python3-nose \
      python3-coverage \
      python3-sphinx \
      python3-pystache \
      python3-git \
      python3-pip \
      python3-psutil \
      python3-flake8 \
      python3-autopep8 \
      flake8 \
      pkg-config \
      debhelper \
      gosu \
      po4a \
      openssh-client \
      jq

# Syslinux and Grub2 is only supported on x86 and x64 systems
RUN if dpkg-architecture -ii386 || dpkg-architecture -iamd64; then \
      apt-get update && apt-get install -y \
        syslinux \
        grub2; \
    fi

# Package needed for mdns-repeater
RUN apt-get update && apt-get install -y \
      dh-systemd

#
# Building libvyosconf requires a full configured OPAM/OCaml setup
#
RUN apt-get update && apt-get install -y \
      libffi-dev \
      libpcre3-dev \
      unzip

# Update certificate store to not crash ocaml package installf
# Apply fix for https in curl running on armhf
RUN dpkg-reconfigure ca-certificates; \
    if dpkg-architecture -iarmhf; then \
      echo "cacert=/etc/ssl/certs/ca-certificates.crt" >> ~/.curlrc; \
    fi


# Installing OCAML needed to compile libvyosconfig
RUN curl https://raw.githubusercontent.com/ocaml/opam/master/shell/install.sh \
      --output /tmp/opam_install.sh --retry 10 --retry-delay 5 && \
    sed -i 's/read BINDIR/BINDIR=""/' /tmp/opam_install.sh && sh /tmp/opam_install.sh && \
    opam init --root=/opt/opam --comp=4.09.0 --disable-sandboxing

RUN eval $(opam env --root=/opt/opam --set-root) && opam install -y \
      pcre

RUN eval $(opam env --root=/opt/opam --set-root) && opam install -y \
      ctypes.0.16.0 \
      ctypes-foreign \
      ctypes-build

# Build VyConf which is required to build libvyosconfig
RUN eval $(opam env --root=/opt/opam --set-root) && \
    opam pin add vyos1x-config https://github.com/vyos/vyos1x-config.git#550048b3 -y

# Build libvyosconfig
RUN eval $(opam env --root=/opt/opam --set-root) && \
    git clone https://github.com/vyos/libvyosconfig.git /tmp/libvyosconfig && \
    cd /tmp/libvyosconfig && git checkout 5138b5eb && \
    dpkg-buildpackage -uc -us -tc -b && \
    dpkg -i /tmp/libvyosconfig0_*_$(dpkg-architecture -qDEB_HOST_ARCH).deb

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

# Packages needed for vyatta-iproute
RUN apt-get update && apt-get install -y \
      iptables-dev \
      libatm1-dev \
      libcap-dev \
      libdb-dev \
      libelf-dev \
      libselinux1-dev

# Packages needed for kernel
RUN apt-get update && apt-get install -y \
      rsync \
      libmnl-dev \
      libncurses5-dev \
      flex \
      bison \
      libelf-dev \
      bc \
      kmod \
      dkms \
      cdbs \
      cmake \
      liblua5.2-dev \
      liblua5.3-dev

# Packages needed for vyos-qat
RUN apt-get update && apt-get install -y \
     libboost-dev \
     libudev-dev

# Prerequisites for building rtrlib
# see http://docs.frrouting.org/projects/dev-guide/en/latest/building-frr-for-debian8.html
RUN apt-get update && apt-get install -y \
      graphviz \
      doxygen \
      libssh-dev \
      libssl-dev

# Build rtrlib release 0.6.3
RUN export RTRLIB_VERSION="0.6.3" && \
    wget -P /tmp https://github.com/rtrlib/rtrlib/archive/v${RTRLIB_VERSION}.tar.gz && \
    tar xf /tmp/v${RTRLIB_VERSION}.tar.gz -C /tmp && \
    cd /tmp/rtrlib-${RTRLIB_VERSION} && dpkg-buildpackage -uc -us -tc -b && \
    dpkg -i ../librtr*_$(dpkg-architecture -qDEB_HOST_ARCH).deb ../librtr*_all.deb

# Packages needed to build frr itself
# https://github.com/FRRouting/frr/blob/master/doc/developer/building-libyang.rst
# for more info
RUN apt-get update && apt-get install -y \
      libyang-dev \
      libyang0.16 \
      chrpath \
      install-info \
      libjson-c-dev \
      libpython3-dev \
      python3-dev \
      python3-pytest \
      texinfo

# Packages needed for hvinfo
RUN apt-get update && apt-get install -y \
      gnat \
      gprbuild

# Packages needed for vyos-1x
RUN apt-get update && apt-get install -y \
      quilt \
      fakeroot \
      whois \
      python3 \
      python3-setuptools \
      python3-xmltodict \
      python3-lxml \
      python3-nose \
      python3-coverage

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

# Packages needed for ddclient
RUN apt-get update && apt-get install -y \
      xmlto

# Packages needed for keepalived
RUN apt-get update && apt-get install -y \
      autoconf \
      debhelper \
      libglib2.0-dev \
      libjson-c-dev \
      libnl-3-dev \
      libnl-genl-3-dev \
      libpopt-dev \
      libsnmp-dev \
      libssl-dev \
      libnl-nf-3-dev \
      libnfnetlink-dev \
      libipset-dev \
      iptables-dev \
      linux-libc-dev \
      pkg-config

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

# Packages needed for vyos-configd
RUN apt-get update && apt-get install -y \
      libzmq3-dev

# Install packer
RUN if dpkg-architecture -ii386 || dpkg-architecture -iamd64; then \
      export LATEST="$(curl -s https://checkpoint-api.hashicorp.com/v1/check/packer | \
      jq -r -M '.current_version')"; \
      echo "url https://releases.hashicorp.com/packer/${LATEST}/packer_${LATEST}_linux_amd64.zip" |\
        curl -K- | gzip -d > /usr/bin/packer && \
      chmod +x /usr/bin/packer; \
    fi

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

# Packages needed for nftables
RUN apt-get update && apt-get install -y \
      asciidoc-base \
      libjansson-dev \
      python3-all

# Packages needed for libnetfilter-conntrack
RUN apt-get update && apt-get install -y \
      libmnl-dev \
      libnfnetlink-dev \
      libtool

# Packages needed for conntrack-tools
RUN apt-get update && apt-get install -y \
      bison \
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
