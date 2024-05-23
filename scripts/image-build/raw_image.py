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
# File: raw_image.py
# Purpose: Helper functions for building raw images.

import os
import sys
import shutil

import vyos.utils.process

import vyos.template

vyos.template.DEFAULT_TEMPLATE_DIR = os.path.join(os.getcwd(), 'build/vyos-1x/data/templates')

SQUASHFS_FILE = 'live/filesystem.squashfs'
VERSION_FILE = 'version.json'

from utils import cmd

def mkdir(path):
    os.makedirs(path, exist_ok=True)


class BuildContext:
    def __init__(self, iso_path, work_dir, debug=False):
        self.work_dir = work_dir
        self.iso_path = iso_path
        self.debug = debug
        self.loop_device = None

    def __enter__(self):
        print(f"I: Setting up a raw image build directory in {self.work_dir}")

        self.iso_dir = os.path.join(self.work_dir, "iso")
        self.squash_dir = os.path.join(self.work_dir, "squash")
        self.raw_dir = os.path.join(self.work_dir, "raw")
        self.efi_dir = os.path.join(self.work_dir, "efi")

        # Create mount point directories
        mkdir(self.iso_dir)
        mkdir(self.squash_dir)
        mkdir(self.raw_dir)
        mkdir(self.efi_dir)

        # Mount the ISO image
        cmd(f"""mount -t iso9660 -o ro,loop {self.iso_path} {self.iso_dir}""")

        # Mount the SquashFS image
        cmd(f"""mount -t squashfs -o ro,loop {self.iso_dir}/{SQUASHFS_FILE} {self.squash_dir}""")

        return self

    def __exit__(self, exc_type, exc_value, exc_tb):
        print(f"I: Tearing down the raw image build environment in {self.work_dir}")
        cmd(f"""umount {self.squash_dir}/dev/""")
        cmd(f"""umount {self.squash_dir}/proc/""")
        cmd(f"""umount {self.squash_dir}/sys/""")

        cmd(f"umount {self.squash_dir}/boot/efi")
        cmd(f"umount {self.squash_dir}/boot")

        cmd(f"""umount {self.squash_dir}""")
        cmd(f"""umount {self.iso_dir}""")
        cmd(f"""umount {self.raw_dir}""")
        cmd(f"""umount {self.efi_dir}""")

        if self.loop_device:
            cmd(f"""losetup -d {self.loop_device}""")

def create_disk(path, size):
    cmd(f"""qemu-img create -f raw "{path}" {size}G""")

def read_version_data(iso_dir):
    from json import load
    with open(os.path.join(iso_dir, VERSION_FILE), 'r') as f:
        data = load(f)
    return data

def setup_loop_device(con, raw_file):
    from subprocess import Popen, PIPE, STDOUT
    from re import match
    command = f'losetup --show -f {raw_file}'
    p = Popen(command, stderr=PIPE, stdout=PIPE, stdin=PIPE, shell=True)
    (stdout, stderr) = p.communicate()

    if p.returncode > 0:
        raise OSError(f"Could not set up a loop device: {stderr.decode()}")

    con.loop_device = stdout.decode().strip()
    if con.debug:
        print(f"I: Using loop device {con.loop_device}")

def mount_image(con):
    import vyos.system.disk

    from subprocess import Popen, PIPE, STDOUT
    from re import match

    vyos.system.disk.filesystem_create(con.disk_details.partition['efi'], 'efi')
    vyos.system.disk.filesystem_create(con.disk_details.partition['root'], 'ext4')

    cmd(f"mount -t ext4 {con.disk_details.partition['root']} {con.raw_dir}")
    cmd(f"mount -t vfat {con.disk_details.partition['efi']} {con.efi_dir}")

def install_image(con, version):
    from glob import glob

    vyos_dir = os.path.join(con.raw_dir, f'boot/{version}/')
    mkdir(vyos_dir)
    mkdir(os.path.join(vyos_dir, 'work/work'))
    mkdir(os.path.join(vyos_dir, 'rw'))

    shutil.copy(f"{con.iso_dir}/{SQUASHFS_FILE}", f"{vyos_dir}/{version}.squashfs")

    boot_files = glob(f'{con.squash_dir}/boot/*')
    boot_files = [f for f in boot_files if os.path.isfile(f)]

    for f in boot_files:
        print(f"I: Copying file {f}")
        shutil.copy(f, vyos_dir)

    with open(f"{con.raw_dir}/persistence.conf", 'w') as f:
        f.write("/ union\n")

def setup_grub_configuration(build_config, root_dir) -> None:
    """Install GRUB configurations

    Args:
        root_dir (str): a path to the root of target filesystem
    """
    from vyos.system import grub

    print('I: Installing GRUB configuration files')
    grub_cfg_main = f'{root_dir}/{grub.GRUB_DIR_MAIN}/grub.cfg'
    grub_cfg_vars = f'{root_dir}/{grub.CFG_VYOS_VARS}'
    grub_cfg_modules = f'{root_dir}/{grub.CFG_VYOS_MODULES}'
    grub_cfg_menu = f'{root_dir}/{grub.CFG_VYOS_MENU}'
    grub_cfg_options = f'{root_dir}/{grub.CFG_VYOS_OPTIONS}'

    # create new files
    vyos.template.render(grub_cfg_main, grub.TMPL_GRUB_MAIN, {})
    grub.common_write(root_dir)
    grub.vars_write(grub_cfg_vars, build_config["boot_settings"])
    grub.modules_write(grub_cfg_modules, [])
    grub.write_cfg_ver(1, root_dir)
    vyos.template.render(grub_cfg_menu, grub.TMPL_GRUB_MENU, {})
    vyos.template.render(grub_cfg_options, grub.TMPL_GRUB_OPTS, {})

def install_grub(con, version):
    from re import match
    from vyos.system import disk, grub

    # Mount the required virtual filesystems
    os.makedirs(f"{con.raw_dir}/boot/efi", exist_ok=True)
    cmd(f"mount --bind /dev {con.squash_dir}/dev")
    cmd(f"mount --bind /proc {con.squash_dir}/proc")
    cmd(f"mount --bind /sys {con.squash_dir}/sys")

    cmd(f"mount --bind {con.raw_dir}/boot {con.squash_dir}/boot")
    cmd(f"mount --bind {con.efi_dir} {con.squash_dir}/boot/efi")

    DIR_DST_ROOT = con.raw_dir

    setup_grub_configuration(con.build_config, DIR_DST_ROOT)
    # add information about version
    grub.create_structure(DIR_DST_ROOT)
    grub.version_add(version, DIR_DST_ROOT)
    grub.set_default(version, DIR_DST_ROOT)
    grub.set_console_type(con.build_config["boot_settings"]["console_type"], DIR_DST_ROOT)

    print('I: Installing GRUB to the disk image')
    grub.install(con.loop_device, f'/boot/', f'/boot/efi', chroot=con.squash_dir)

    # sort inodes (to make GRUB read config files in alphabetical order)
    grub.sort_inodes(f'{DIR_DST_ROOT}/{grub.GRUB_DIR_VYOS}')
    grub.sort_inodes(f'{DIR_DST_ROOT}/{grub.GRUB_DIR_VYOS_VERS}')


def create_raw_image(build_config, iso_file, work_dir):
    from vyos.system.disk import parttable_create

    if not os.path.exists(iso_file):
        print(f"E: ISO file {iso_file} does not exist in the build directory")
        sys.exit(1)

    with BuildContext(iso_file, work_dir, debug=True) as con:
        con.build_config = build_config
        version_data = read_version_data(con.iso_dir)
        version = version_data['version']
        raw_file = f"vyos-{version}-{build_config['build_flavor']}-{build_config['architecture']}.raw"
        print(f"I: Building raw file {raw_file}")
        create_disk(raw_file, build_config["disk_size"])
        setup_loop_device(con, raw_file)
        disk_details = parttable_create(con.loop_device, (int(build_config["disk_size"]) - 1) * 1024 * 1024)
        con.disk_details = disk_details
        mount_image(con)
        install_image(con, version)
        install_grub(con, version)

        return raw_file
