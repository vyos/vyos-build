#!/usr/bin/env python3

from tomllib import loads as toml_loads
from requests import get
from pathlib import Path
from subprocess import run

def find_arch() -> str:
    tmp=run(['dpkg-architecture', '-q', 'DEB_HOST_ARCH'], capture_output=True)
    return tmp.stdout.decode().strip()

# dependency modifier
def add_depends(package_dir: str, package_name: str,
                depends: list[str]) -> None:
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
arch: str = find_arch()
defaults_file: str = Path('../../data/defaults.toml').read_text()
KERNEL_VER: str = toml_loads(defaults_file).get('kernel_version')
KERNEL_FLAVOR: str = toml_loads(defaults_file).get('kernel_flavor')
KERNEL_SRC: str = Path.cwd().as_posix() + '/linux'

# define variables
PACKAGE_NAME: str = 'jool'
PACKAGE_VERSION: str = '4.1.9+bf4c7e3669'
PACKAGE_DIR: str = f'{PACKAGE_NAME}-{PACKAGE_VERSION}'
SOURCES_ARCHIVE: str = 'jool-4.1.9+bf4c7e3669.tar.gz'
SOURCES_URL: str = f'https://github.com/NICMx/Jool/archive/7f08c42c615ed63cf0fdc1522d91aa0809f6d990.tar.gz'

# download sources
sources_archive = Path(SOURCES_ARCHIVE)
sources_archive.write_bytes(get(SOURCES_URL).content)

# prepare sources
debmake_cmd: list[str] = [
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
export KERNEL_DIR := {KERNEL_SRC}
PACKAGE_BUILD_DIR := debian/{PACKAGE_NAME}
KVER := {KERNEL_VER}-{KERNEL_FLAVOR}
MODULES_DIR := extra

# main packaging script based on dh7 syntax
%:
	dh $@

override_dh_clean:
	dh_clean --exclude=debian/{PACKAGE_NAME}.substvars

override_dh_prep:
	dh_prep --exclude=debian/{PACKAGE_NAME}.substvars

# override_dh_auto_clean:
# 	make -C src/mod clean

override_dh_auto_build:
	dh_auto_build $@
	make -C ${{KERNEL_DIR}} M=$$PWD/src/mod/common modules
	make -C ${{KERNEL_DIR}} M=$$PWD/src/mod/nat64 modules
	make -C ${{KERNEL_DIR}} M=$$PWD/src/mod/siit modules

override_dh_auto_install:
	dh_auto_install $@
	install -D -m 644 src/mod/common/jool_common.ko ${{PACKAGE_BUILD_DIR}}/lib/modules/${{KVER}}/${{MODULES_DIR}}/jool_common.ko
	install -D -m 644 src/mod/nat64/jool.ko ${{PACKAGE_BUILD_DIR}}/lib/modules/${{KVER}}/${{MODULES_DIR}}/jool.ko
	install -D -m 644 src/mod/siit/jool_siit.ko ${{PACKAGE_BUILD_DIR}}/lib/modules/${{KVER}}/${{MODULES_DIR}}/jool_siit.ko
	${{KERNEL_DIR}}/../sign-modules.sh ${{PACKAGE_BUILD_DIR}}/lib
'''
bild_rules = Path(f'{PACKAGE_DIR}/debian/rules')
bild_rules.write_text(build_rules_text)

# build a package
debuild_cmd: list[str] = ['debuild']
run(debuild_cmd, cwd=PACKAGE_DIR)
