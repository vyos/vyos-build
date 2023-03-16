#!/bin/sh -x
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
make deb FEATURES="PCAP"
