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

FROM debian:jessie
LABEL authors="VyOS Maintainers <maintainers@vyos.io>"

ENV DEBIAN_FRONTEND noninteractive

COPY sources.list /etc/apt/sources.list
COPY no--check-valid-until /etc/apt/apt.conf.d/

# Standard shell should be bash not dash
RUN echo "dash dash/sh boolean false" | debconf-set-selections && \
    dpkg-reconfigure dash

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
      make \
      sudo \
      mc \
      pbuilder \
      devscripts \
      python3-pystache \
      squashfs-tools \
      autoconf \
      automake \
      dpkg-dev \
      syslinux \
      genisoimage \
      lsb-release \
      fakechroot \
      kernel-package \
      libtool \
      libglib2.0-dev \
      libboost-filesystem-dev \
      libapt-pkg-dev \
      libncurses5-dev \
      flex \
      bison \
      libperl-dev \
      libnfnetlink-dev \
      parted \
      kpartx \
      jq \
      qemu-system-x86 \
      qemu-utils \
      quilt \
      python3-lxml \
      python3-setuptools \
      python3-nose \
      python3-coverage \
      python3-sphinx \
      python3-pystache \
      dh-apparmor \
      gperf \
      libsystemd-dev \
      pkg-config \
      debhelper

RUN apt-get update && apt-get install -y -t jessie-backports \
      python3-git \
      python3-pip \
      gosu

# Package needed for mdns-repeater
RUN apt-get update && apt-get install -y -t jessie-backports \
      dh-systemd

# Packages needed for vyatta-cfg
RUN apt-get update &&apt-get install -y \
      libboost-filesystem-dev

# Packages needed for vyatta-iproute
RUN apt-get update && apt-get install -y \
      libatm1-dev \
      libdb-dev \
      iptables-dev

# Packages needed for vyatta-webgui
RUN apt-get update && apt-get install -y \
      libexpat1-dev \
      subversion

# Packages needed for pmacct
RUN apt-get update && apt-get install -y \
      libpcap-dev \
      libpq-dev \
      default-libmysqlclient-dev \
      libgeoip-dev \
      librabbitmq-dev \
      libjansson-dev \
      librdkafka-dev \
      libnetfilter-log-dev

# Pavkages needed for wireguard
RUN apt-get update && apt-get install -y \
      libmnl-dev

# Packages needed for kernel
RUN apt-get update && apt-get install -y \
      libelf-dev

# Packages needed for vyos-accel-ppp
RUN apt-get update && apt-get install -y \
      cdbs \
      cmake \
      liblua5.1-dev

# Prerequisites for building rtrlib
# see http://docs.frrouting.org/projects/dev-guide/en/latest/building-frr-for-debian8.html
RUN apt-get update && apt-get install -y \
      doxygen \
      libssh-dev \
      libssl-dev

RUN export RTRLIB_COMMIT="v0.6.3" && \
    git clone https://github.com/rtrlib/rtrlib.git && \
    cd rtrlib && git checkout $RTRLIB_COMMIT && \
    dpkg-buildpackage -uc -us -tc -b && dpkg -i ../*.deb

# Prerequisites for building FRR from source
# see http://docs.frrouting.org/projects/dev-guide/en/latest/building-frr-for-debian8.html
#
RUN apt-get update && apt-get install -y -t jessie-backports \
      swig \
      libcmocka-dev \
      libcmocka0

RUN export LIBYANG_COMMIT="179da47f2e8de" && \
    git clone https://github.com/opensourcerouting/libyang.git && \
    cd libyang && git checkout $LIBYANG_COMMIT && mkdir build && cd build && \
    cmake .. && make build-deb && \
    dpkg -i debs/*.deb

# Packages needed to build frr itself
RUN apt-get update && apt-get install -y \
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

# Packages needed for libvyosconfig && VyConf
RUN apt-get update && apt-get install -y \
      libffi-dev

# Packages needed for libvyosconfig
RUN curl https://raw.githubusercontent.com/ocaml/opam/2.0.2/shell/install.sh --output /tmp/opam_install.sh && \
    sed -i 's/read BINDIR/BINDIR=""/' /tmp/opam_install.sh && sh /tmp/opam_install.sh && \
    opam init --root=/opt/opam --comp=4.07.0 --disable-sandboxing

RUN eval $(opam env --root=/opt/opam --set-root) && \
    opam install -y \
      oasis

RUN eval $(opam env --root=/opt/opam --set-root) && opam install -y \
      fileutils \
      lwt \
      lwt_ppx \
      lwt_log \
      ocplib-endian \
      ounit \
      pcre \
      ppx_deriving_yojson \
      sha \
      toml \
      xml-light \
      batteries \
      ocaml-protoc \
      ctypes-foreign \
      menhir

RUN eval $(opam env --root=/opt/opam --set-root) && opam install -y \
      ctypes

# Build VyConf which is required to build libvyosconfig
RUN eval $(opam env --root=/opt/opam --set-root) && \
    opam pin add vyconf https://github.com/vyos/vyconf.git#51d79a3f -y

# Build libvyosconfig
RUN eval $(opam env --root=/opt/opam --set-root) && \
    git clone https://github.com/vyos/libvyosconfig.git && \
    cd libvyosconfig && git checkout 9a80a5d3 && \
    dpkg-buildpackage -uc -us -tc -b && \
    dpkg -i ../libvyosconfig0_*_amd64.deb

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
      check
# As there is no Debian Jessie/Stretch package for libcidr available but this
# is required for ipaddrcheck we have to build it from source
RUN git clone https://github.com/wikimedia/analytics-libcidr.git && \
    cd analytics-libcidr && \
    git checkout 026c611d90a1 && \
    dpkg-buildpackage -uc -us -tc -b && \
    dpkg -i ../libcidr*.deb

# Packages needed for lldpd
RUN apt-get update && apt-get install -y \
      libbsd-dev \
      libevent-dev

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
      libsqlite3-dev

# Packages needed for vyos-opennhrp
RUN apt-get update && apt-get install -y \
      libc-ares-dev

# Packages needed for ddclient
RUN apt-get update && apt-get install -y \
      xmlto

# Update live-build
RUN echo 'deb http://ftp.debian.org/debian stretch main' | tee -a /etc/apt/sources.list.d/stretch.list && \
    apt-get update && apt-get install -y -t stretch \
      live-build && \
    rm -f /etc/apt/sources.list.d/stretch.list && \
    apt-get update && \
    rm -rf /var/lib/apt/lists/*

# Update live-build
RUN echo 'deb http://ftp.debian.org/debian stretch main' | tee -a /etc/apt/sources.list.d/stretch.list && \
    apt-get update && apt-get install -y -t stretch live-build && \
    rm -f /etc/apt/sources.list.d/stretch.list && \
    apt-get update && \
    rm -rf /var/lib/apt/lists/*

# Install packer
RUN export LATEST="$(curl -s https://checkpoint-api.hashicorp.com/v1/check/packer | \
    jq -r -M '.current_version')"; \
    echo "url https://releases.hashicorp.com/packer/"$LATEST"/packer_"$LATEST"_linux_amd64.zip" |\
    curl -K- | gzip -d > /usr/bin/packer && \
    chmod +x /usr/bin/packer

# Allow password-less 'sudo' for all users in group 'sudo'
RUN sed "s/^%sudo.*/%sudo\tALL=(ALL) NOPASSWD:ALL/g" -i /etc/sudoers && \
    chmod a+s /usr/sbin/useradd /usr/sbin/groupadd /usr/sbin/gosu /usr/sbin/usermod

# Ensure sure all users have access to our OCAM installation
RUN echo "$(opam env --root=/opt/opam --set-root)" >> /etc/skel/.bashrc

# Cleanup
RUN rm -rf /tmp/*

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
