#!/usr/bin/env python3
#
# Copyright (C) 2023 VyOS maintainers and contributors
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

from argparse import ArgumentParser
from pathlib import Path
from subprocess import run
from sys import exit
from json import load as json_load


def check_args(args) -> bool:
    """Check command arguments

    Args:
        args (Namespace): Namespace with arguments

    Returns:
        bool: check result
    """
    sources_dir = Path(f'../{args.package}')
    if not sources_dir.exists():
        print(f'Sourced directory {sources_dir.as_posix()} does not exist')
        return False
    return True


# apply patches
def apply_patches(package_name: str) -> bool:
    """Apply patches to sources directory

    Args:
        package_name (str): package name (the same as sources directory)
    """
    patches_dir = Path(f'../patches/{package_name}')
    if patches_dir.exists():
        for patch_file in patches_dir.iterdir():
            patch_cmd: list[str] = [
                'git', '-c', 'user.email=support@vyos.io', '-c',
                'user.name=vyos', 'am',
                patch_file.as_posix()
            ]
            print(f'Applying patch: {patch_file.name}')
            if run(patch_cmd).returncode != 0:
                return False
    return True


def build_package(package_name: str) -> bool:
    """Build a package using commands from external file

    Args:
        package_name (str): package name

    Returns:
        bool: build status
    """
    build_config_path: str = f'../build_{package_name}.json'
    with open(build_config_path, 'r') as openfile:
        try:
            build_params = json_load(openfile)
        except Exception as err:
            print(f'Error parsing config file {build_config_path}: {err}')
            return False

    for cmd in build_params.get('build_commands', []):
        print(f'Building: {cmd}')
        if run(cmd).returncode != 0:
            return False

    return True


# build a package
if __name__ == '__main__':
    # prepare argument parser
    arg_parser = ArgumentParser()
    arg_parser.add_argument('--package',
                            required=True,
                            help='Package name to build')
    args = arg_parser.parse_args()

    if not check_args(args):
        exit(1)

    if not apply_patches(args.package):
        exit(1)

    if not build_package(args.package):
        exit(1)

    exit()
