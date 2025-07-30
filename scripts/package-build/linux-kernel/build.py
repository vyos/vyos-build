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
import sys
import toml
import os
import subprocess

from argparse import ArgumentParser
from pathlib import Path
from subprocess import run, CalledProcessError

# Relative path to defaults.toml
defaults_path = "../../../data/defaults.toml"


def ensure_dependencies(dependencies: list) -> None:
    """Ensure Debian build dependencies are met"""
    if not dependencies:
        print("I: No additional dependencies to install")
        return

    print("I: Ensure Debian build dependencies are met")
    run(['sudo', 'apt-get', 'update'], check=True)
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
        try:
            run(['git', 'clone', scm_url, str(repo_dir)], check=True)
            run(['git', 'checkout', commit_id], cwd=repo_dir, check=True)
        except CalledProcessError as e:
            print(f"Failed to clone or checkout: {e}")
            sys.exit(1)


def create_tarball(package_name, source_dir=None):
    """Creates a .tar.gz archive of the specified directory.

    Args:
        package_name (str): The name of the package. This will also be the name of the output tarball.
        source_dir (str, optional): The directory to be archived. If not provided, defaults to `package_name`.

    Raises:
        FileNotFoundError: If the specified `source_dir` does not exist.
        Exception: If an error occurs during tarball creation.

    Example:
        >>> create_tarball("linux-6.6.56")
        I: Tarball created: linux-6.6.56.tar.gz

        >>> create_tarball("my-package", "/path/to/source")
        I: Tarball created: my-package.tar.gz
    """
    # Use package_name as the source directory if source_dir is not provided
    source_dir = source_dir or package_name
    output_tarball = f"{package_name}.tar.gz"

    # Check if the source directory exists
    if not os.path.isdir(source_dir):
        raise FileNotFoundError(f"Directory '{source_dir}' does not exist.")

    # Create the tarball
    try:
        shutil.make_archive(base_name=output_tarball.replace('.tar.gz', ''), format='gztar', root_dir=source_dir)
        print(f"I: Tarball created: {output_tarball}")
    except Exception as e:
        print(f"I: Failed to create tarball for {package_name}: {e}")


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

        # Prepare the package if required
        #if package.get('prepare_package', False):
        #    prepare_package(repo_dir, package.get('install_data', ''))

        # Execute the build command
        if package['build_cmd'] == 'build_kernel':
            build_kernel(package['kernel_version'])
            create_tarball(f'{package["name"]}-{package["kernel_version"]}', f'linux-{package["kernel_version"]}')
        elif package['build_cmd'] == 'build_linux_firmware':
            build_linux_firmware(package['commit_id'], package['scm_url'])
            create_tarball(f'{package["name"]}-{package["commit_id"]}', f'{package["name"]}')
        elif package['build_cmd'] == 'build_accel_ppp':
            build_accel_ppp(package['commit_id'], package['scm_url'])
            create_tarball(f'{package["name"]}-{package["commit_id"]}', f'{package["name"]}')
        elif package['build_cmd'] == 'build_accel_ppp_ng':
            build_accel_ppp_ng(package['commit_id'], package['scm_url'])
            create_tarball(f'{package["name"]}-{package["commit_id"]}', f'{package["name"]}')
        elif package['build_cmd'] == 'build_intel_qat':
            build_intel_qat()
        elif package['build_cmd'] == 'build_intel_igb':
            build_intel(package['name'], package['commit_id'], package['scm_url'])
        elif package['build_cmd'] == 'build_intel_ixgbe':
            build_intel(package['name'], package['commit_id'], package['scm_url'])
        elif package['build_cmd'] == 'build_intel_ixgbevf':
            build_intel(package['name'], package['commit_id'], package['scm_url'])
        elif package['build_cmd'] == 'build_mellanox_ofed':
            build_mellanox_ofed()
        elif package['build_cmd'] == 'build_realtek_r8152':
            build_realtek_r8152()
        elif package['build_cmd'] == 'build_jool':
            build_jool()
        elif package['build_cmd'] == 'build_ipt_netflow':
            build_ipt_netflow(package['commit_id'], package['scm_url'])
        elif package['build_cmd'] == 'build_openvpn_dco':
            build_openvpn_dco(package['commit_id'], package['scm_url'])
            create_tarball(f'{package["name"]}-{package["commit_id"]}', f'{package["name"]}')
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


def build_accel_ppp_ng(commit_id, scm_url):
    """Build accel-ppp-ng"""
    repo_dir = Path('accel-ppp-ng')
    clone_or_update_repo(repo_dir, scm_url, commit_id)
    run(['./build-accel-ppp-ng.sh'], check=True)


def build_intel_qat():
    """Build Intel QAT"""
    run(['./build-intel-qat.sh'], check=True)


def build_intel(driver_name: str, commit_id: str, scm_url: str):
    """Build Intel driver from Git repository"""
    repo_dir = Path(f'ethernet-linux-{driver_name}')
    clone_or_update_repo(repo_dir, scm_url, commit_id)
    run(['./build-intel-nic.sh', driver_name], check=True)


def build_mellanox_ofed():
    """Build Mellanox OFED"""
    run(['sudo', './build-mellanox-ofed.sh'], check=True)


def build_realtek_r8152():
    """Build Realtek r8152"""
    run(['sudo', './build-realtek-r8152.py'], check=True)


def build_jool():
    """Build Jool"""
    run(['echo y | ./build-jool.py'], check=True, shell=True)

def build_ipt_netflow(commit_id, scm_url):
    """Build ipt_NETFLOW"""
    repo_dir = Path('ipt-netflow')
    clone_or_update_repo(repo_dir, scm_url, commit_id)
    run(['./build-ipt-netflow.sh'], check=True, shell=True)

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
    arg_parser.add_argument('--install-dependencies', '-i', help='Only install build dependencies', action='store_true')
    args = arg_parser.parse_args()

    # Load package configuration
    with open(args.config, 'r') as file:
        config = toml.load(file)

    # Extract defaults and packages
    with open(defaults_path, 'r') as file:
        defaults = toml.load(file)

    # Load global dependencies
    global_dependencies = config.get('dependencies', {}).get('packages', [])
    if global_dependencies:
        ensure_dependencies(global_dependencies)
        if args.install_dependencies:
            exit(0)

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
