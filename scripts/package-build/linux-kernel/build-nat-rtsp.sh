#!/bin/sh
CWD=$(pwd)
KERNEL_VAR_FILE=${CWD}/kernel-vars

SRC=${CWD}/nat-rtsp
if [ ! -d ${SRC} ]; then
    echo "nat-rtsp source not found"
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
make KERNELDIR=$KERNEL_DIR

# Copy binary to package directory
DEBIAN_DIR=tmp/lib/modules/${KERNEL_VERSION}${KERNEL_SUFFIX}/extra
mkdir -p ${DEBIAN_DIR}
cp nf_conntrack_rtsp.ko nf_nat_rtsp.ko ${DEBIAN_DIR}

DEBIAN_POSTINST="${CWD}/vyos-nat-rtsp.postinst"
echo "#!/bin/sh" > ${DEBIAN_POSTINST}
echo "/sbin/depmod -a ${KERNEL_VERSION}${KERNEL_SUFFIX}" >> ${DEBIAN_POSTINST}

# Sign generated Kernel modules
${CWD}/sign-modules.sh ${DEBIAN_DIR}

# Build Debian Package
fpm --input-type dir --output-type deb --name nat-rtsp \
    --version $(git describe --tags --always) --deb-compression gz \
    --maintainer "VyOS Package Maintainers <maintainers@vyos.net>" \
    --description "Connection tracking and NAT support for RTSP" \
    --depends linux-image-${KERNEL_VERSION}${KERNEL_SUFFIX} \
    --after-install ${DEBIAN_POSTINST} \
    --license "GPL2" --chdir tmp

mv *.deb ..

if [ -f ${DEBIAN_POSTINST} ]; then
    rm -f ${DEBIAN_POSTINST}
fi
