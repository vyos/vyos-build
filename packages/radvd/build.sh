#!/bin/sh
SRC=radvd
if [ ! -d $SRC ]; then
    echo "source directory $SRC does not exist!"
    echo "$ git clone https://github.com/radvd-project/radvd"
    exit 1
fi
cd $SRC

INSTALL_DIR=debian
if [ -d $INSTALL_DIR ]; then
    rm -rf $INSTALL_DIR
fi

./autogen.sh
./configure
make

install --directory debian/lib/systemd/system debian/usr/sbin
install --mode 0644 radvd.service debian/lib/systemd/system
install --strip --mode 0755 radvd debian/usr/sbin

# Version' field value 'v0.14-20-g613277f': version number does not start with digit
# "cut" first character from version string
fpm --input-type dir --output-type deb --name radvd \
    --version $(git describe --always | cut -c2- | tr _ -) --deb-compression gz \
    --maintainer "VyOS Package Maintainers <maintainers@vyos.net>" \
    --description "RADVD router advertisement daemon" \
    --license "RADVD" -C $INSTALL_DIR --package ..
