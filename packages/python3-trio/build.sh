#!/bin/sh -e

CWD=$(pwd)
SRC_DIR=trio

if [ ! -d $SRC_DIR ]; then
    echo "trio source directory does not exist, please 'git clone'"
    exit 1
fi

echo "I: Build python3-trio Debian Package"
cd $SRC_DIR
cp -r $CWD/debian .
dpkg-buildpackage -uc -us -tc -b -d
