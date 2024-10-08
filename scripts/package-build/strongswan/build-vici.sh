#!/bin/sh
CWD=$(pwd)
set -e

SRC="strongswan/src/libcharon/plugins/vici/python"
if [ ! -d ${SRC} ]; then
    echo "Source directory does not exist, please 'git clone'"
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
echo "I: create $SRC/debian/rules"
cat <<EOF > debian/rules
#!/usr/bin/make -f

%:
	dh \$@ --with python3
EOF
chmod +x debian/rules

echo '10' > debian/compat

# Add the 'install' file to copy the vici package to the correct directory
echo "I: create $SRC/debian/install"
cat <<EOF > debian/install
vici /usr/lib/python3/dist-packages/
EOF

# Copy changelog
cp ../../../../../debian/changelog debian/

# Build the package
echo "I: Build Debian Package"
dpkg-buildpackage -uc -us -tc -b -d

# Copy the resulting .deb packages
echo "I: copy packages"
cp ../*.deb ../../../../../../
