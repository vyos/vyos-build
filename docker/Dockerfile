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

FROM debian:buster
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
      git \
      curl \
      sudo \
      mc \
      build-essential \
      pbuilder \
      devscripts \
      squashfs-tools \
      autoconf \
      automake \
      syslinux \
      genisoimage \
      lsb-release \
      fakechroot \
      libtool \
      libapt-pkg-dev \
      parted \
      kpartx \
      qemu-system-x86 \
      qemu-utils \
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
      pkg-config \
      debhelper \
      gosu \
      po4a \
      cpio \
      openssh-client \
      jq

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

RUN curl https://raw.githubusercontent.com/ocaml/opam/2.0.2/shell/install.sh \
      --output /tmp/opam_install.sh --retry 10 --retry-delay 5 && \
    sed -i 's/read BINDIR/BINDIR=""/' /tmp/opam_install.sh && sh /tmp/opam_install.sh && \
    opam init --root=/opt/opam --comp=4.08.0 --disable-sandboxing

RUN eval $(opam env --root=/opt/opam --set-root) && opam install -y \
      pcre

RUN eval $(opam env --root=/opt/opam --set-root) && opam install -y \
      ctypes \
      ctypes-foreign \
      ctypes-build

# Build VyConf which is required to build libvyosconfig
RUN eval $(opam env --root=/opt/opam --set-root) && \
    opam pin add vyos1x-config https://github.com/vyos/vyos1x-config.git#550048b3 -y

# Build libvyosconfig
RUN eval $(opam env --root=/opt/opam --set-root) && \
    git clone https://github.com/vyos/libvyosconfig.git && \
    cd libvyosconfig && git checkout 5138b5eb && \
    dpkg-buildpackage -uc -us -tc -b && \
    dpkg -i ../libvyosconfig0_*_amd64.deb

# Packages needed for vyatta-cfg
RUN apt-get update && apt-get install -y \
      libglib2.0-dev \
      libperl-dev \
      libboost-filesystem-dev

# Packages needed for vyatta-iproute
RUN apt-get update && apt-get install -y \
      iptables-dev \
      libatm1-dev \
      libcap-dev \
      libdb-dev \
      libelf-dev \
      libselinux1-dev

# Pavkages needed for wireguard
RUN apt-get update && apt-get install -y \
      libmnl-dev

# Packages needed for kernel
RUN apt-get update && apt-get install -y \
      libncurses5-dev \
      flex \
      bison \
      libelf-dev \
      bc \
      kmod \
      dkms

# Packages needed for Accel-ppp
RUN apt-get update && apt-get install -y \
      cdbs \
      cmake \
      liblua5.2-dev

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
    dpkg -i ../librtr*_amd64.deb ../librtr*_all.deb

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

# Packages needed for conntrack-tools
RUN apt-get update && apt-get install -y \
      libnetfilter-conntrack-dev \
      libnetfilter-cthelper0-dev \
      libnetfilter-cttimeout-dev \
      libnetfilter-queue-dev

# Packages needed for hvinfo
RUN apt-get update && apt-get install -y \
      gnat \
      gprbuild

# Packages needed for vyos-1x
RUN apt-get update && apt-get install -y \
      whois

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
      libkrb5-dev \
      libssl-dev \
      libxml2-dev \
      systemd \
      libcurl4-openssl-dev \
      libgcrypt20-dev \
      libgmp3-dev \
      libldap2-dev \
      libsqlite3-dev \
      dh-apparmor \
      gperf \
      libsystemd-dev \
      python3-stdeb \
      python-setuptools

# Packages needed for vyos-opennhrp
RUN apt-get update && apt-get install -y \
      libc-ares-dev

# Packages needed for ddclient
RUN apt-get update && apt-get install -y \
      xmlto

# Packages needed for keepalived
RUN apt-get update && apt-get install -y \
      libnl-3-200 \
      libnl-3-dev \
      libnl-nf-3-200 \
      libnl-nf-3-dev \
      libipset-dev \
      libnl-genl-3-200 \
      libnl-genl-3-dev \
      libpopt-dev

# Packages needed for Qemu test-suite
RUN apt-get update && apt-get install -y \
      python3-pexpect \
      qemu-kvm

# Install packer
RUN export LATEST="$(curl -s https://checkpoint-api.hashicorp.com/v1/check/packer | \
    jq -r -M '.current_version')"; \
    echo "url https://releases.hashicorp.com/packer/"$LATEST"/packer_"$LATEST"_linux_amd64.zip" |\
    curl -K- | gzip -d > /usr/bin/packer && \
    chmod +x /usr/bin/packer

#
# live-build: building with local packages fails due to missing keys
# https://bugs.debian.org/cgi-bin/bugreport.cgi?bug=941691
# https://salsa.debian.org/live-team/live-build/merge_requests/30
#
RUN wget https://salsa.debian.org/jestabro-guest/live-build/commit/63425b3e4f7ad3712ced4c9a3584ef9851c0355a.patch && \
    git clone https://salsa.debian.org/live-team/live-build.git && \
    cd live-build && \
    git checkout debian/1%20190311 && \
    patch -p1 < ../63425b3e4f7ad3712ced4c9a3584ef9851c0355a.patch && \
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
RUN wget https://salsa.debian.org/klausenbusk-guest/debootstrap/commit/a9a603b17cadbf52cb98cde0843dc9f23a08b0da.patch && \
    git clone https://salsa.debian.org/installer-team/debootstrap && \
    cd debootstrap && \
    git checkout 1.0.114 && \
    patch -p1 < ../a9a603b17cadbf52cb98cde0843dc9f23a08b0da.patch && \
    dch -n "Applying fix for docker image compile" && \
    dpkg-buildpackage -us -uc && \
    sudo dpkg -i ../debootstrap*.deb

# Allow password-less 'sudo' for all users in group 'sudo'
RUN sed "s/^%sudo.*/%sudo\tALL=(ALL) NOPASSWD:ALL/g" -i /etc/sudoers && \
    chmod a+s /usr/sbin/useradd /usr/sbin/groupadd /usr/sbin/gosu /usr/sbin/usermod

# Ensure sure all users have access to our OCAM installation
RUN echo "$(opam env --root=/opt/opam --set-root)" >> /etc/skel/.bashrc

# Cleanup
RUN rm -rf /tmp/*

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
