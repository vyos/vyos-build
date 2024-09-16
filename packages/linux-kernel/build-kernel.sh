#!/bin/bash
CWD=$(pwd)
KERNEL_SRC=linux

set -e

if [ ! -d ${KERNEL_SRC} ]; then
    echo "Linux Kernel source directory does not exists, please 'git clone'"
    exit 1
fi

echo "I: Copy Kernel config (x86_64_vyos_defconfig) to Kernel Source"
cp -rv arch/ ${KERNEL_SRC}/

cd ${KERNEL_SRC}

echo "I: clean modified files"
git reset --hard HEAD

KERNEL_VERSION=$(make kernelversion)
KERNEL_SUFFIX=-$(awk -F "= " '/kernel_flavor/ {print $2}' ../../../data/defaults.toml | tr -d \")
KERNEL_CONFIG=arch/x86/configs/vyos_defconfig

# VyOS requires some small Kernel Patches - apply them here
# It's easier to habe them here and make use of the upstream
# repository instead of maintaining a full Kernel Fork.
# Saving time/resources is essential :-)
PATCH_DIR=${CWD}/patches/kernel
for patch in $(ls ${PATCH_DIR})
do
    echo "I: Apply Kernel patch: ${PATCH_DIR}/${patch}"
    patch -p1 < ${PATCH_DIR}/${patch}
done

TRUSTED_KEYS_FILE=trusted_keys.pem
# start with empty key file
echo -n "" > $TRUSTED_KEYS_FILE
CERTS=$(ls ../../../data/live-build-config/includes.chroot/var/lib/shim-signed/mok/*.pem)
if [ ! -z "${CERTS}" ]; then
  # add known public keys to Kernel certificate chain
  for file in $CERTS; do
    cat $file >> $TRUSTED_KEYS_FILE
  done

  # Force Kernel module signing and embed public keys
  echo "CONFIG_MODULE_SIG_FORMAT=y" >> $KERNEL_CONFIG
  echo "CONFIG_MODULE_SIG=y" >> $KERNEL_CONFIG
  echo "CONFIG_MODULE_SIG_FORCE=y" >> $KERNEL_CONFIG
  echo "# CONFIG_MODULE_SIG_ALL is not set" >> $KERNEL_CONFIG
  echo "CONFIG_MODULE_SIG_SHA512=y" >> $KERNEL_CONFIG
  echo "CONFIG_MODULE_SIG_HASH=\"sha512\"" >> $KERNEL_CONFIG
  echo "CONFIG_MODULE_SIG_KEY=\"\"" >> $KERNEL_CONFIG
  echo "CONFIG_MODULE_SIG_KEY_TYPE_RSA=y" >> $KERNEL_CONFIG
  echo "CONFIG_SYSTEM_TRUSTED_KEYS=\"$TRUSTED_KEYS_FILE\"" >> $KERNEL_CONFIG
fi

echo "I: make vyos_defconfig"
# Select Kernel configuration - currently there is only one
make vyos_defconfig

echo "I: Generate environment file containing Kernel variable"
cat << EOF >${CWD}/kernel-vars
#!/bin/sh
export KERNEL_VERSION=${KERNEL_VERSION}
export KERNEL_SUFFIX=${KERNEL_SUFFIX}
export KERNEL_DIR=${CWD}/${KERNEL_SRC}
EOF

echo "I: Build Debian Kernel package"
touch .scmversion
make bindeb-pkg BUILD_TOOLS=1 LOCALVERSION=${KERNEL_SUFFIX} KDEB_PKGVERSION=${KERNEL_VERSION}-1 -j $(getconf _NPROCESSORS_ONLN)

cd $CWD
if [[ $? == 0 ]]; then
    for package in $(ls linux-*.deb)
    do
        ln -sf linux-kernel/$package ..
    done
fi
