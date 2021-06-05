#!/bin/sh
SRC=opennhrp
if [ ! -d $SRC ]; then
    echo "source directory $SRC does not exist!"
    echo "$ git clone https://git.code.sf.net/p/opennhrp/code opennhrp"
    exit 1
fi
cd $SRC

INSTALL_DIR=debian
if [ -d $INSTALL_DIR ]; then
    rm -rf $INSTALL_DIR
fi

make clean
make

install --directory debian/etc debian/usr/sbin
install --mode 0644 etc/racoon-ph1dead.sh debian/etc
install --mode 0644 etc/racoon-ph1down.sh debian/etc
install --strip --mode 0755 nhrp/opennhrp debian/usr/sbin
install --strip --mode 0755 nhrp/opennhrpctl debian/usr/sbin

fpm --input-type dir --output-type deb --name opennhrp \
    --version $(git describe --always) --deb-compression gz \
    --maintainer "VyOS Package Maintainers <maintainers@vyos.net>" \
    --description "NBMA Next Hop Resolution Protocol daemon" \
    --license "MIT" -C $INSTALL_DIR --package ..
