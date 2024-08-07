#!/bin/bash

export PATH=/opt/go/bin:$PATH

SRC=podman
if [ ! -d $SRC ]; then
    echo "source directory $SRC does not exist!"
    exit 1
fi

sudo apt-get install -y libseccomp-dev libgpgme-dev

cd $SRC

echo "I: installing dependencies"
make install.tools
echo "I: building podman"
make podman-release

tar xf podman-release-$(dpkg --print-architecture).tar.gz
# retrieve version number from podman archive folder: podman-v4.9.5/
# remove leading podman string
VERSION=$(ls -d podman-v* | cut -c9-)

fpm --input-type dir --output-type deb --name podman \
    --version $VERSION --deb-compression gz \
    --maintainer "VyOS Package Maintainers <maintainers@vyos.net>" \
    --description "Engine to run OCI-based containers in Pods" \
    --depends conmon --depends crun --depends netavark --depends libgpgme11 \
    --depends fuse-overlayfs --depends golang-github-containers-common \
    --license "Apache License 2.0" -C podman-v$VERSION --package ..

