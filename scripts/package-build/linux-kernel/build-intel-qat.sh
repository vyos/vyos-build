#!/bin/sh
set -e
CWD=$(pwd)
KERNEL_VAR_FILE=${CWD}/kernel-vars
. ${CWD}/common.sh

require_amd64 "Intel-QAT"

if [ ! -f ${KERNEL_VAR_FILE} ]; then
    echo "Kernel variable file '${KERNEL_VAR_FILE}' does not exist, run ./build_kernel.sh first"
    exit 1
fi

. ${KERNEL_VAR_FILE}

url="https://packages.vyos.net/source-mirror/QAT.L.4.28.0-00004.tar.gz"

cd ${CWD}

DRIVER_FILE=$(basename ${url} | sed -e s/tar_0/tar/)
DRIVER_DIR="${DRIVER_FILE%.tar.gz}"
DRIVER_NAME="QAT"
DRIVER_NAME_EXTRA="L."
DRIVER_VERSION=$(echo ${DRIVER_DIR} | awk -F${DRIVER_NAME} '{print $2}' | awk -F${DRIVER_NAME_EXTRA} '{print $2}')
DRIVER_VERSION_EXTRA="-0"

# Fetch Intel driver source from SourceForge
if [ -e ${DRIVER_FILE} ]; then
    rm -f ${DRIVER_FILE}
fi
curl -L -o ${DRIVER_FILE} ${url}
if [ "$?" -ne "0" ]; then
    exit 1
fi

# Unpack archive
if [ -d ${DRIVER_DIR} ]; then
    rm -rf ${DRIVER_DIR}
fi
mkdir -p ${DRIVER_DIR}
tar -C ${DRIVER_DIR} -xf ${DRIVER_FILE}

cd ${DRIVER_DIR}
if [ -z $KERNEL_DIR ]; then
    echo "KERNEL_DIR not defined"
    exit 1
fi

# Apply local patches (for newer kernels/backports)
if [ -d "${CWD}/patches/intel-qat" ]; then
    for p in "${CWD}"/patches/intel-qat/*.patch; do
        [ -e "$p" ] || continue
        echo "I: Applying Intel-QAT patch: $(basename "$p")"
        patch -p1 < "$p" || exit 1
    done
fi

PACKAGE_NAME=vyos-intel-$(echo ${DRIVER_NAME} | tr 'A-Z' 'a-z')
PACKAGE_VERSION=$(debian_version "${DRIVER_VERSION}${DRIVER_VERSION_EXTRA}")

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
 Intel QuickAssist Technology (QAT) kernel driver and userspace tools.
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
	KERNEL_SOURCE_ROOT=\${KERNEL_DIR} ./configure --enable-kapi --enable-qat-lkcf
	\$(MAKE) -j \$(shell getconf _NPROCESSORS_ONLN) all

override_dh_auto_install:
	mkdir -p \${PACKAGE_BUILD_DIR}/lib/firmware \${PACKAGE_BUILD_DIR}/usr/sbin \${PACKAGE_BUILD_DIR}/usr/lib/x86_64-linux-gnu \${PACKAGE_BUILD_DIR}/etc/init.d
	\$(MAKE) INSTALL_MOD_PATH=\$(CURDIR)/\${PACKAGE_BUILD_DIR} INSTALL_FW_PATH=\$(CURDIR)/\${PACKAGE_BUILD_DIR} qat-driver-install adf-ctl-all
	cp quickassist/qat/fw/*.bin \${PACKAGE_BUILD_DIR}/lib/firmware
	cp build/*.so \${PACKAGE_BUILD_DIR}/usr/lib/x86_64-linux-gnu
	cp build/adf_ctl \${PACKAGE_BUILD_DIR}/usr/sbin
	cp quickassist/build_system/build_files/qat_service \${PACKAGE_BUILD_DIR}/etc/init.d
	cp build/usdm_drv.ko \${PACKAGE_BUILD_DIR}/lib/modules/\${KVER}/updates/drivers
	chmod 644 \${PACKAGE_BUILD_DIR}/lib/firmware/*
	chmod 755 \${PACKAGE_BUILD_DIR}/etc/init.d/*
	find \${PACKAGE_BUILD_DIR} -name "modules.*" -delete
	\${KERNEL_DIR}/../sign-modules.sh \${PACKAGE_BUILD_DIR}/lib
EOF

debuild

echo "I: Cleanup ${DRIVER_NAME} source"
cd ${CWD}
if [ -e ${DRIVER_FILE} ]; then
    rm -f ${DRIVER_FILE}
fi
if [ -d ${DRIVER_DIR} ]; then
    rm -rf ${DRIVER_DIR}
fi
