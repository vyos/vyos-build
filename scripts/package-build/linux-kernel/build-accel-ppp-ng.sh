#!/bin/sh

CWD=$(pwd)
KERNEL_VAR_FILE=${CWD}/kernel-vars
VPP_INCLUDE_PATH="${CWD}/../vpp/vpp/src/vpp-api:${CWD}/../vpp/vpp/src:${CWD}/../vpp/vpp/build-root/build-vpp-native/vpp/CMakeFiles/vpp-api"
VPP_LIBRARY_PATH="${CWD}/../vpp/vpp/build-root/build-vpp-native/vpp/CMakeFiles/debian/libvppinfra/usr/lib/x86_64-linux-gnu/:${CWD}/../vpp/vpp/build-root/install-vpp-native/vpp/lib/x86_64-linux-gnu/"
VPP_LIB_CHECK_PATH="${CWD}/../vpp/vpp/build-root/build-vpp-native/vpp/CMakeFiles/debian/libvppinfra/usr/lib/x86_64-linux-gnu/"

ACCEL_SRC=${CWD}/accel-ppp-ng

# Build VPP as we need VPP libraries
cd ../vpp/
./build.py
cd ${CWD}

if [ ! -d ${VPP_LIB_CHECK_PATH} ]; then
    echo "VPP source libraries not found"
    exit 1
fi

if [ ! -d ${ACCEL_SRC} ]; then
    echo "Accel-PPP source not found"
    exit 1
fi

if [ ! -f ${KERNEL_VAR_FILE} ]; then
    echo "Kernel variable file '${KERNEL_VAR_FILE}' does not exist, run ./build_kernel.sh first"
    exit 1
fi

cd ${ACCEL_SRC}
git reset --hard HEAD
git clean --force -d -x

PATCH_DIR=${CWD}/patches/accel-ppp-ng
if [ -d $PATCH_DIR ]; then
    cd ${ACCEL_SRC}
    for patch in $(ls ${PATCH_DIR})
    do
        echo "I: Apply patch: ${PATCH_DIR}/${patch}"
        patch -p1 < ${PATCH_DIR}/${patch}
    done
fi

. ${KERNEL_VAR_FILE}
mkdir -p ${ACCEL_SRC}/build
cd ${ACCEL_SRC}/build

echo "I: Build Accel-PPP Debian package"
cmake -DBUILD_IPOE_DRIVER=TRUE \
    -DBUILD_VLAN_MON_DRIVER=TRUE \
    -DCMAKE_INSTALL_PREFIX=/usr \
    -DKDIR=${KERNEL_DIR} \
    -DLUA=5.3 \
    -DMODULES_KDIR=${KERNEL_VERSION}${KERNEL_SUFFIX} \
    -DHAVE_VPP=1 \ 
    -DCPACK_TYPE=Debian12 ..
CPATH="${VPP_INCLUDE_PATH}" LIBRARY_PATH="${VPP_LIBRARY_PATH}" make

# Sign generated Kernel modules
${CWD}/sign-modules.sh .

cpack -G DEB

# rename resulting Debian package according git description
mv accel-ppp*.deb ${CWD}/accel-ppp-ng_$(git describe --always --tags)_$(dpkg --print-architecture).deb

# move VPP binaries to linux-kernel dir, CI will get VPP .deb here
cp ${CWD}/../vpp/*.deb ${CWD}
