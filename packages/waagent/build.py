#!/usr/bin/env python3

from pathlib import Path
from shutil import copy as copy_file
from subprocess import run


# copy patches
def apply_deb_patches() -> None:
    """Apply patches to sources directory
    """
    patches_dir = Path('../patches')
    current_dir: str = Path.cwd().as_posix()
    if patches_dir.exists():
        patches_list = list(patches_dir.iterdir())
        patches_list.sort()
        Path(f'{current_dir}/debian/patches').mkdir(parents=True, exist_ok=True)
        series_file = Path(f'{current_dir}/debian/patches/series')
        series_data = ''
        for patch_file in patches_list:
            print(f'Applying patch: {patch_file.name}')
            copy_file(patch_file, f'{current_dir}/debian/patches/')
            if series_file.exists():
                series_data: str = series_file.read_text()
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
