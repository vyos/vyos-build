#!/bin/sh
set -e
CWD=$(pwd)
KERNEL_VAR_FILE=${CWD}/kernel-vars
. ${CWD}/common.sh

IPT_NETFLOW_SRC=${CWD}/ipt-netflow
if [ ! -d ${IPT_NETFLOW_SRC} ]; then
    echo "ipt_NETFLOW  source not found"
    exit 1
fi

if [ ! -f ${KERNEL_VAR_FILE} ]; then
    echo "Kernel variable file '${KERNEL_VAR_FILE}' does not exist, run ./build_kernel.sh first"
    exit 1
fi

cd ${IPT_NETFLOW_SRC}
if [ -d .git ]; then
    git reset --hard HEAD
    git clean --force -d -x
fi

# Possibly making fork makes more sense in this case?..
PATCH_DIR=${CWD}/patches/ipt-netflow
for patch in $(ls ${PATCH_DIR})
do
    echo "I: Apply ipt-netflow patch: ${PATCH_DIR}/${patch}"
    patch -p1 < ${PATCH_DIR}/${patch}
done

. ${KERNEL_VAR_FILE}

PACKAGE_NAME=vyos-ipt-netflow
PACKAGE_VERSION=$(debian_version "$(git describe | sed s/^v//)")
UNAME_ARCH=$(uname -m)

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
Description: ipt_NETFLOW module
 Netfilter target module exporting network flows via NetFlow to a
 collector, plus xtables NETFLOW match libraries.
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

override_dh_auto_clean:
	@true

override_dh_auto_configure:
	@true

override_dh_auto_build:
	./configure --enable-direction --enable-macaddress --enable-vlan --enable-sampler --enable-aggregation --kdir=\${KERNEL_DIR}
	make all

override_dh_auto_install:
	install -D -m 644 ipt_NETFLOW.ko \${PACKAGE_BUILD_DIR}/lib/modules/\${KVER}/extra/ipt_NETFLOW.ko
	install -D -m 644 libipt_NETFLOW.so \${PACKAGE_BUILD_DIR}/lib/${UNAME_ARCH}-linux-gnu/xtables/libipt_NETFLOW.so
	install -D -m 644 libip6t_NETFLOW.so \${PACKAGE_BUILD_DIR}/lib/${UNAME_ARCH}-linux-gnu/xtables/libip6t_NETFLOW.so
	\${KERNEL_DIR}/../sign-modules.sh \${PACKAGE_BUILD_DIR}/lib
EOF

debuild
