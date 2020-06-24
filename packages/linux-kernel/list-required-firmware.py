#!/usr/bin/env python3
# Copyright (C) 2020 VyOS maintainers and contributors
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

import argparse
import re
import os
import sys
import glob

def load_config(path):
    with open(path, 'r') as f:
        config = f.read()
    targets = re.findall(r'(.*)=(?:y|m)', config)
    return targets

def find_subdirs(config, path):
    try:
        with open(os.path.join(path, 'Makefile'), 'r') as f:
            makefile = f.read()
    except OSError:
        # No Makefile
        return []

    dir_stmts = re.findall(r'obj-\$\((.*)\)\s+\+=\s+(.*)(?:\n|$)', makefile)
    subdirs = []

    for ds in dir_stmts:
        if args.debug:
            print("Processing make targets from {0} ({1})".format(ds[1], ds[0]), file=sys.stderr)
        if ds[0] in config:
            dirname = os.path.dirname(ds[1])
            if dirname:
                subdirs.append(dirname)
        elif args.debug:
            print("{0} is disabled in the config, ignoring {1}".format(ds[0], ds[1]), file=sys.stderr)

    return subdirs


def find_firmware(file):
    with open(file, 'r') as f:
        source = f.read()
    fws = re.findall(r'MODULE_FIRMWARE\((.*)\)', source)
    return fws

def walk_dir(config, path):
    subdirs = find_subdirs(config, path)

    if args.debug:
        print("Looking for C files in {0}".format(path), file=sys.stderr)
    c_files = glob.glob("{0}/*.c".format(path))

    for cf in c_files:
        fws = find_firmware(cf)
        if fws:
            print(cf)
            if args.debug:
                print("Referenced firmware: {0}".format(fws))

    for d in subdirs:
        d = os.path.join(path, d)
        walk_dir(config, d)

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument("-s", "--source-dir", action="append", help="Kernel source directory")
    parser.add_argument("-k", "--kernel-dir", action="store", help="Kernel source directory")
    parser.add_argument("-c", "--kernel-config", action="store", help="Kernel configuration")
    parser.add_argument("-d", "--debug", action="store_true", help="Enable Debug output")
    args = parser.parse_args()

    if args.source_dir and args.kernel_dir and args.kernel_config:
        config = load_config(args.kernel_config)

        cwd = os.getcwd()
        os.chdir(f'{cwd}/{args.kernel_dir}')
        for directory in args.source_dir:
            walk_dir(config, directory)

    else:
        parser.print_help()
        sys.exit(1)

