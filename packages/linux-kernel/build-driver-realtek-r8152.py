#!/usr/bin/env python3

from json import loads as json_loads
from requests import get
from pathlib import Path
from subprocess import run


# dependency modifier
def add_depends(package_dir: str, package_name: str, depends) -> None:
    """Add dependencies to a package

    Args:
        package_dir (str): a directory where package sources are located
        package_name (str): a name of package
        depends (list[str]): a list of dependencies to add
    """
    depends_list: str = ', '.join(depends)
    depends_line: str = f'misc:Depends={depends_list}\n'

    substvars_file = Path(f'{package_dir}/debian/{package_name}.substvars')
    substvars_file.write_text(depends_line)


# find kernel version and source path
defaults_file: str = Path('../../data/defaults.json').read_text()
KERNEL_VER: str = json_loads(defaults_file).get('kernel_version')
KERNEL_FLAVOR: str = json_loads(defaults_file).get('kernel_flavor')
KERNEL_SRC: str = Path.cwd().as_posix() + '/linux'

# define variables
PACKAGE_NAME: str = 'vyos-drivers-realtek-r8152'
PACKAGE_VERSION: str = '2.16.3'
PACKAGE_DIR: str = f'{PACKAGE_NAME}-{PACKAGE_VERSION}'
SOURCES_ARCHIVE: str = 'r8152-2.16.3.tar.bz2'
SOURCES_URL: str = f'https://dev.packages.vyos.net/source-mirror/{SOURCES_ARCHIVE}'

# download sources
sources_archive = Path(SOURCES_ARCHIVE)
sources_archive.write_bytes(get(SOURCES_URL).content)

# prepare sources
debmake_cmd = [
    'debmake', '-e', 'support@vyos.io', '-f', 'VyOS Support', '-p',
    PACKAGE_NAME, '-u', PACKAGE_VERSION, '-a', SOURCES_ARCHIVE
]
run(debmake_cmd)

# add kernel to dependencies
add_depends(PACKAGE_DIR, PACKAGE_NAME,
            [f'linux-image-{KERNEL_VER}-{KERNEL_FLAVOR}'])

# configure build rules
build_rules_text: str = f'''#!/usr/bin/make -f
# config
export KERNELDIR := {KERNEL_SRC}
PACKAGE_BUILD_DIR := debian/{PACKAGE_NAME}
KVER := {KERNEL_VER}-{KERNEL_FLAVOR}
MODULES_DIR := updates/drivers/net/usb

# main packaging script based on dh7 syntax
%:
	dh $@  

override_dh_clean:
	dh_clean --exclude=debian/{PACKAGE_NAME}.substvars

override_dh_prep:
	dh_prep --exclude=debian/{PACKAGE_NAME}.substvars

override_dh_auto_clean:
	make clean

override_dh_auto_build:
	make modules

override_dh_auto_install:
	install -D -m 644 r8152.ko ${{PACKAGE_BUILD_DIR}}/lib/modules/${{KVER}}/${{MODULES_DIR}}/r8152.ko
	install -D -m 644 50-usb-realtek-net.rules ${{PACKAGE_BUILD_DIR}}/etc/udev/rules.d/50-usb-realtek-net.rules
'''
bild_rules = Path(f'{PACKAGE_DIR}/debian/rules')
bild_rules.write_text(build_rules_text)

# build a package
debuild_cmd = ['debuild']
run(debuild_cmd, cwd=PACKAGE_DIR)
