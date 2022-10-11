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

# Relative to the repository directory

BUILD_DIR = 'build'
BUILD_CONFIG = os.path.join(BUILD_DIR, 'build-config.toml')

DEFAULTS_FILE = 'data/defaults.toml'

BUILD_TYPES_DIR = 'data/build-types'
BUILD_ARCHES_DIR = 'data/architectures'
BUILD_FLAVORS_DIR = 'data/build-flavors'

# Relative to the build directory

PBUILDER_CONFIG = 'pbuilderrc'
PBUILDER_DIR = 'pbuilder'

LB_CONFIG_DIR = 'config'

CHROOT_INCLUDES_DIR = 'config/includes.chroot'
ARCHIVES_DIR = 'config/archives/'

VYOS_REPO_FILE = 'config/archives/vyos.list.chroot'
VYOS_PIN_FILE = 'config/archives/release.pref.chroot'
CUSTOM_REPO_FILE = 'config/archives/custom.list.chroot'
PACKAGE_LIST_FILE = 'config/package-lists/custom.list.chroot'

LOCAL_PACKAGES_PATH = 'config/packages.chroot/'
