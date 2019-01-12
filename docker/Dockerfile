# Must be run with --privileged flag
# Recommended to run the container with a volume mapped
# in order to easy exprort images built to "external" world
FROM debian:jessie

RUN echo 'deb http://ftp.debian.org/debian jessie-backports main' | tee -a /etc/apt/sources.list &&\
    apt-get update && apt-get install -y \
      gosu \
      vim \
      git \
      make \
      sudo \
      locales \
      live-build \
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
      python3-coverage \
      python3-sphinx

# Packages needed for building vyos-strongswan
RUN apt-get update && apt-get install -y -t jessie-backports debhelper &&\
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

# Package needed for mdns-repeater
RUN apt-get update && apt-get install -y -t jessie-backports \
      dh-systemd

# Packages needed for vyatta-bash
RUN apt-get update && apt-get install -y \
      libncurses5-dev \
      locales

# Packages needed for vyatta-cfg
RUN apt-get update &&apt-get install -y \
      libboost-filesystem-dev

# Packages needed for vyatta-iproute
RUN apt-get update && apt-get install -y \
      libatm1-dev \
      libdb-dev

# Packages needed for vyatta-webgui
RUN apt-get update && apt-get install -y \
      libexpat1-dev \
      subversion

# Packages needed for pmacct
RUN apt-get update && apt-get install -y \
      libpcap-dev \
      libpq-dev \
      libmysqlclient-dev \
      libgeoip-dev \
      librabbitmq-dev \
      libjansson-dev \
      librdkafka-dev \
      libnetfilter-log-dev

# Packages needed for vyos-keepalived
RUN apt-get update && apt-get install -y \
      libnl-3-dev \
      libnl-genl-3-dev \
      libpopt-dev \
      libsnmp-dev

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

# Packages needed for frr
RUN apt-get update && apt-get install -y \
      libreadline-dev \
      texinfo \
      pkg-config \
      imagemagick \
      groff \
      hardening-wrapper \
      gawk \
      chrpath \
      libjson0 \
      libjson0-dev \
      python-ipaddr \
      python3-dev \
      python3-pip \
      libc-ares-dev \
      libc-ares2

# 3rd-party depndencies required for building FRR, see
# http://docs.frrouting.org/projects/dev-guide/en/latest/building-frr-for-debian8.html
RUN pip3 install pytest
RUN git clone https://github.com/opensourcerouting/libyang /tmp/libyang && \
    cd /tmp/libyang && \
    git checkout -b tmp origin/tmp && \
    mkdir build; cd build && \
    cmake -DENABLE_LYD_PRIV=ON .. && \
    make && make install

# Update live-build
RUN echo 'deb http://ftp.debian.org/debian stretch main' | tee -a /etc/apt/sources.list.d/stretch.list &&\
    apt-get update &&\
    apt-get install -y -t stretch live-build &&\
    rm -f /etc/apt/sources.list.d/stretch.list &&\
    apt-get update &&\
    rm -rf /var/lib/apt/lists/*

# Standard shell should be bash not dash
RUN echo "dash dash/sh boolean false" | debconf-set-selections && \
    DEBIAN_FRONTEND=noninteractive dpkg-reconfigure dash

RUN echo "en_US.UTF-8 UTF-8" > /etc/locale.gen && locale-gen
ENV LANG en_US.utf8

# Install packer
RUN export LATEST="$(curl -s https://checkpoint-api.hashicorp.com/v1/check/packer | \
    jq -r -M '.current_version')"; \
    echo "url https://releases.hashicorp.com/packer/"$LATEST"/packer_"$LATEST"_linux_amd64.zip" |\
    curl -K- | gzip -d > /usr/bin/packer && \
    chmod +x /usr/bin/packer

# Allow password-less 'sudo' for all users in group 'sudo'
RUN sed "s/^%sudo.*/%sudo\tALL=(ALL) NOPASSWD:ALL/g" -i /etc/sudoers && \
    chmod a+s /usr/sbin/useradd /usr/sbin/groupadd /usr/sbin/gosu /usr/sbin/usermod

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
