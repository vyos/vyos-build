#!/bin/sh
CWD=$(pwd)
set -e

BUILD_ARCH=$(dpkg-architecture -qDEB_TARGET_ARCH)

SRC="blackbox_exporter"
if [ ! -d ${SRC} ]; then
    echo "Source directory does not exist, please 'git clone'"
    exit 1
fi

cd $SRC

mkdir -p debian

echo "I: Create $SRC/debian/control"
cat <<EOF > debian/control
Source: blackbox-exporter
Section: net
Priority: optional
Maintainer: VyOS Package Maintainers <maintainers@vyos.net>
Build-Depends: debhelper-compat (= 13)
Standards-Version: 4.5.1
Homepage: https://github.com/prometheus/blackbox_exporter

Package: blackbox-exporter
Architecture: ${BUILD_ARCH}
Depends: \${shlibs:Depends}, \${misc:Depends}
Description: The blackbox exporter allows blackbox probing of endpoints over HTTP, HTTPS, DNS, TCP, ICMP and gRPC.
EOF

echo "I: Create $SRC/debian/changelog"
cat <<EOF > debian/changelog
blackbox-exporter (0.25.0) UNRELEASED; urgency=medium

  * Upstream package

 -- VyOS Maintainers <maintainers@vyos.io>  Thu, 26 Sep 2024 12:35:47 +0000
EOF

echo "I: Create $SRC/debian/rules"
cat <<EOF > debian/rules
#!/usr/bin/make -f

clean:
	@# Do nothing

build:
	@# Do nothing

binary:
	mkdir -p debian/blackbox-exporter
	mkdir -p debian/blackbox-exporter/usr/sbin
	mkdir -p debian/blackbox-exporter/run/blackbox_exporter
	cp blackbox_exporter debian/blackbox-exporter/usr/sbin/blackbox_exporter
	dh_gencontrol
	dh_builddeb
EOF
chmod +x debian/rules

echo "I: Build blackbox_exporter"
go build

echo "I: Build Debian Package"
dpkg-buildpackage -uc -us -tc -b -d
