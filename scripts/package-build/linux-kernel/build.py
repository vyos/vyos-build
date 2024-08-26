#!/usr/bin/env python3
#
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

import datetime
import glob
import shutil
import toml
import os
import subprocess

from argparse import ArgumentParser
from pathlib import Path
from subprocess import run, CalledProcessError


def ensure_dependencies(dependencies: list) -> None:
    """Ensure Debian build dependencies are met"""
    if not dependencies:
        print("I: No additional dependencies to install")
        return

    print("I: Ensure Debian build dependencies are met")
    run(['sudo', 'apt-get', 'install', '-y'] + dependencies, check=True)


def prepare_package(repo_dir: Path, install_data: str) -> None:
    """Prepare a package"""
    if not install_data:
        print("I: No install data provided, skipping package preparation")
        return

    install_file = repo_dir / 'debian/install'
    install_file.parent.mkdir(parents=True, exist_ok=True)
    install_file.write_text(install_data)
    print("I: Prepared package")


def clone_or_update_repo(repo_dir: Path, scm_url: str, commit_id: str) -> None:
    """Clone the repository if it does not exist, otherwise update it"""
    if repo_dir.exists():
        #run(['git', 'fetch'], cwd=repo_dir, check=True)
        run(['git', 'checkout', commit_id], cwd=repo_dir, check=True)
        #run(['git', 'pull'], cwd=repo_dir, check=True)
    else:
        run(['git', 'clone', scm_url, str(repo_dir)], check=True)
        run(['git', 'checkout', commit_id], cwd=repo_dir, check=True)


def build_package(package: dict, dependencies: list) -> None:
    """Build a package from the repository

    Args:
        package (dict): Package information
        dependencies (list): List of additional dependencies
    """
    timestamp = datetime.datetime.now().strftime('%Y%m%d%H%M%S')
    repo_name = package['name']
    repo_dir = Path(repo_name)

    try:
        # Clone or update the repository
        #clone_or_update_repo(repo_dir, package['scm_url'], package['commit_id'])

        # Ensure dependencies
        #ensure_dependencies(dependencies)

        # Prepare the package if required
        #if package.get('prepare_package', False):
        #    prepare_package(repo_dir, package.get('install_data', ''))

        # Execute the build command
        if package['build_cmd'] == 'build_kernel':
            build_kernel(package['kernel_version'])
        elif package['build_cmd'] == 'build_linux_firmware':
            build_linux_firmware(package['commit_id'], package['scm_url'])
        elif package['build_cmd'] == 'build_accel_ppp':
            build_accel_ppp(package['commit_id'], package['scm_url'])
        elif package['build_cmd'] == 'build_intel_qat':
            build_intel_qat()
        elif package['build_cmd'] == 'build_intel_ixgbe':
            build_intel_ixgbe()
        elif package['build_cmd'] == 'build_intel_ixgbevf':
            build_intel_ixgbevf()
        elif package['build_cmd'] == 'build_jool':
            build_jool()
        elif package['build_cmd'] == 'build_openvpn_dco':
            build_openvpn_dco(package['commit_id'], package['scm_url'])
        elif package['build_cmd'] == 'build_nat_rtsp':
            build_nat_rtsp(package['commit_id'], package['scm_url'])
        else:
            run(package['build_cmd'], cwd=repo_dir, check=True, shell=True)

    except CalledProcessError as e:
        print(f"Failed to build package {repo_name}: {e}")
    finally:
        # Clean up repository directory
        # shutil.rmtree(repo_dir, ignore_errors=True)
        pass


def cleanup_build_deps(repo_dir: Path) -> None:
    """Clean up build dependency packages"""
    try:
        if repo_dir.exists():
            for file in glob.glob(str(repo_dir / '*build-deps*.deb')):
                os.remove(file)
            print("Cleaned up build dependency packages")
    except Exception as e:
        print(f"Error cleaning up build dependencies: {e}")


def copy_packages(repo_dir: Path) -> None:
    """Copy generated .deb packages to the parent directory"""
    try:
        deb_files = glob.glob(str(repo_dir / '*.deb'))
        for deb_file in deb_files:
            shutil.copy(deb_file, repo_dir.parent)
        print("Copied generated .deb packages")
    except Exception as e:
        print(f"Error copying packages: {e}")


def merge_dicts(defaults, package):
    return {**defaults, **package}


def build_kernel(kernel_version):
    """Build the Linux kernel"""
    run(['gpg2', '--locate-keys', 'torvalds@kernel.org', 'gregkh@kernel.org'], check=True)
    run(['curl', '-OL', f'https://www.kernel.org/pub/linux/kernel/v6.x/linux-{kernel_version}.tar.xz'], check=True)
    run(['curl', '-OL', f'https://www.kernel.org/pub/linux/kernel/v6.x/linux-{kernel_version}.tar.sign'], check=True)
    # Using pipes to handle decompression and verification
    with subprocess.Popen(['xz', '-cd', f'linux-{kernel_version}.tar.xz'], stdout=subprocess.PIPE) as proc_xz:
        run(['gpg2', '--verify', f'linux-{kernel_version}.tar.sign', '-'], stdin=proc_xz.stdout, check=True)
    run(['tar', 'xf', f'linux-{kernel_version}.tar.xz'], check=True)
    os.symlink(f'linux-{kernel_version}', 'linux')
    run(['./build-kernel.sh'], check=True)


def build_linux_firmware(commit_id, scm_url):
    """Build Linux firmware"""
    repo_dir = Path('linux-firmware')
    clone_or_update_repo(repo_dir, scm_url, commit_id)
    run(['./build-linux-firmware.sh'], check=True)


def build_accel_ppp(commit_id, scm_url):
    """Build accel-ppp"""
    repo_dir = Path('accel-ppp')
    clone_or_update_repo(repo_dir, scm_url, commit_id)
    run(['./build-accel-ppp.sh'], check=True)


def build_intel_qat():
    """Build Intel QAT"""
    run(['./build-intel-qat.sh'], check=True)


def build_intel_ixgbe():
    """Build Intel IXGBE"""
    run(['./build-intel-ixgbe.sh'], check=True)


def build_intel_ixgbevf():
    """Build Intel IXGBEVF"""
    run(['./build-intel-ixgbevf.sh'], check=True)


def build_jool():
    """Build Jool"""
    run(['echo y | ./build-jool.py'], check=True, shell=True)


def build_openvpn_dco(commit_id, scm_url):
    """Build OpenVPN DCO"""
    repo_dir = Path('ovpn-dco')
    clone_or_update_repo(repo_dir, scm_url, commit_id)
    run(['./build-openvpn-dco.sh'], check=True)


def build_nat_rtsp(commit_id, scm_url):
    """Build RTSP netfilter helper"""
    repo_dir = Path('nat-rtsp')
    clone_or_update_repo(repo_dir, scm_url, commit_id)
    run(['./build-nat-rtsp.sh'], check=True)


if __name__ == '__main__':
    # Prepare argument parser
    arg_parser = ArgumentParser()
    arg_parser.add_argument('--config', default='package.toml', help='Path to the package configuration file')
    arg_parser.add_argument('--packages', nargs='+', help='Names of packages to build (default: all)', default=[])
    args = arg_parser.parse_args()

    # Load package configuration
    with open(args.config, 'r') as file:
        config = toml.load(file)

    # Extract defaults and packages
    defaults = config.get('defaults', {})
    packages = config['packages']

    # Filter packages if specific packages are specified in the arguments
    if args.packages:
        packages = [pkg for pkg in packages if pkg['name'] in args.packages]

    # Merge defaults into each package
    packages = [merge_dicts(defaults, pkg) for pkg in packages]

    for package in packages:
        dependencies = package.get('dependencies', {}).get('packages', [])

        # Build the package
        build_package(package, dependencies)

        # Clean up build dependency packages after build
        cleanup_build_deps(Path(package['name']))

        # Copy generated .deb packages to parent directory
        copy_packages(Path(package['name']))
