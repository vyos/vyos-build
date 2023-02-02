#!/bin/bash

# Test harness for building kCFI/LTO kernels with LLVM-16
# Parts of this should become steps of the Docker image build, parts kept here for when we support multi-config

# Install dependencies (only once)
if [[ -z "$(grep llvm /etc/apt/sources.list)" ]]; then
sudo apt purge -y $(dpkg -l|grep -E 'clang|llvm' | awk '/1:11/{print$2}')
wget -O - https://apt.llvm.org/llvm-snapshot.gpg.key | sudo apt-key add -
sudo sh -c 'echo "deb http://apt.llvm.org/bullseye/ llvm-toolchain-bullseye-16 main" >> /etc/apt/sources.list'
sudo sh -c 'echo "deb-src http://apt.llvm.org/bullseye/ llvm-toolchain-bullseye-16 main" >> /etc/apt/sources.list'
sudo apt update
# LLVM 16 packages for kCFI support
sudo apt-get -y install libllvm-16-ocaml-dev libllvm16 llvm-16 llvm-16-dev llvm-16-doc llvm-16-examples llvm-16-runtime \
clang-16 clang-tools-16 clang-16-doc libclang-common-16-dev libclang-16-dev libclang1-16 clang-format-16 python3-clang-16 clangd-16 clang-tidy-16 \
libclang-rt-16-dev \
libpolly-16-dev \
libfuzzer-16-dev \
lldb-16 \
lld-16 \
libc++-16-dev libc++abi-16-dev \
libomp-16-dev \
libclc-16-dev \
libunwind-16-dev
# Configure LLVM build
pushd .
cd /usr/bin/
ls -1|grep '\-16$'|while read LN; do sudo ln -s "$LN" "$(echo "$LN"|sed -e 's|-16$||')" ;done
popd
export CC=clang
export LLVM=1
mv arch/x86/configs/vyos_defconfig arch/x86/configs/vyos_defconfig.real
fi
# Replace the default config w/ the LLVM one until we can support multi-config/kernel setups
cp arch/x86/configs/vyos_llvm_config arch/x86/configs/vyos_defconfig
# Get sources
KERNEL_VER=$(cat ../../data/defaults.toml | tomlq -r .kernel_version)
gpg2 --locate-keys torvalds@kernel.org gregkh@kernel.org
curl -OL https://www.kernel.org/pub/linux/kernel/v6.x/linux-${KERNEL_VER}.tar.xz
curl -OL https://www.kernel.org/pub/linux/kernel/v6.x/linux-${KERNEL_VER}.tar.sign
xz -cd linux-${KERNEL_VER}.tar.xz | gpg2 --verify linux-${KERNEL_VER}.tar.sign -
if [ $? -ne 0 ]; then
exit 1
fi
# Unpack Kernel source
tar xf linux-${KERNEL_VER}.tar.xz
ln -s linux-${KERNEL_VER} linux
# Prevent git reset
sed -i 's|^git|#git|' build-kernel.sh
# ... Build Kernel
./build-kernel.sh
# Restore sanity
sed -i 's|^#git|git|' build-kernel.sh
git reset --hard
