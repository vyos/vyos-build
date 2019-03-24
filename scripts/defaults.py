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

PBUILDER_CONFIG = os.path.join(BUILD_DIR, 'pbuilderrc')
PBUILDER_DIR = os.path.join(BUILD_DIR, 'pbuilder')

LB_CONFIG_DIR = os.path.join(BUILD_DIR, 'config')
CHROOT_INCLUDES_DIR = os.path.join(LB_CONFIG_DIR, 'includes.chroot')

ARCHIVES_DIR = 'config/archives/'

VYOS_REPO_FILE = 'config/archives/vyos.list.chroot'
CUSTOM_REPO_FILE = 'config/archives/custom.list.chroot'
CUSTOM_PACKAGE_LIST_FILE = 'config/package-lists/custom.list.chroot'

DEFAULT_BUILD_FLAVOR = 'data/defaults.json'
