#!/bin/sh
CWD=$(pwd)
set -e

SRC="strongswan/src/libcharon/plugins/vici/python"
if [ ! -d ${SRC} ]; then
    echo "Source directory does not exists, please 'git clone'"
    exit 1
fi

cd ${SRC}

mkdir -p debian

# Create control file
echo "I: create $SRC/debian/control"
cat <<EOF > debian/control
Source: strongswan
Section: python
Priority: optional
Maintainer: VyOS Package Maintainers <maintainers@vyos.net>
Build-Depends: debhelper (>= 9), python3, python3-setuptools
Standards-Version: 3.9.6

Package: python3-vici
Architecture: all
Depends: \${misc:Depends}, \${python3:Depends}
Description: Native Python interface for strongSwan's VICI protocol
EOF


# Create rules file
echo "I: create $SRC/rules"
cat <<EOF > debian/rules
#!/usr/bin/make -f

%:
	dh \$@ --with python3
EOF
# Make the rules file executable
chmod +x debian/rules

echo '10' > debian/compat

# Copy changelog
cp ../../../../../debian/changelog debian/


ls -la
pwd


echo "I: Build Debian Package"
dpkg-buildpackage -uc -us -tc -b -d

echo "I: copy packages"
cp ../*.deb  ../../../../../../
