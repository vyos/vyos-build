#!/bin/sh
CWD=$(pwd)
KERNEL_VAR_FILE=${CWD}/kernel-vars

SRC=${CWD}/ovpn-dco
if [ ! -d ${SRC} ]; then
    echo "OpenVPN DCO source not found"
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
make KERNEL_SRC=$KERNEL_DIR

# Copy binary to package directory
DEBIAN_DIR=tmp/lib/modules/${KERNEL_VERSION}${KERNEL_SUFFIX}/extra
mkdir -p ${DEBIAN_DIR}
cp drivers/net/ovpn-dco/ovpn-dco-v2.ko ${DEBIAN_DIR}

# Sign generated Kernel modules
${CWD}/sign-modules.sh ${DEBIAN_DIR}

# Build Debian Package
fpm --input-type dir --output-type deb --name openvpn-dco \
    --version $(git describe | sed s/^v//) --deb-compression gz \
    --maintainer "VyOS Package Maintainers <maintainers@vyos.net>" \
    --description "OpenVPN Data Channel Offload" \
    --depends linux-image-${KERNEL_VERSION}${KERNEL_SUFFIX} \
    --license "GPL2" --chdir tmp

mv *.deb ..
