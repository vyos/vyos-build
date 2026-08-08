#!/bin/sh
set -e
CWD=$(pwd)
KERNEL_VAR_FILE=${CWD}/kernel-vars

if [ ! -f ${KERNEL_VAR_FILE} ]; then
    echo "Kernel variable file '${KERNEL_VAR_FILE}' does not exist, run ./build-kernel.sh first"
    exit 1
fi

. ${KERNEL_VAR_FILE}

PACKAGE_NAME=vyos-drivers-realtek-r8126
PACKAGE_VERSION=10.016.00
PACKAGE_DIR=${PACKAGE_NAME}-${PACKAGE_VERSION}
SOURCES_ARCHIVE=r8126-${PACKAGE_VERSION}.tar.bz2
SOURCES_URL=https://packages.vyos.net/source-mirror/${SOURCES_ARCHIVE}

if [ -e ${SOURCES_ARCHIVE} ]; then
    rm -f ${SOURCES_ARCHIVE}
fi
curl -L -o ${SOURCES_ARCHIVE} ${SOURCES_URL}

debmake -e support@vyos.io -f "VyOS Support" -p ${PACKAGE_NAME} -u ${PACKAGE_VERSION} -a ${SOURCES_ARCHIVE}

echo "misc:Depends=linux-image-${KERNEL_VERSION}${KERNEL_SUFFIX}" > ${PACKAGE_DIR}/debian/${PACKAGE_NAME}.substvars

cat << EOF > ${PACKAGE_DIR}/debian/rules
#!/usr/bin/make -f
# config
export KERNELDIR := ${KERNEL_DIR}
PACKAGE_BUILD_DIR := debian/${PACKAGE_NAME}
KVER := ${KERNEL_VERSION}${KERNEL_SUFFIX}
MODULES_DIR := updates/drivers/net/ethernet
# main packaging script based on dh7 syntax
%:
	dh \$@

override_dh_clean:
	dh_clean --exclude=debian/${PACKAGE_NAME}.substvars

override_dh_prep:
	dh_prep --exclude=debian/${PACKAGE_NAME}.substvars

override_dh_auto_clean:
	make clean

override_dh_auto_build:
	echo "KERNELDIR=\${KERNELDIR}"
	echo "CURDIR=\${CURDIR}"
	make -C \${KERNELDIR} M=\${CURDIR}/src modules

override_dh_auto_install:
	install -D -m 644 src/r8126.ko \${PACKAGE_BUILD_DIR}/lib/modules/\${KVER}/\${MODULES_DIR}/r8126.ko
	\${KERNELDIR}/../sign-modules.sh \${PACKAGE_BUILD_DIR}/lib
EOF

cd ${PACKAGE_DIR}
debuild
cd ${CWD}

rm -rf ${PACKAGE_DIR}
