#!/bin/bash

for i in packages/*; do if [ -d $i ]; then git submodule update --init $i; fi; done

if [ ! -f packages/linux-image-*-vyos_*.deb ]; then 
   echo "Rebuilding kernel"
   (cp packages/vyos-kernel;LOCALVERSION= make-kpkg --rootcmd fakeroot --initrd --append_to_version -amd64-vyos --revision=4.4.6-1+vyos1+current1 kernel_source kernel_debug kernel_headers kernel_manual kernel_doc kernel_image)
fi;

for i in packages/*; do
  if [ -d "$i" -a ! "$i" = "packages/vyos-kernel" -a ! -f ${i}*.deb ]; then
    echo "Rebuilding $i"
    (cd "$i"; dpkg-buildpackage -d -j3)
  fi
done
