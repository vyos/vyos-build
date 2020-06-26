#!/bin/sh
CWD=$(pwd)
KERNEL_VAR_FILE=${CWD}/kernel-vars

QAT_SRC=${CWD}/intel-qat
if [ ! -d ${QAT_SRC} ]; then
    echo "Intel QAT source not found"
    exit 1
fi

if [ ! -f ${KERNEL_VAR_FILE} ]; then
    echo "Kernel variable file '${KERNEL_VAR_FILE}' does not exist, run ./build_kernel.sh first"
    exit 1
fi

. ${KERNEL_VAR_FILE}

cd ${QAT_SRC}

echo "I: Build Intel QAT Debian package"
KERNELDIR=${KERNEL_DIR} dpkg-buildpackage -b -us -uc -tc -j$(getconf _NPROCESSORS_ONLN)
