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

# Stage 2 - install VyOS packages

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

# Add missed dependencies
vyos_packages_filtered+=(
    "uuid"
    "jq"
    "yq"
    "systemd"
    )

echo "Packages for installing: ${vyos_packages_filtered[@]}"
# Install VyOS packages
echo "Installing VyOS packages"
apt-get install -y --no-install-recommends ${vyos_packages_filtered[@]}

# Create VyOS version file
RELEASAE_TRAIN=$(tomlq --raw-output .release_train /tmp/defaults.toml)
apt-cache show vyos-1x | awk -v release_train=${RELEASAE_TRAIN} '{ if ($1 == "Version:") version = $2 } END { build_git = "unknown" ; built_by = "Sentrium S.L." ; built_on = strftime("%F %T UTC", systime(), utc) ; "uuid -v 4" | getline build_uuid ; printf("{\"version\": \"%s\", \"build_git\": \"%s\", \"built_on\": \"%s\", \"built_by\": \"%s\", \"build_uuid\": \"%s\", \"release_train\": \"%s\"}", version, build_git, built_on, built_by, build_uuid, release_train) }' | json_pp > /usr/share/vyos/version.json

# Delete what we do not need inside Docker image (this step makes packages database inconsistent)
echo "Deleting what is needless in containers"
dpkg -P --force-depends dosfstools efibootmgr yq jq gdisk grub-common grub-efi-amd64-bin initscripts installation-report laptop-detect libossp-uuid16 libparted2 libwireshark-data libwireshark5 mdadm parted tshark uuid
dpkg -l | awk '/linux-image-/ { system("dpkg -P --force-depends " $2) }'

# Delete documentation
rm -rf /usr/share/doc /usr/share/doc-base

echo "Deconfiguring APT repositories"
cleanup_apt


exit 0
