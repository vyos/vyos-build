#!/bin/sh
CWD=$(pwd)
set -e

SRC=podman

if [ ! -d ${SRC} ]; then
    echo "${SRC} directory does not exists, please 'git clone'"
    exit 1
fi

# Setup Go
export PATH=/opt/go/bin:$PATH

# Build Debian package
cd ${SRC}
version="$(git describe --tags | tr _ .)"
echo "I: Build Debian $SRC Package"
make

install -m 0755 -d tmp/usr/bin
install -m 0755 -d tmp/lib/systemd/system
install -m 0755 bin/* tmp/usr/bin/
install -m 0644 contrib/systemd/system/* tmp/lib/systemd/system

rm -f *.deb
fpm --input-type dir --output-type deb --name podman \
    --maintainer "VyOS Package Maintainers <maintainers@vyos.net>" \
    --description "engine to run OCI-based containers in Pods" \
    --depends "libgpgme11,conmon (>= 2.0.18~), containernetworking-plugins (>= 0.8.7), golang-github-containers-common, crun, iptables" \
    --architecture $(dpkg-architecture -qDEB_HOST_ARCH) \
    --version $(git describe --tags | cut -c 2-) \
    --url "https://github.com/containers/podman" \
    --deb-compression gz -C tmp

mv *.deb ..
