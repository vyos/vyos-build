SHELL := /bin/bash

build_dir := build

.PHONY: all
all:
	@echo "Make what specifically?"
	@echo "The most common target is 'generic'"

%:
	./build-vyos-image $*

.PHONY: checkiso
.ONESHELL:
checkiso:
	if [ ! -f build/live-image-amd64.hybrid.iso ]; then
		echo "Could not find build/live-image-amd64.hybrid.iso"
		exit 1
	fi

.PHONY: test
.ONESHELL:
test: checkiso
	scripts/check-qemu-install --debug --configd --match="$(MATCH)" --uefi build/live-image-amd64.hybrid.iso

.PHONY: test-no-interfaces
.ONESHELL:
test-no-interfaces: checkiso
	scripts/check-qemu-install --debug --configd --match="$(MATCH)" --uefi --no-interfaces build/live-image-amd64.hybrid.iso

.PHONY: testc
.ONESHELL:
testc: checkiso
	scripts/check-qemu-install --debug --configd --configtest build/live-image-amd64.hybrid.iso

.PHONY: testraid
.ONESHELL:
testraid: checkiso
	scripts/check-qemu-install --debug --configd --raid --configtest build/live-image-amd64.hybrid.iso

.PHONY: qemu-live
.ONESHELL:
qemu-live: checkiso
	scripts/check-qemu-install --qemu-cmd build/live-image-amd64.hybrid.iso

.PHONE: oci
.ONESHELL:
oci: checkiso
	scripts/iso-to-oci build/live-image-amd64.hybrid.iso

.PHONY: testtpm
.ONESHELL:
testtpm: checkiso
	scripts/check-qemu-install --debug --tpmtest build/live-image-amd64.hybrid.iso

.PHONY: clean
.ONESHELL:
clean:
	@set -e
	mkdir -p $(build_dir)
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
