#!/bin/bash

# Copyright (C) 2020-2023 VyOS maintainers and contributors
#
# This program is free software; you can redistribute it and/or modify
# it under the terms of the GNU General Public License version 2 or later as
# published by the Free Software Foundation.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program.  If not, see <http://www.gnu.org/licenses/>.

# Stage 1 - install dependencies

# load common functions
. vyos_install_common.sh

echo "Configuring APT repositories"
prepare_apt

# Get list of VyOS packages
vyos_packages=(
    "vyatta-cfg-system"
    "vyatta-bash"
    "vyatta-op"
    "vyatta-cfg"
    "vyatta-wanloadbalance"
    "vyos-1x"
    )

# Do not analyze packages, which we do not need in Docker
vyos_packages_filter=(
    "vyos-intel*"
    )
vyos_packages_filtered=("$(filter_list vyos_packages[@] vyos_packages_filter[@])")
echo "Packages for dependency analyzing: ${vyos_packages_filtered[@]}"

# Get list of all dependencies
vyos_dependencies=(`apt-get -s install --no-install-recommends ${vyos_packages_filtered[@]} | awk '/Inst/ { printf("%s ", $2) }'`)

# Do not install unnecessary
ignore_list=(
    "dosfstools"
    "parted"
    "libparted*"
    "efibootmgr"
    "gdisk"
    "grub-*"
    "laptop-detect"
    "installation-report"
    "tshark"
    "wireshark*"
    "mdadm"
    "keepalived"
    "libheartbeat2"
    "bmon"
    "crda"
    "ipvsadm"
    "iw"
    "pptpd"
    "cluster-glue"
    "resource-agents"
    "heartbeat"
    "podman"
    )

# Get list of packages from VYOS repository
if ls /var/lib/apt/lists/*vyos*Packages* | grep -q gz$; then
    arch_cat="zcat"
fi
if ls /var/lib/apt/lists/*vyos*Packages* | grep -q lz4$; then
    arch_cat="lz4cat"
    echo "Installing lz4"
    apt-get install -y --no-install-recommends lz4
fi
vyos_repo_packages=(`$arch_cat /var/lib/apt/lists/*vyos*Packages* | awk '/Package:/ { printf("%s\n",$2) }'`)
if [[ "${arch_cat}" == "lz4cat" ]]; then
    echo "Removing lz4"
    apt-get purge -y lz4
fi
# Add them to ignore list - we do not need anything from VyOS in this layer of image
ignore_list=("${ignore_list[@]}" "${vyos_repo_packages[@]}")

# Remove every ignore list item from installation list
vyos_dependencies_filtered=("$(filter_list vyos_dependencies[@] ignore_list[@])")

# Add missed dependencies
vyos_dependencies_filtered+=(
    "liburi-perl"
    "locales"
    "libcap-ng0"
    "libnss-myhostname"
    "dbus"
    )

echo "Dependencies filtered list: ${vyos_dependencies_filtered[@]}"

# Install delependencies
echo "Installing dependencies"
apt-get install -y --no-install-recommends ${vyos_dependencies_filtered[@]}

echo "Deconfiguring APT repositories"
cleanup_apt


exit 0
