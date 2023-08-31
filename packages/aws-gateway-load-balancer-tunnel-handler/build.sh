#!/bin/bash
CWD=$(pwd)
set -e

SRC=aws-gateway-load-balancer-tunnel-handler

if [ ! -d ${SRC} ]; then
    echo "${SRC} directory does not exists, please 'git clone'"
    exit 1
fi

# Navigate to the repository directory
cd ${SRC}

# Build the binary
cmake .
make

# Create the Debian package directory structure
mkdir -p aws-gwlbtun/DEBIAN
mkdir -p aws-gwlbtun/usr/bin

# Move the binary to the package directory
cp gwlbtun aws-gwlbtun/usr/bin

# Create the control file
cat <<EOL > aws-gwlbtun/DEBIAN/control
Package: aws-gwlbtun
Version: 1-eb51d33
Architecture: amd64
Maintainer: VyOS Maintainers autobuild@vyos.net
Description: AWS Gateway Load Balancer Tunnel Handler
EOL

# Build the Debian package
dpkg-deb --build aws-gwlbtun

cp *.deb ${CWD}
