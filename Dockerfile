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
      python3-coverage \
    && rm -rf /var/lib/apt/lists/*

#install packer
RUN export LATEST="$(curl -s https://checkpoint-api.hashicorp.com/v1/check/packer | \
  jq -r -M '.current_version')"; \
  echo "url https://releases.hashicorp.com/packer/"$LATEST"/packer_"$LATEST"_linux_amd64.zip" |\
  curl -K- | gzip -d > /usr/bin/packer
RUN chmod +x /usr/bin/packer

WORKDIR ~
