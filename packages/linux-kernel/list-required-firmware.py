#!/usr/bin/env python3
#
# Copyright (C) 2020 Daniil Baturin
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

import re
import os
import sys
import glob
import argparse
import subprocess

# Loads the kernel config -- only options set to y or m
def load_config(path):
    with open(path, 'r') as f:
        config = f.read()
    targets = re.findall(r'(.*)=(?:y|m)', config)
    return targets

# Finds subdir targets from the Makefile
# that are enabled by the kernel build config
def find_enabled_subdirs(config, makefile_path):
    try:
        with open(makefile_path, 'r') as f:
            makefile = f.read()
    except OSError:
        # Shouldn't happen due to the way collect_source_files()
        # calls this function.
        return []

    dir_stmts = re.findall(r'obj-\$\((.*)\)\s+\+=\s+(.*)/(?:\n|$)', makefile)
    subdirs = []

    for ds in dir_stmts:
        config_key, src_dir = ds

        if args.debug:
            print("Processing make targets from {0} ({1})".format(ds[1], ds[0]), file=sys.stderr)
        if config_key in config:
            subdirs.append(src_dir)
        elif args.debug:
            print("{0} is disabled in the config, ignoring {1}".format(ds[0], ds[1]), file=sys.stderr)

    return subdirs

# For filtering
def file_loads_firmware(file):
    with open(file, 'r') as f:
        source = f.read()
    if re.search(r'MODULE_FIRMWARE\((.*)\)', source):
        return True

# Find all source files that reference firmware
def collect_source_files(config, path):
    files = []

    makefile = os.path.join(path, "Makefile")

    # Find and process all C files in this directory
    # This is a compromise: sometimes there are single-file modules,
    # that in fact may be disabled in the config,
    # so this approach can create occasional false positives.
    c_files = glob.glob("{0}/*.c".format(path))
    files = list(filter(file_loads_firmware, c_files))

    # Now walk the subdirectories
    enabled_subdirs = find_enabled_subdirs(config, makefile)
    subdirs = glob.glob("{0}/*/".format(path))
    for d in subdirs:
        dir_name = d.rstrip("/")

        if os.path.exists(os.path.join(d, "Makefile")):
            # If there's a makefile, it's an independent module
            # or a high level dir
            if os.path.basename(dir_name) in enabled_subdirs:
                files = files + collect_source_files(config, d)
        else:
            # It's simply a subdirectory of the current module
            # Some modules, like iwlwifi, keep their firmware-loading files
            # in subdirs, so we have to handle this case
            c_files = glob.iglob("{0}/**/*.c".format(d), recursive=True)
            files += list(filter(file_loads_firmware, c_files))

    return files

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument("-s", "--source-dir", action="append", help="Kernel source directory to process", required=True)
    parser.add_argument("-c", "--kernel-config", action="store", help="Kernel configuration")
    parser.add_argument("-d", "--debug", action="store_true", help="Enable Debug output")
    parser.add_argument("-f", "--list-source-files", action="store_true", help="List source files that reference firmware and exit")
    args = parser.parse_args()

    if not args.kernel_config:
        args.kernel_config = ".config"

    config = load_config(args.kernel_config)

    # Collect source files that reference firmware
    for directory in args.source_dir:
        source_files = collect_source_files(config, directory)

    if args.list_source_files:
        for sf in source_files:
            print(sf)
    else:
        fw_files = []
        for sf in source_files:
            i_file = re.sub(r'\.c', r'.i', sf)
            res = subprocess.run(["make {0} 2>&1".format(i_file)], shell=True, capture_output=True)
            if res.returncode != 0:
                print("Failed to preprocess file {0}".format(sf), file=sys.stderr)
                print(res.stdout.decode(), file=sys.stderr)
            else:
                with open(i_file, 'r') as f:
                    source = f.read()
                    fw_statements = re.findall(r'__UNIQUE_ID_firmware.*"firmware"\s+"="\s+(.*);', source)
                    fw_files += list(map(lambda s: re.sub(r'(\s|")', r'', s), fw_statements))

        for fw in fw_files:
            print(fw)
