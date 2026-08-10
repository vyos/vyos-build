#!/bin/sh
set -e
CWD=$(pwd)
KERNEL_VAR_FILE=${CWD}/kernel-vars
. ${CWD}/common.sh

SRC=${CWD}/nat-rtsp
if [ ! -d ${SRC} ]; then
    echo "nat-rtsp source not found"
    exit 1
fi

if [ ! -f ${KERNEL_VAR_FILE} ]; then
    echo "Kernel variable file '${KERNEL_VAR_FILE}' does not exist, run ./build_kernel.sh first"
    exit 1
fi

. ${KERNEL_VAR_FILE}

cd ${SRC}
git reset --hard HEAD
git clean --force -d -x

PACKAGE_NAME=nat-rtsp
PACKAGE_VERSION=$(debian_version "$(git describe --tags --always)")

debmake -n -y -p ${PACKAGE_NAME} -u ${PACKAGE_VERSION} \
    -e maintainers@vyos.net -f "VyOS Package Maintainers"

echo "misc:Depends=linux-image-${KERNEL_VERSION}${KERNEL_SUFFIX}" > debian/${PACKAGE_NAME}.substvars

cat << EOF > debian/control
Source: ${PACKAGE_NAME}
Section: kernel
Priority: optional
Maintainer: VyOS Package Maintainers <maintainers@vyos.net>
Build-Depends: debhelper-compat (= 13)
Standards-Version: 4.5.1
Rules-Requires-Root: no

Package: ${PACKAGE_NAME}
Architecture: any
Depends: \${misc:Depends}
Description: Connection tracking and NAT support for RTSP
 Netfilter conntrack and NAT helper kernel modules for the RTSP protocol.
EOF

cat << EOF > debian/rules
#!/usr/bin/make -f
export KERNEL_DIR := ${KERNEL_DIR}
PACKAGE_BUILD_DIR := debian/${PACKAGE_NAME}
KVER := ${KERNEL_VERSION}${KERNEL_SUFFIX}

%:
	dh \$@

override_dh_clean:
	dh_clean --exclude=debian/${PACKAGE_NAME}.substvars

override_dh_prep:
	dh_prep --exclude=debian/${PACKAGE_NAME}.substvars

override_dh_auto_build:
	make KERNELDIR=\${KERNEL_DIR}

override_dh_auto_install:
	install -D -m 644 nf_conntrack_rtsp.ko \${PACKAGE_BUILD_DIR}/lib/modules/\${KVER}/extra/nf_conntrack_rtsp.ko
	install -D -m 644 nf_nat_rtsp.ko \${PACKAGE_BUILD_DIR}/lib/modules/\${KVER}/extra/nf_nat_rtsp.ko
	\${KERNEL_DIR}/../sign-modules.sh \${PACKAGE_BUILD_DIR}/lib
EOF

debuild
