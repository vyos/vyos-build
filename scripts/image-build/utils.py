# Copyright (C) 2024 VyOS maintainers and contributors
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
# File: util.py
# Purpose:
#   Various common functions for use in build scripts.


import sys
import os
import shutil

# Local modules
import defaults
import vyos

def check_build_config():
    if not os.path.exists(defaults.BUILD_CONFIG):
        print("Build config file ({file}) does not exist".format(file=defaults.BUILD_CONFIG))
        print("If you are running this script by hand, you should better not. Run 'make iso' instead.")
        sys.exit(1)


class DependencyChecker(object):
    def __init__(self, spec):
        missing_packages = self._get_missing_packages(spec['packages'])
        missing_binaries = self._get_missing_binaries(spec['binaries'])
        self.__missing = {'packages': missing_packages, 'binaries': missing_binaries}


    def _package_installed(self, name):
        result = os.system("dpkg-query -W --showformat='${{Status}}\n' {name} 2>&1 | grep 'install ok installed' >/dev/null".format(name=name))
        return True if result == 0 else False

    def _get_missing_packages(self, packages):
        missing_packages = []
        for p in packages:
            if not self._package_installed(p):
                missing_packages.append(p)
        return missing_packages

    def _get_missing_binaries(self, binaries):
        missing_binaries = []
        for b in binaries:
            if not shutil.which(b):
                missing_binaries.append(b)
        return missing_binaries

    def get_missing_dependencies(self):
        if self.__missing['packages'] or self.__missing['binaries']:
            return self.__missing
        return None

    def format_missing_dependencies(self):
        msg = "E: There are missing system dependencies!\n"
        if self.__missing['packages']:
            msg += "E: Missing packages: " + " ".join(self.__missing['packages'])
        if self.__missing['binaries']:
            msg += "E: Missing binaries: " + " ".join(self.__missing['binaries'])
        return msg

def check_system_dependencies(deps):
    checker = DependencyChecker(deps)
    missing = checker.get_missing_dependencies()
    if missing:
        raise OSError(checker.format_missing_dependencies())
    else:
        pass

def cmd(command):
    res = vyos.utils.process.call(command, shell=True)
    if res > 0:
        raise OSError(f"Command '{command}' failed")

def rc_cmd(command):
    code, out = vyos.utils.process.rc_cmd(command, shell=True)
    if code > 0:
        raise OSError(f"Command '{command}' failed")
    else:
        return out
