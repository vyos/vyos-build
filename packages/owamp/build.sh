#!/bin/sh -x
CWD=$(pwd)
set -e

SRC=owamp

if [ ! -d ${SRC} ]; then
    echo "source directory does not exists, please 'git clone'"
    exit 1
fi

cd ${SRC}
echo "I: Retrieve version information from Git"
# Build owamp-client owamp-server twamp-client twamp-server
echo "I: Build VyOS owamp Packages"
dpkg-buildpackage -us -uc -tc -b
