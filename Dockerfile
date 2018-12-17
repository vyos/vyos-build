# Must be run with --privileged flag
# Recommended to run the container with a volume mapped
# in order to easy exprort images built to "external" world
FROM debian:jessie

RUN echo 'deb http://ftp.debian.org/debian jessie-backports main' | tee -a /etc/apt/sources.list &&\
    apt-get update &&\
    apt-get install -y \
      vim \
      git \
      make \
      live-build \
      pbuilder \
      devscripts \
      python3-pystache \
      squashfs-tools \
      autoconf \
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
      flex \
      bison \
      libperl-dev \
      libnfnetlink-dev \
      python3-git \
      parted \
      kpartx \
      jq \
      qemu-system-x86 \
      qemu-utils \
      quilt \
      python3-lxml \
      python3-setuptools \
      python3-nose \
      python3-coverage

# Packages needed for building vyos-strongswan
RUN apt-get install -y -t jessie-backports \
      debhelper &&\
    apt-get install -y \
      dh-apparmor \
      gperf \
      iptables-dev \
      libcap-dev \
      libgcrypt20-dev \
      libgmp3-dev \
      libldap2-dev \
      libpam0g-dev \
      libsystemd-dev \
      libgmp-dev \
      iptables \
      xl2tpd \
      libcurl4-openssl-dev \
      libcurl4-openssl-dev \
      libkrb5-dev \
      libsqlite3-dev \
      libssl-dev \
      libxml2-dev \
      pkg-config

# Update live-build
RUN echo 'deb http://ftp.debian.org/debian stretch main' | tee -a /etc/apt/sources.list.d/stretch.list &&\
    apt-get update &&\
    apt-get install -y -t stretch live-build &&\
    rm -f /etc/apt/sources.list.d/stretch.list &&\
    apt-get update &&\
    rm -rf /var/lib/apt/lists/*

#install packer
RUN export LATEST="$(curl -s https://checkpoint-api.hashicorp.com/v1/check/packer | \
  jq -r -M '.current_version')"; \
  echo "url https://releases.hashicorp.com/packer/"$LATEST"/packer_"$LATEST"_linux_amd64.zip" |\
  curl -K- | gzip -d > /usr/bin/packer
RUN chmod +x /usr/bin/packer

WORKDIR ~
