#!/bin/sh
set -e
CWD=$(pwd)
SRC=openvpn-otp

if [ ! -d ${SRC} ]; then
    echo "source directory does not exists, please 'git clone'"
    exit 1
fi

for pkt in debhelper libssl-dev openvpn
do
    dpkg -s $pkt 2>&1 >/dev/null
    if [ $? -ne 0 ]; then
        echo "Package $pkt not installed - required"
        exit 1
    fi
done

# Build instructions as per https://github.com/evgeny-gridasov/openvpn-otp/blob/master/README.md
cd ${SRC}
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
    --version $(git describe --tags --always | cut -c2-) --deb-compression gz usr

cp *.deb ${CWD}
