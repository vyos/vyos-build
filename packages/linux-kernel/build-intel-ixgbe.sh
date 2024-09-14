#!/bin/sh
CWD=$(pwd)
KERNEL_VAR_FILE=${CWD}/kernel-vars

if ! dpkg-architecture -iamd64; then
    echo "Intel ixgbe is only buildable on amd64 platforms"
    exit 0
fi

if [ ! -f ${KERNEL_VAR_FILE} ]; then
    echo "Kernel variable file '${KERNEL_VAR_FILE}' does not exist, run ./build_kernel.sh first"
    exit 1
fi

. ${KERNEL_VAR_FILE}

url="https://sourceforge.net/projects/e1000/files/ixgbe%20stable/5.20.3/ixgbe-5.20.3.tar.gz"

cd ${CWD}

DRIVER_FILE=$(basename ${url} | sed -e s/tar_0/tar/)
DRIVER_DIR="${DRIVER_FILE%.tar.gz}"
DRIVER_NAME="ixgbe"
DRIVER_VERSION=$(echo ${DRIVER_DIR} | awk -F${DRIVER_NAME} '{print $2}' | sed 's/^-//')
DRIVER_VERSION_EXTRA=""

# Build up Debian related variables required for packaging
DEBIAN_ARCH=$(dpkg --print-architecture)
DEBIAN_DIR="${CWD}/vyos-intel-${DRIVER_NAME}_${DRIVER_VERSION}_${DEBIAN_ARCH}"
DEBIAN_CONTROL="${DEBIAN_DIR}/DEBIAN/control"
DEBIAN_POSTINST="${CWD}/vyos-intel-ixgbe.postinst"

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
tar -C ${DRIVER_DIR} --strip-components=1 -xf ${DRIVER_FILE}

cd ${DRIVER_DIR}/src
if [ -z $KERNEL_DIR ]; then
    echo "KERNEL_DIR not defined"
    exit 1
fi

# See https://lore.kernel.org/lkml/f90837d0-810e-5772-7841-28d47c44d260@intel.com/
echo "I: remove pci_enable_pcie_error_reporting() code no longer present in Kernel"
sed -i '/.*pci_disable_pcie_error_reporting(pdev);/d' ixgbe_main.c
sed -i '/.*pci_enable_pcie_error_reporting(pdev);/d' ixgbe_main.c

# See https://vyos.dev/T6155
echo "I: always enable allow_unsupported_sfp for all NICs by default"
patch -l -p1 < ../../patches/ixgbe/allow_unsupported_sfp.patch

# See https://vyos.dev/T6162
echo "I: add 1000BASE-BX support"
patch -l -p1 < ../../patches/ixgbe/add_1000base-bx_support.patch

echo "I: Compile Kernel module for Intel ${DRIVER_NAME} driver"
make KSRC=${KERNEL_DIR} INSTALL_MOD_PATH=${DEBIAN_DIR} INSTALL_FW_PATH=${DEBIAN_DIR} -j $(getconf _NPROCESSORS_ONLN) install

if [ "x$?" != "x0" ]; then
    exit 1
fi

if [ -f ${DEBIAN_DIR}.deb ]; then
    rm ${DEBIAN_DIR}.deb
fi

# build Debian package
echo "I: Building Debian package vyos-intel-${DRIVER_NAME}"
cd ${CWD}

# delete non required files which are also present in the kernel package
# und thus lead to duplicated files
find ${DEBIAN_DIR} -name "modules.*" | xargs rm -f

echo "#!/bin/sh" > ${DEBIAN_POSTINST}
echo "/sbin/depmod -a ${KERNEL_VERSION}${KERNEL_SUFFIX}" >> ${DEBIAN_POSTINST}

fpm --input-type dir --output-type deb --name vyos-intel-${DRIVER_NAME} \
    --version ${DRIVER_VERSION} --deb-compression gz \
    --maintainer "VyOS Package Maintainers <maintainers@vyos.net>" \
    --description "Vendor based driver for Intel ${DRIVER_NAME}" \
    --depends linux-image-${KERNEL_VERSION}${KERNEL_SUFFIX} \
    --license "GPL2" -C ${DEBIAN_DIR} --after-install ${DEBIAN_POSTINST}

echo "I: Cleanup ${DRIVER_NAME} source"
cd ${CWD}
if [ -e ${DRIVER_FILE} ]; then
    rm -f ${DRIVER_FILE}
fi
if [ -d ${DRIVER_DIR} ]; then
    rm -rf ${DRIVER_DIR}
fi
if [ -d ${DEBIAN_DIR} ]; then
    rm -rf ${DEBIAN_DIR}
fi
if [ -f ${DEBIAN_POSTINST} ]; then
    rm -f ${DEBIAN_POSTINST}
fi
