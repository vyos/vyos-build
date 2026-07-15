#!/bin/sh
CWD=$(pwd)
KERNEL_VAR_FILE=${CWD}/kernel-vars

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

DRIVER_VERSION=$(git describe | sed s/^v//)

# Build up Debian related variables required for packaging
DEBIAN_ARCH=$(dpkg --print-architecture)
DEBIAN_DIR="tmp/"
DEBIAN_CONTROL="${DEBIAN_DIR}/DEBIAN/control"
DEBIAN_POSTINST="${CWD}/vyos-ipt-netflow.postinst"

./configure --enable-direction --enable-macaddress --enable-vlan --enable-sampler --enable-aggregation --kdir=${KERNEL_DIR}
make all

if [ "x$?" != "x0" ]; then
    exit 1
fi

if [ -f ${DEBIAN_DIR}.deb ]; then
    rm ${DEBIAN_DIR}.deb
fi

if [ ! -d ${DEBIAN_DIR} ]; then
    mkdir -p ${DEBIAN_DIR}
fi

# build Debian package
echo "I: Building Debian package vyos-ipt-netflow"
cp ipt_NETFLOW.ko ${DEBIAN_DIR}
cp libipt_NETFLOW.so ${DEBIAN_DIR}
cp libip6t_NETFLOW.so ${DEBIAN_DIR}

# Sign generated Kernel modules
${CWD}/sign-modules.sh ${DEBIAN_DIR}

echo "#!/bin/sh" > ${DEBIAN_POSTINST}
echo "/sbin/depmod -a ${KERNEL_VERSION}${KERNEL_SUFFIX}" >> ${DEBIAN_POSTINST}

cd ${CWD}

fpm --input-type dir --output-type deb --name vyos-ipt-netflow \
    --version ${DRIVER_VERSION} --deb-compression gz \
    --maintainer "VyOS Package Maintainers <maintainers@vyos.net>" \
    --description "ipt_NETFLOW module" \
    --depends linux-image-${KERNEL_VERSION}${KERNEL_SUFFIX} \
    --license "GPL2" -C ${IPT_NETFLOW_SRC}/tmp --after-install ${DEBIAN_POSTINST} \
    ipt_NETFLOW.ko.xz=/lib/modules/${KERNEL_VERSION}${KERNEL_SUFFIX}/extra/ipt_NETFLOW.ko.xz \
    libipt_NETFLOW.so=/lib/$(uname -m)-linux-gnu/xtables/libipt_NETFLOW.so \
    libip6t_NETFLOW.so=/lib/$(uname -m)-linux-gnu/xtables/libip6t_NETFLOW.so
