#!/bin/sh
DROP_DEV_DBG_DEBS=1
DEB_DISTRO='debian12.1'
CWD=$(pwd)
KERNEL_VAR_FILE=${CWD}/kernel-vars

if [ $(id -u) -ne 0 ]; then
  echo "Mellanox OFED script needs to be run as root"
  exit
fi

if ! dpkg-architecture -iamd64; then
    echo "Mellanox OFED is only buildable on amd64 platforms"
    exit 0
fi

if [ ! -f ${KERNEL_VAR_FILE} ]; then
    echo "Kernel variable file '${KERNEL_VAR_FILE}' does not exist, run ./build_kernel.sh first"
    exit 1
fi

. ${KERNEL_VAR_FILE}

mlxver="24.07-0.6.1.0"
url="https://www.mellanox.com/downloads/ofed/MLNX_OFED-${mlxver}/MLNX_OFED_SRC-debian-${mlxver}.tgz"

cd ${CWD}

DRIVER_FILE=$(basename ${url} | sed -e s/tar_0/tar/)
DRIVER_SHA1="c64defa8fb38dcbce153adc09834ab5cdcecd791"

DRIVER_DIR="${DRIVER_FILE%.tgz}"
DRIVER_NAME="ofed"
DRIVER_PRFX="MLNX_OFED"
DRIVER_VERSION=$(echo ${DRIVER_DIR} | awk -F${DRIVER_PRFX} '{print $2}' | sed 's/^-//;s|_SRC-debian-||')
DRIVER_VERSION_EXTRA=""

# Build up Debian related variables required for packaging
DEBIAN_ARCH=$(dpkg --print-architecture)
DEBIAN_DIR="${CWD}/vyos-mellanox-${DRIVER_NAME}_${DRIVER_VERSION}_${DEBIAN_ARCH}"
DEBIAN_CONTROL="${DEBIAN_DIR}/DEBIAN/control"
DEBIAN_POSTINST="${CWD}/vyos-mellanox-ofed.postinst"

# Fetch OFED driver source from Nvidia
if [ -e ${DRIVER_FILE} ]; then
    rm -f ${DRIVER_FILE}
fi
curl -L -o ${DRIVER_FILE} ${url}
if [ "$?" -ne "0" ]; then
    exit 1
fi

# Verify integrity
echo "${DRIVER_SHA1} ${DRIVER_FILE}" | sha1sum -c -
if [ $? != 0 ]; then
    echo SHA1 checksum missmatch
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

rm -f SOURCES/ibarr_*.tar.gz
rm -f SOURCES/ibdump_*.tar.gz
rm -f SOURCES/ibsim_*.tar.gz
rm -f SOURCES/iser_*.tar.gz
rm -f SOURCES/isert_*.tar.gz
rm -f SOURCES/kernel-mft_*.tar.gz
rm -f SOURCES/knem_*.tar.gz
rm -f SOURCES/libvma_*.tar.gz
rm -f SOURCES/libxlio_*.tar.gz
rm -f SOURCES/mlnx-ethtool_*.tar.gz
rm -f SOURCES/mlnx-iproute2_*.tar.gz
rm -f SOURCES/mlnx-nfsrdma_*.tar.gz
rm -f SOURCES/mlnx-nvme_*.tar.gz
rm -f SOURCES/mlx-steering-dump_*.tar.gz
rm -f SOURCES/mpitests_*.tar.gz
rm -f SOURCES/mstflint_*.tar.gz
rm -f SOURCES/ofed-scripts_*.tar.gz
rm -f SOURCES/openmpi_*.tar.gz
rm -f SOURCES/openvswitch_*.tar.gz
rm -f SOURCES/perftest_*.tar.gz
rm -f SOURCES/rdma-core_*.tar.gz
rm -f SOURCES/rshim_*.tar.gz
rm -f SOURCES/sockperf_*.tar.gz
rm -f SOURCES/srp_*.tar.gz
rm -f SOURCES/ucx_*.tar.gz

./install.pl \
  --basic --dpdk \
  --without-dkms \
  --without-mlnx-nvme-modules \
  --with-vma --vma-vpi --vma-eth \
  --guest --hypervisor \
  --builddir ${DEBIAN_DIR}/mlx \
  --distro ${DEB_DISTRO} \
  --kernel-sources ${KERNEL_DIR} \
  --kernel ${KERNEL_VERSION}${KERNEL_SUFFIX}

if [ $DROP_DEV_DBG_DEBS -eq 1 ]; then
  echo "I: Removing development and debug packages"
  rm -f $(find $CWD/$DRIVER_DIR/DEBS/$DEB_DISTRO -type f | grep -E '\-dev|\-dbg')
fi

cp $(find $CWD/$DRIVER_DIR/DEBS/$DEB_DISTRO -type f | grep '\.deb$') "$CWD/"

echo "I: Cleanup ${DRIVER_NAME} source"
cd ${CWD}
if [ -f ${DRIVER_FILE} ]; then
    rm -f ${DRIVER_FILE}
fi
if [ -d ${DRIVER_DIR} ]; then
    rm -rf ${DRIVER_DIR}
fi
if [ -d ${DEBIAN_DIR} ]; then
    rm -rf ${DEBIAN_DIR}
fi
