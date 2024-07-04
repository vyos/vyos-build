#!/bin/sh
CWD=$(pwd)
set -e

SRC=net-snmp

if [ ! -d ${SRC} ]; then
    echo "Source directory does not exists, please 'git clone'"
    exit 1
fi

cd ${SRC}

PATCH_DIR=${CWD}/patches
if [ -d $PATCH_DIR ]; then
    echo "I: Apply SNMP patches not in main repository:"
    for patch in $(ls ${PATCH_DIR})
    do
        cp ${PATCH_DIR}/${patch} debian/patches
        echo ${patch} >> debian/patches/series
    done
fi

echo "I: Build Debian net-snmp Package"
# We need "|| true" to fix an issue wioth the make system
#make[2]: Leaving directory '/vyos/vyos-build/packages/net-snmp/net-snmp/snmplib'
#making clean in /vyos/vyos-build/packages/net-snmp/net-snmp/agent
#make[2]: Entering directory '/vyos/vyos-build/packages/net-snmp/net-snmp/agent'
#make[2]: *** No rule to make target 'clean'.  Stop.
dpkg-buildpackage -us -uc -tc -b || true
