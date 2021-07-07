SHELL := /bin/bash

build_dir := build

.PHONY: all
all:
	@echo "Make what specifically?"
	@echo "The most common target is 'iso'"

.PHONY: check_build_config
check_build_config:
	@scripts/check-config

.PHONY: prepare
prepare:
	@set -e
	@echo "Starting VyOS ISO image build"

	rm -rf build/config/*
	mkdir -p build/config
	cp -r data/live-build-config/* build/config/
	@scripts/live-build-config
	@scripts/import-local-packages

	@scripts/make-version-file

	@scripts/build-flavour

.PHONY: iso
.ONESHELL:
iso: check_build_config clean prepare
	@echo "It's not like I'm building this specially for you or anything!"
	cd $(build_dir)
	set -o pipefail
	lb build 2>&1 | tee build.log; if [ $$? -ne 0 ]; then exit 1; fi
	cd ..
	@scripts/copy-image
	exit 0

.PHONY: prepare-package-env
.ONESHELL:
prepare-package-env:
	@set -e
	@scripts/pbuilder-config
	@scripts/pbuilder-setup

.PHONY: AWS
.ONESHELL:
AWS: clean prepare
	@set -e
	@echo "It's not like I'm building this specially for you or anything!"
	mkdir -p build/config/includes.chroot/etc/cloud/cloud.cfg.d
	cp tools/cloud-init/AWS/90_dpkg.cfg build/config/includes.chroot/etc/cloud/cloud.cfg.d/
	cp tools/cloud-init/AWS/cloud-init.list.chroot build/config/package-lists/
	cp -f tools/cloud-init/AWS/config.boot.default build/config/includes.chroot/opt/vyatta/etc/
	cd $(build_dir)
	lb build 2>&1 | tee build.log
	cd ..
	@scripts/copy-image

.PHONY: vep4600
.ONESHELL:
vep4600: check_build_config clean prepare
	@set -e
	@echo "It's not like I'm building this specially for you or anything!"
	mkdir -p build/config/includes.chroot/etc/systemd/network
	mkdir -p build/config/includes.chroot/usr/share/initramfs-tools/hooks
	cp tools/dell/90-vep.chroot build/config/hooks/live/
	cp tools/dell/vep4600/*.link build/config/includes.chroot/etc/systemd/network/
	cp tools/dell/vep-hook build/config/includes.chroot/usr/share/initramfs-tools/hooks/
	cd $(build_dir)
	lb build 2>&1 | tee build.log
	cd ..
	@scripts/copy-image

.PHONY: vep1400
.ONESHELL:
vep1400: check_build_config clean prepare
	@set -e
	@echo "It's not like I'm building this specially for you or anything!"
	mkdir -p build/config/includes.chroot/etc/systemd/network
	mkdir -p build/config/includes.chroot/usr/share/initramfs-tools/hooks
	cp tools/dell/90-vep.chroot build/config/hooks/live/
	cp tools/dell/vep1400/*.link build/config/includes.chroot/etc/systemd/network/
	cp tools/dell/vep-hook build/config/includes.chroot/usr/share/initramfs-tools/hooks/
	cd $(build_dir)
	lb build 2>&1 | tee build.log
	cd ..
	@scripts/copy-image

.PHONY: test
.ONESHELL:
test:
	if [ ! -f build/live-image-amd64.hybrid.iso ]; then
		echo "Could not find build/live-image-amd64.hybrid.iso"
		exit 1
	fi
	scripts/check-qemu-install --debug build/live-image-amd64.hybrid.iso

.PHONY: testd
.ONESHELL:
testd:
	if [ ! -f build/live-image-amd64.hybrid.iso ]; then
		echo "Could not find build/live-image-amd64.hybrid.iso"
		exit 1
	fi
	scripts/check-qemu-install --debug --configd build/live-image-amd64.hybrid.iso

.PHONY: testc
.ONESHELL:
testc:
	if [ ! -f build/live-image-amd64.hybrid.iso ]; then
		echo "Could not find build/live-image-amd64.hybrid.iso"
		exit 1
	fi
	scripts/check-qemu-install --debug --configd --configtest build/live-image-amd64.hybrid.iso

.PHONY: clean
.ONESHELL:
clean:
	@set -e
	cd $(build_dir)
	lb clean

	rm -f config/binary config/bootstrap config/chroot config/common config/source
	rm -f build.log
	rm -f vyos-*.iso
	rm -f *.img
	rm -f *.xz
	rm -f *.vhd
	rm -f *.raw
	rm -f *.tar.gz
	rm -f *.qcow2
	rm -f *.mf
	rm -f *.ovf
	rm -f *.ova

.PHONY: purge
purge:
	rm -rf build packer_build packer_cache testinstall-*.img
