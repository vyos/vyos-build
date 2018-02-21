# Copyright (C) 2018 VyOS maintainers and contributors
#
# This program is free software; you can redistribute it and/or modify
# it under the terms of the GNU General Public License version 2 or later as
# published by the Free Software Foundation.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program.  If not, see <http://www.gnu.org/licenses/>.
#
# File: defaults.py
# Purpose: Various default values for use in build scripts.


import os

BUILD_DIR = 'build'
BUILD_CONFIG = os.path.join(BUILD_DIR, 'build-config.json')

# The default mirror was chosen entirely at random
DEBIAN_MIRROR = 'http://deb.debian.org/debian'
DEBIAN_SECURITY_MIRROR = 'http://deb.debian.org/debian-security'

DEBIAN_DISTRIBUTION = 'jessie'

PBUILDER_CONFIG = os.path.join(BUILD_DIR, 'pbuilderrc')
PBUILDER_DIR = os.path.join(BUILD_DIR, 'pbuilder')

LB_CONFIG_DIR = os.path.join(BUILD_DIR, 'config')
CHROOT_INCLUDES_DIR = os.path.join(LB_CONFIG_DIR, 'includes.chroot')

VYOS_MIRROR = 'http://dev.packages.vyos.net/repositories/current/vyos'

VYOS_BRANCH = 'current'

VYOS_REPO_FILE = 'config/archives/vyos.list.chroot'
