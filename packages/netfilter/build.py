#!/usr/bin/env python3

from pathlib import Path
from shutil import copy as copy_file
from subprocess import run


# copy patches
def apply_deb_patches() -> None:
    """Apply patches to sources directory
    """
    package_dir: str = Path.cwd().name
    current_dir: str = Path.cwd().as_posix()
    patches_dir = Path(f'../patches/{package_dir}')
    patches_dir_dst = Path(f'{current_dir}/debian/patches')
    if not patches_dir_dst.exists():
        patches_dir_dst.mkdir(parents = True)
    if patches_dir.exists():
        patches_list = list(patches_dir.iterdir())
        patches_list.sort()
        series_file = Path(f'{patches_dir_dst.as_posix()}/series')
        if series_file.exists():
            series_data: str = series_file.read_text()
        else:

            series_data = ''
        for patch_file in patches_list:
            print(f'Applying patch: {patch_file.name}')
            copy_file(patch_file, f'{patches_dir_dst.as_posix()}')
            series_data = f'{series_data}\n{patch_file.name}'
        series_file.write_text(series_data)


def build_package() -> bool:
    """Build a package
    Returns:
        bool: build status
    """
    build_cmd: list[str] = ['dpkg-buildpackage', '-uc', '-us', '-tc', '-b']
    build_status: int = run(build_cmd).returncode

    if build_status:
        return False
    return True


# build a package
if __name__ == '__main__':
    apply_deb_patches()

    if not build_package():
        exit(1)

    exit()

