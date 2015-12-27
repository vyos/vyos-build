# Copyright (C) 2015 VyOS maintainers and contributors
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
DEBIAN_MIRROR = 'http://ftp.nl.debian.org/debian/'

DEBIAN_DISTRIBUTION = 'jessie'

PBUILDER_CONFIG = os.path.join(BUILD_DIR, 'pbuilderrc')
PBUILDER_DIR = os.path.join(BUILD_DIR, 'pbuilder')
