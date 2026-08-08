#!/bin/sh
set -e
CWD=$(pwd)
KERNEL_VAR_FILE=${CWD}/kernel-vars

if [ ! -f ${KERNEL_VAR_FILE} ]; then
    echo "Kernel variable file '${KERNEL_VAR_FILE}' does not exist, run ./build-kernel.sh first"
    exit 1
fi

. ${KERNEL_VAR_FILE}

PACKAGE_NAME=jool
PACKAGE_VERSION=4.1.15
PACKAGE_DIR=${PACKAGE_NAME}-${PACKAGE_VERSION}
SOURCES_ARCHIVE=${PACKAGE_DIR}.tar.gz
SOURCES_URL=https://github.com/NICMx/Jool/archive/refs/tags/v${PACKAGE_VERSION}.tar.gz

if [ -e ${SOURCES_ARCHIVE} ]; then
    rm -f ${SOURCES_ARCHIVE}
fi
curl -L -o ${SOURCES_ARCHIVE} ${SOURCES_URL}

debmake -e support@vyos.io -f "VyOS Support" -p ${PACKAGE_NAME} -u ${PACKAGE_VERSION} -a ${SOURCES_ARCHIVE}

echo "misc:Depends=linux-image-${KERNEL_VERSION}${KERNEL_SUFFIX}" > ${PACKAGE_DIR}/debian/${PACKAGE_NAME}.substvars

cat << EOF > ${PACKAGE_DIR}/debian/rules
#!/usr/bin/make -f
# config
export KERNEL_DIR := ${KERNEL_DIR}
PACKAGE_BUILD_DIR := debian/${PACKAGE_NAME}
KVER := ${KERNEL_VERSION}${KERNEL_SUFFIX}
MODULES_DIR := extra

# main packaging script based on dh7 syntax
%:
	dh \$@

override_dh_clean:
	dh_clean --exclude=debian/${PACKAGE_NAME}.substvars

override_dh_prep:
	dh_prep --exclude=debian/${PACKAGE_NAME}.substvars

override_dh_auto_build:
	dh_auto_build \$@
	make -C \${KERNEL_DIR} M=\$\$PWD/src/mod/common modules
	make -C \${KERNEL_DIR} M=\$\$PWD/src/mod/nat64 modules
	make -C \${KERNEL_DIR} M=\$\$PWD/src/mod/siit modules

override_dh_auto_install:
	dh_auto_install \$@
	install -D -m 644 src/mod/common/jool_common.ko \${PACKAGE_BUILD_DIR}/lib/modules/\${KVER}/\${MODULES_DIR}/jool_common.ko
	install -D -m 644 src/mod/nat64/jool.ko \${PACKAGE_BUILD_DIR}/lib/modules/\${KVER}/\${MODULES_DIR}/jool.ko
	install -D -m 644 src/mod/siit/jool_siit.ko \${PACKAGE_BUILD_DIR}/lib/modules/\${KVER}/\${MODULES_DIR}/jool_siit.ko
	\${KERNEL_DIR}/../sign-modules.sh \${PACKAGE_BUILD_DIR}/lib
EOF

cd ${PACKAGE_DIR}
debuild
