#!/bin/sh
CWD=$(pwd)
set -e

BUILD_ARCH=$(dpkg-architecture -qDEB_TARGET_ARCH)

SRC=telegraf
if [ ! -d ${SRC} ]; then
    echo "Source directory does not exists, please 'git clone'"
    exit 1
fi

PLUGIN_DIR=${CWD}/plugins

echo "I: Selecting Input plugins"
cp ${PLUGIN_DIR}/inputs/all/all.go ${SRC}/plugins/inputs/all/all.go

echo "I: Selecting Output plugins"
cp ${PLUGIN_DIR}/outputs/all/all.go ${SRC}/plugins/outputs/all/all.go

echo "I: Build Debian ${BUILD_ARCH} package"
cd ${SRC}
export PATH=/opt/go/bin:$PATH

# Generate default telegraf config
go run ./cmd/telegraf config > etc/telegraf.conf
LDFLAGS=-w make "${BUILD_ARCH}.deb"
