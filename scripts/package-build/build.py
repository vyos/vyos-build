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

import glob
import shutil
import toml
import os

from argparse import ArgumentParser
from pathlib import Path
from subprocess import run, CalledProcessError


def ensure_dependencies(dependencies: list) -> None:
    """Ensure Debian build dependencies are met"""
    if not dependencies:
        print("I: No additional dependencies to install")
        return

    print("I: Ensure Debian build dependencies are met")
    run(['sudo', 'apt-get', 'update'], check=True)
    run(['sudo', 'apt-get', 'install', '-y'] + dependencies, check=True)


def apply_patches(repo_dir: Path, patch_dir: Path) -> None:
    """Apply patches from the patch directory to the repository"""
    if not patch_dir.exists() or not patch_dir.is_dir():
        print(f"I: Patch directory {patch_dir} does not exist, skipping patch application")
        return

    patches = sorted(patch_dir.glob('*'))
    if not patches:
        print(f"I: No patches found in {patch_dir}")
        return

    debian_patches_dir = repo_dir / 'debian/patches'
    debian_patches_dir.mkdir(parents=True, exist_ok=True)

    series_file = debian_patches_dir / 'series'
    with series_file.open('a') as series:
        for patch in patches:
            patch_dest = debian_patches_dir / patch.name
            shutil.copy(patch, patch_dest)
            series.write(patch.name + '\n')
            print(f"I: Applied patch: {patch.name}")


def prepare_package(repo_dir: Path, install_data: str) -> None:
    """Prepare a package"""
    if not install_data:
        print("I: No install data provided, skipping package preparation")
        return

    try:
        install_file = repo_dir / 'debian/install'
        install_file.parent.mkdir(parents=True, exist_ok=True)
        install_file.write_text(install_data)
        print("I: Prepared package")
    except Exception as e:
        print(f"Failed to prepare package: {e}")
        raise


def build_package(package: list, dependencies: list, patch_dir: Path) -> None:
    """Build a package from the repository

    Args:
        package (list): List of Packages from toml
        dependencies (list): List of additional dependencies
        patch_dir (Path): Directory containing patches
    """
    repo_name = package['name']
    repo_dir = Path(repo_name)

    try:
        # Clone the repository if it does not exist
        if not repo_dir.exists():
            run(['git', 'clone', package['scm_url'], str(repo_dir)], check=True)

        # Check out the specific commit
        run(['git', 'checkout', package['commit_id']], cwd=repo_dir, check=True)

        # Ensure dependencies
        ensure_dependencies(dependencies)

        # Apply patches if any
        if (repo_dir / 'patches'):
            apply_patches(repo_dir, patch_dir)

        # Prepare the package if required
        if package.get('prepare_package', False):
            prepare_package(repo_dir, package.get('install_data', ''))

        # Build dependency package and install it
        if (repo_dir / 'debian/control').exists():
            try:
                run('sudo mk-build-deps --install --tool "apt-get --yes --no-install-recommends"', cwd=repo_dir, check=True, shell=True)
                run('sudo dpkg -i *build-deps*.deb', cwd=repo_dir, check=True, shell=True)
            except CalledProcessError as e:
                print(f"Failed to build package {repo_name}: {e}")

        # Build the package, check if we have build_cmd in the package.toml
        try:
            build_cmd = package.get('build_cmd', 'dpkg-buildpackage -uc -us -tc -F')
            run(build_cmd, cwd=repo_dir, check=True, shell=True)
        except CalledProcessError as e:
            print(e)
            print("I: Source packages build failed, ignoring - building binaries only")
            build_cmd = package.get('build_cmd', 'dpkg-buildpackage -uc -us -tc -b')
            run(build_cmd, cwd=repo_dir, check=True, shell=True)

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
            print("I: Cleaned up build dependency packages")
    except Exception as e:
        print(f"Error cleaning up build dependencies: {e}")


def copy_packages(repo_dir: Path) -> None:
    """Copy generated .deb packages to the parent directory"""
    try:
        deb_files = glob.glob(str(repo_dir / '*.deb'))
        for deb_file in deb_files:
            shutil.copy(deb_file, repo_dir.parent)
            print(f'I: copy generated "{deb_file}" package')
    except Exception as e:
        print(f"Error copying packages: {e}")


if __name__ == '__main__':
    # Prepare argument parser
    arg_parser = ArgumentParser()
    arg_parser.add_argument('--config',
                            default='package.toml',
                            help='Path to the package configuration file')
    arg_parser.add_argument('--patch-dir',
                            default='patches',
                            help='Path to the directory containing patches')
    args = arg_parser.parse_args()

    # Load package configuration
    with open(args.config, 'r') as file:
        config = toml.load(file)

    packages = config['packages']
    patch_dir = Path(args.patch_dir)

    for package in packages:
        dependencies = package.get('dependencies', {}).get('packages', [])

        # Build the package
        build_package(package, dependencies, patch_dir)

        # Clean up build dependency packages after build
        cleanup_build_deps(Path(package['name']))

        # Copy generated .deb packages to parent directory
        copy_packages(Path(package['name']))
