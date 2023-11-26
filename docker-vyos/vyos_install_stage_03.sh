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

# Stage 3 - tune the system

# load common functions
. vyos_install_common.sh

# Add config partition marker
mkdir -p /opt/vyatta/etc/config
touch /opt/vyatta/etc/config/.vyatta_config

# create folder for configuration mounting
ln -s /opt/vyatta/etc/config /config

# Delete SSH keys
rm -rf /etc/ssh/ssh_host_*

# Fix FUSE settings
sed -i 's/#user_allow_other/user_allow_other/g' /etc/fuse.conf

# Configure locale
sed -i 's/# en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/g' /etc/locale.gen
dpkg-reconfigure locales
update-locale LANG=en_US.UTF-8 LC_ALL=C

# Tune bash and environment settings
echo "source /etc/bash_completion" >> /root/.bashrc
sed -i 's/set $BASH_COMPLETION_ORIGINAL_V_VALUE/builtin set $BASH_COMPLETION_ORIGINAL_V_VALUE/g' /usr/share/bash-completion/bash_completion

# Run configuration hooks
echo "Running system configuration hooks"
hooks_list=(
    "18-enable-disable_services.chroot"
    "30-frr-configs.chroot"
    )
for hook in ${hooks_list[@]}; do
    if [[ -e /tmp/hooks/${hook} ]]; then
        echo "Running ${hook}"
        /tmp/hooks/${hook}
    fi
done

# Delete needless options from CLI
 CLI_DELETION=(
     "/opt/vyatta/share/vyatta-cfg/templates/container/"
     )
 rm -rf ${CLI_DELETION[@]}

exit 0
