#!/bin/sh
CWD=$(pwd)
set -e

SRC=fastnetmon
if [ ! -d ${SRC} ]; then
    echo "Source directory does not exists, please 'git clone'"
    exit 1
fi

tar -czf fastnetmon_$(head -n 1 fastnetmon-debian-salsa/debian/changelog|awk '{print $2}'|sed 's/[()]//g' | sed -E 's/(\-[0-9]+)?$//').orig.tar.gz fastnetmon

cd ${SRC}
rm -rf debian && cp -a ../fastnetmon-debian-salsa/debian/ .

dpkg-buildpackage -uc -us -tc -b -d
