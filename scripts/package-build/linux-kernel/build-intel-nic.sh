#!/bin/sh
set -e
CWD=$(pwd)
KERNEL_VAR_FILE=${CWD}/kernel-vars
. ${CWD}/common.sh

require_amd64 "Intel drivers"

if [ ! -f ${KERNEL_VAR_FILE} ]; then
    echo "Kernel variable file '${KERNEL_VAR_FILE}' does not exist, run ./build_kernel.sh first"
    exit 1
fi

. ${KERNEL_VAR_FILE}

if [ -z $KERNEL_DIR ]; then
    echo "KERNEL_DIR not defined"
    exit 1
fi

DRIVER_NAME=$1
cd ${CWD}/ethernet-linux-${DRIVER_NAME}
if [ -d .git ]; then
    git clean --force -d -x
    git reset --hard origin/main
fi

# See https://vyos.dev/T6155
# See https://vyos.dev/T6162
PATCH_DIR=${CWD}/patches/${DRIVER_NAME}
if [ -d $PATCH_DIR ]; then
    for patch in $(ls ${PATCH_DIR})
    do
        echo "I: Apply patch: ${PATCH_DIR}/${patch}"
        patch -p1 < ${PATCH_DIR}/${patch}
    done
fi

PACKAGE_NAME=vyos-intel-${DRIVER_NAME}
PACKAGE_VERSION=$(debian_version "$(git describe | sed s/^v//)")

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
Description: Vendor based driver for Intel ${DRIVER_NAME}
 Out-of-tree Intel ${DRIVER_NAME} network driver kernel module.
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
	@true

override_dh_auto_install:
	make KSRC=\${KERNEL_DIR} BUILD_KERNEL=\${KVER} INSTALL_MOD_PATH=\$(CURDIR)/\${PACKAGE_BUILD_DIR} INSTALL_FW_PATH=\$(CURDIR)/\${PACKAGE_BUILD_DIR} -j \$(shell getconf _NPROCESSORS_ONLN) -C src install
	find \${PACKAGE_BUILD_DIR} -name "modules.*" -delete
	\${KERNEL_DIR}/../sign-modules.sh \${PACKAGE_BUILD_DIR}/lib
EOF

debuild
