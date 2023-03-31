#!/bin/bash
CWD=$(pwd)
set -e

SRC=host-sflow

if [ ! -d ${SRC} ]; then
    echo "source directory does not exists, please 'git clone'"
    exit 1
fi

cd ${SRC}

echo "I: Ensure Debian build dependencies are met"
sudo apt-get install -y libpcap0.8-dev

# Build hsflowd
# make deb FEATURES="NFLOG PCAP TCP DOCKER KVM OVS DBUS SYSTEMD DROPMON PSAMPLE DENT CONTAINERD"
echo "I: Build VyOS hsflowd Package"
make deb FEATURES="PCAP DROPMON DBUS"

# hsflowd builds ARM package as aarch64 extension, rename to arm64
for file in *.deb ; do mv $file ${file//aarch64/arm64} || true ; done

# Do not confuse *.deb upload logic by removing build in debian packages ...
# ugly but works
find src -name "*.deb" -type f -exec rm {} \;
