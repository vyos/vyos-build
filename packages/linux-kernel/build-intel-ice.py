#!/usr/bin/env python3

from json import loads as json_loads
from requests import get
from pathlib import Path
from subprocess import run

# define variables
DRIVER_VERSION: str = '1.11.14'
DRIVER_URL: str = f'https://downloads.sourceforge.net/project/e1000/ice%20stable/{DRIVER_VERSION}/ice-{DRIVER_VERSION}.tar.gz'
DRIVER_ARCHIVE: str = f'ice-{DRIVER_VERSION}.tar.gz'
DRIVER_DIR: str = f'vyos-drivers-intel-ice-{DRIVER_VERSION}'

# find kernel version ans source path
default_file: str = Path('../../data/defaults.json').read_text()
KERNEL_VER: str = json_loads(default_file).get('kernel_version')
KERNEL_SRC: str = Path.cwd().as_posix() + '/linux'

# download driver
driver_archive = Path(DRIVER_ARCHIVE)
driver_archive.write_bytes(get(DRIVER_URL).content)

# prepare sources
debmake_cmd = [
    'debmake', '-e', 'support@vyos.io', '-f', 'VyOS Support', '-p',
    'vyos-drivers-intel-ice', '-a', DRIVER_ARCHIVE
]
run(debmake_cmd)

# fix build rules
build_rules_text = f'''#!/usr/bin/make -f
# config
export KSRC := {KERNEL_SRC}
INSTALL_DIR := debian/vyos-drivers-intel-ice
DRIVER := ice
KVER := {KERNEL_VER}-amd64-vyos
KSRC_INSTALL := /lib/modules/${{KVER}}/build/
INTEL_DIR := updates/drivers/net/ethernet/intel
# DDP variables
DDP_PKG_ORIGIN := $(shell ls ddp/${{DRIVER}}-[[:digit:]]*\.[[:digit:]]*\.[[:digit:]]*\.[[:digit:]]*\.pkg 2>/dev/null)
DDP_PKG_NAME := $(shell basename ${{DDP_PKG_ORIGIN}} 2>/dev/null)
DDP_PKG_DEST_PATH := ${{INSTALL_DIR}}/lib/firmware/updates/intel/${{DRIVER}}/ddp
DDP_PKG_DEST := ${{DDP_PKG_DEST_PATH}}/${{DDP_PKG_NAME}}
DDP_PKG_LINK := ${{DRIVER}}.pkg

# main packaging script based on dh7 syntax
%:
	dh $@  

override_dh_auto_clean:
	cd src && \
	make clean

override_dh_auto_build:
	cd src && \
	make all

override_dh_auto_install:
	# DDP
	install -D -m 644 ${{DDP_PKG_ORIGIN}} ${{DDP_PKG_DEST}}
	(cd ${{DDP_PKG_DEST_PATH}} && ln -sf ${{DDP_PKG_NAME}} ${{DDP_PKG_LINK}})
	install -D -m 644 ddp/LICENSE ${{DDP_PKG_DEST_PATH}}/LICENSE
	# module
	install -D -m 644 src/${{DRIVER}}.ko ${{INSTALL_DIR}}/lib/modules/${{KVER}}/${{INTEL_DIR}}/ice/${{DRIVER}}.ko
	# AUX
	install -D -m 644 src/intel_auxiliary.ko ${{INSTALL_DIR}}/lib/modules/${{KVER}}/${{INTEL_DIR}}/auxiliary/intel_auxiliary.ko
	install -D -m 644 src/Module.symvers ${{INSTALL_DIR}}/lib/modules/${{KVER}}/extern-symvers/intel_auxiliary.symvers
	install -D -m 644 src/linux/auxiliary_bus.h ${{INSTALL_DIR}}/${{KSRC_INSTALL}}/include/linux/auxiliary_bus.h

'''
bild_rules = Path(f'{DRIVER_DIR}/debian/rules')
bild_rules.write_text(build_rules_text)

# build a package
debuild_cmd = ['debuild']
run(debuild_cmd, cwd=DRIVER_DIR)
