#!/bin/sh
set -e
DROP_DEV_DBG_DEBS=1
DEB_DISTRO='debian12.1'
CWD=$(pwd)
KERNEL_VAR_FILE=${CWD}/kernel-vars
. ${CWD}/common.sh

require_amd64 "Mellanox OFED"

if [ ! -f ${KERNEL_VAR_FILE} ]; then
    echo "Kernel variable file '${KERNEL_VAR_FILE}' does not exist, run ./build_kernel.sh first"
    exit 1
fi

. ${KERNEL_VAR_FILE}

docaver="3.5.0"
mlxver="26.07-0.7.7.0"
url="https://linux.mellanox.com/public/repo/doca/${docaver}/SOURCES/mlnx_ofed/MLNX_OFED_SRC-debian-${mlxver}.tgz"

cd ${CWD}

DRIVER_FILE=$(basename ${url} | sed -e s/tar_0/tar/)
DRIVER_SHA256="bbf2a5b56727e5099b3bdc0d1b0e7b8a09b758c78048f715ed90c5730bd64f96"

DRIVER_DIR="${DRIVER_FILE%.tgz}"
DRIVER_NAME="ofed"
DRIVER_PRFX="MLNX_OFED"
DRIVER_VERSION=$(echo ${DRIVER_DIR} | awk -F${DRIVER_PRFX} '{print $2}' | sed 's/^-//;s|_SRC-debian-||')

# Build up Debian related variables required for packaging
DEBIAN_ARCH=$(dpkg --print-architecture)
DEBIAN_DIR="${CWD}/vyos-mellanox-${DRIVER_NAME}_${DRIVER_VERSION}_${DEBIAN_ARCH}"

# Fetch OFED driver source from Nvidia
if [ -e ${DRIVER_FILE} ]; then
    rm -f ${DRIVER_FILE}
fi
curl -L -o ${DRIVER_FILE} ${url}
if [ "$?" -ne "0" ]; then
    exit 1
fi

# Verify integrity
echo "${DRIVER_SHA256} ${DRIVER_FILE}" | sha256sum -c -
if [ $? != 0 ]; then
    echo SHA256 checksum mismatch
    exit 1
fi

# Unpack archive
if [ -d ${DRIVER_DIR} ]; then
    rm -rf ${DRIVER_DIR}
fi
mkdir -p ${DRIVER_DIR}
tar -C ${DRIVER_DIR} --strip-components=1 -xf ${DRIVER_FILE}

# Build/install debs
cd ${DRIVER_DIR}
if [ -z $KERNEL_DIR ]; then
    echo "KERNEL_DIR not defined"
    exit 1
fi

rm -f SOURCES/ibarr_*.tar.*
rm -f SOURCES/ibdump_*.tar.*
rm -f SOURCES/ibsim_*.tar.*
rm -f SOURCES/iser_*.tar.*
rm -f SOURCES/isert_*.tar.*
rm -f SOURCES/kernel-mft_*.tar.*
rm -f SOURCES/libvma_*.tar.*
rm -f SOURCES/libxlio_*.tar.*
rm -f SOURCES/mlnx-ethtool_*.tar.*
rm -f SOURCES/mlnx-iproute2_*.tar.*
rm -f SOURCES/mlnx-nfsrdma_*.tar.*
rm -f SOURCES/mlnx-nvme_*.tar.*
rm -f SOURCES/mlx-steering-dump_*.tar.*
rm -f SOURCES/ofed-scripts_*.tar.*
rm -f SOURCES/openmpi_*.tar.*
rm -f SOURCES/perftest_*.tar.*
rm -f SOURCES/rdma-core_*.tar.*
rm -f SOURCES/rshim_*.tar.*
rm -f SOURCES/sockperf_*.tar.*
rm -f SOURCES/srp_*.tar.*
rm -f SOURCES/ucx_*.tar.*
rm -f SOURCES/virtiofs_*.tar.*
rm -f SOURCES/xpmem_*.tar.*

# install.pl builds from the orig tarballs in SOURCES, patch them in place
PATCH_DIR=${CWD}/patches/mlnx-ofed-kernel
if [ -d ${PATCH_DIR} ]; then
    ORIG_TAR=$(ls SOURCES/mlnx-ofed-kernel_*.orig.tar.xz)
    ORIG_DIR=$(mktemp -d)
    tar -C ${ORIG_DIR} -xf ${ORIG_TAR}
    for patch in $(ls ${PATCH_DIR})
    do
        echo "I: Apply patch: ${PATCH_DIR}/${patch}"
        patch -d ${ORIG_DIR}/mlnx-ofed-kernel-* -p1 < ${PATCH_DIR}/${patch}
    done
    tar -C ${ORIG_DIR} -cJf ${ORIG_TAR} .
    rm -rf ${ORIG_DIR}
fi

# --build-only keeps install.pl from touching the host's packages so no root
# is needed. It is only accepted with --kernel-only, whose module set is
# trimmed back to what was built before. Build dependencies are left to
# dpkg-buildpackage, the install.pl check would try to apt-get them.
./install.pl \
  --kernel-only --build-only \
  --without-depcheck \
  --without-dkms \
  --without-mlnx-nvme-modules \
  --without-sdp --without-srpt --without-rds \
  --without-e_ipoib --without-nfsrdma \
  --builddir ${DEBIAN_DIR}/mlx \
  --distro ${DEB_DISTRO} \
  --kernel-sources ${KERNEL_DIR} \
  --kernel ${KERNEL_VERSION}${KERNEL_SUFFIX}

# mlnx-ofed-kernel-utils depends on mlnx-tools, which --kernel-only skips
MLNX_TOOLS_DIR=${DEBIAN_DIR}/mlx/mlnx-tools
mkdir -p ${MLNX_TOOLS_DIR}
tar -C ${MLNX_TOOLS_DIR} -xf $(ls SOURCES/mlnx-tools_*.orig.tar.xz)
(cd ${MLNX_TOOLS_DIR}/mlnx-tools-* && dpkg-buildpackage -us -uc -b)
mkdir -p DEBS/${DEB_DISTRO}/x86_64
cp ${MLNX_TOOLS_DIR}/mlnx-tools_*.deb DEBS/${DEB_DISTRO}/x86_64/

if [ $DROP_DEV_DBG_DEBS -eq 1 ]; then
  echo "I: Removing development and debug packages"
  rm -f $(find $CWD/$DRIVER_DIR/DEBS/$DEB_DISTRO -type f | grep -E '\-dev|\-dbg')
fi

cp $(find $CWD/$DRIVER_DIR/DEBS/$DEB_DISTRO -type f | grep '\.deb$') "$CWD/"

echo "I: Cleanup ${DRIVER_NAME} source"
cd ${CWD}

# Sign modules
DEB_NAME=$(ls mlnx-ofed-kernel-modules_*)
TMP_DIR="tmp-ofed-sign"
dpkg-deb --raw-extract ${DEB_NAME} ${TMP_DIR}
# Sign generated Kernel modules
${CWD}/sign-modules.sh ${TMP_DIR}
# Signing compresses the modules, md5sums still lists the plain .ko files
(cd ${TMP_DIR} && find . -path ./DEBIAN -prune -o -type f -printf '%P\n' | sort | xargs md5sum > DEBIAN/md5sums)
# Cleanup and repack DEB
rm -f ${DEB_NAME}
dpkg-deb --build --root-owner-group ${TMP_DIR} ${DEB_NAME}
rm -rf ${TMP_DIR}

if [ -f ${DRIVER_FILE} ]; then
    rm -f ${DRIVER_FILE}
fi
if [ -d ${DRIVER_DIR} ]; then
    rm -rf ${DRIVER_DIR}
fi
if [ -d ${DEBIAN_DIR} ]; then
    rm -rf ${DEBIAN_DIR}
fi
