build_dir := build

.PHONY: all
all:
	@echo "Make what specifically?"
	@echo "The most common target is 'iso'"

.PHONY: prepare
prepare:
	@set -e
	@echo "Starting VyOS ISO image build"

	@scripts/check-build-env
	@scripts/check-config

	rm -rf build/config/*
	@scripts/live-build-config
	cp -r data/live-build-config/* build/config/

	@scripts/make-version-file

	@scripts/build-flavour

.PHONY: iso
.ONESHELL:
iso: clean prepare
	@set -e
	@echo "It's not like I'm building this specially for you or anything!"
	cd $(build_dir)
	lb build 2>&1 | tee build.log
	ln -nsf live-image-amd64.hybrid.iso vyos-`cat version`-`dpkg --print-architecture`.iso

.PHONY: prepare-package-env
.ONESHELL:
prepare-package-env:
	@set -e
	@scripts/pbuilder-config
	@scripts/pbuilder-setup

.PHONY: qemu
.ONESHELL:
qemu:
	@set -e
	@scripts/check-vm-build-env
	@scripts/build-qemu-image

.PHONY: vmware-ova
.ONESHELL:
vmware-ova:
	@set -e
	@scripts/check-vm-build-env
	@scripts/build-vmware-ova

.PHONY: clean
.ONESHELL:
clean:
	@set -e
	cd $(build_dir)
	lb clean

	rm -f config/binary config/bootstrap config/chroot config/common config/source
	rm -f build.log
	rm -f vyos-*.iso

.PHONY: purge
purge:
	rm -rf build/*
