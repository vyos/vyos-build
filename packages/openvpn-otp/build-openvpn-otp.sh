#!/bin/sh
CWD=$(pwd)
set -e

SRC=openvpn-otp

if [ ! -d ${SRC} ]; then
    echo "source directory does not exists, please 'git clone'"
    exit 1
fi

# Build instructions as per https://github.com/evgeny-gridasov/openvpn-otp/blob/master/README.md
cd ${SRC}
apt-get -y install debhelper libssl-dev openvpn
./autogen.sh
./configure --prefix=/usr
make

# install
mkdir -p usr/lib/openvpn
cp src/.libs/openvpn-otp.so usr/lib/openvpn

fpm --input-type dir --output-type deb --name openvpn-otp \
    --maintainer "VyOS Package Maintainers <maintainers@vyos.net>" \
    --description "OpenVPN OTP Authentication support." \
    --depends openvpn --architecture $(dpkg --print-architecture) \
    --version $(git describe --always) --deb-compression gz usr

cp *.deb ${CWD}

# do not confuse Jenkins by providing multiple openvpn-otp deb files
cd ${CWD}
rm -rf ${SRC}
