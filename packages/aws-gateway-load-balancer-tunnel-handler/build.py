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

import os
import subprocess
import toml

def build_package(arch, version, source_dir):
    package_dir = f"aws-gwlbtun-{arch}"
    deb_name = f"aws-gwlbtun_{version}_{arch}.deb"

    # Navigate to the repository directory
    os.chdir(source_dir)

    # Build the binary
    subprocess.run(["cmake", f"-DARCH={arch}"])
    subprocess.run(["make"])

    # Create the Debian package directory structure
    os.makedirs(f"{package_dir}/DEBIAN", exist_ok=True)
    os.makedirs(f"{package_dir}/usr/bin", exist_ok=True)

    # Move the binary to the package directory
    subprocess.run(["cp", "gwlbtun", f"{package_dir}/usr/bin"])

    # Create the control file
    control_file = f"""Package: aws-gwlbtun
Version: {version}
Architecture: {arch}
Maintainer: VyOS Maintainers <autobuild@vyos.net>
Description: AWS Gateway Load Balancer Tunnel Handler
"""
    with open(f"{package_dir}/DEBIAN/control", "w") as f:
        f.write(control_file)

    # Build the Debian package
    subprocess.run(["dpkg-deb", "--build", package_dir])

    # Move the generated package to the original working directory with the correct name
    subprocess.run(["mv", f"{package_dir}.deb", f"../{deb_name}"])

    # Clean up
    subprocess.run(["make", "clean"])

    # Go back to the initial directory
    os.chdir("..")

def main():
    # Load configuration from TOML file
    config = toml.load("build_config.toml")
    version = config["version"]
    architectures = config["architectures"]
    source_dir = config.get("sourceDir", "aws-gateway-load-balancer-tunnel-handler")

    for arch in architectures:
        build_package(arch, version, source_dir)

if __name__ == "__main__":
    main()
