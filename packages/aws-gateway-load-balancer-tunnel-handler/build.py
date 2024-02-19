#!/usr/bin/env python3

from argparse import ArgumentParser
from pathlib import Path
from subprocess import run


def prepare_package() -> None:
    """Prepare a package
    """
    install_file = Path('./debian/install')
    install_data = 'obj-*-linux-gnu/gwlbtun usr/sbin'
    install_file.touch()
    install_file.write_text(install_data)


def build_package(package_name: str, package_ver: str) -> bool:
    """Build a package using commands from external file

    Args:
        package_name (str): package name
        package_ver (str): package version

    Returns:
        bool: build status
    """
    # prepare sources
    debmake_cmd = [
        'debmake', '-e', 'support@vyos.io', '-f', 'VyOS Support', '-p',
        package_name, '-u', package_ver, '-t'
    ]
    run(debmake_cmd)

    prepare_package()

    # build a package
    run('debuild')

    return True


# build a package
if __name__ == '__main__':
    # prepare argument parser
    arg_parser = ArgumentParser()
    arg_parser.add_argument('--package',
                            required=True,
                            help='Package name to build')
    arg_parser.add_argument('--version',
                            required=True,
                            help='Version for the package')
    args = arg_parser.parse_args()

    if not build_package(args.package, args.version):
        exit(1)

    exit()
