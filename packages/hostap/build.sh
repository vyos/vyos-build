#!/bin/bash
CWD=$(pwd)
set -e

SRC=hostap
SRC_DEB=wpa

if [ ! -d ${SRC} ]; then
    echo "${SRC} directory does not exists, please 'git clone'"
    exit 1
fi
if [ ! -d ${SRC_DEB} ]; then
    echo "${SRC_DEB} directory does not exists, please 'git clone'"
    exit 1
fi

echo "I: Copy Debian build instructions"
cp -a ${SRC_DEB}/debian ${SRC}
# Preserve Debian's default of allowing TLSv1.0 and legacy renegotiation for
# compatibility with networks that use legacy crypto
cat > ${SRC}/debian/patches/series << EOF
allow-tlsv1.patch
allow-legacy-renegotiation.patch
EOF

# Build Debian package
cd ${SRC}

echo "I: Ensure Debian build dependencies are met"
sudo mk-build-deps --install --tool "apt-get --yes --no-install-recommends" -Ppkg.wpa.nogui,noudeb

echo "I: Create new Debian Package version"
version="$(git describe --tags | tr _ .)"
dch -v ${version:7} "New version to support AES-GCM-256 for MACsec" -b

echo "I: Build Debian hostap Package"
DEB_CPPFLAGS_SET="-Wno-use-after-free -Wno-deprecated-declarations" \
    dpkg-buildpackage -us -uc -tc -b -Ppkg.wpa.nogui,noudeb
