#!/bin/sh
CWD=$(pwd)
set -e

SRC=pam_tacplus
if [ ! -d ${SRC} ]; then
    echo "Source directory does not exists, please 'git clone'"
    exit 1
fi

cd ${SRC}
cp -a ../pam_tacplus-debian debian
rm -f debian/compat

dpkg-buildpackage -uc -us -tc -b -d
