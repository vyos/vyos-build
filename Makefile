SHELL := /bin/bash

arch ?= $(shell dpkg --print-architecture 2>/dev/null || echo amd64)
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
	if [ ! -f build/live-image-$(arch).hybrid.iso ]; then
		echo "Could not find build/live-image-$(arch).hybrid.iso"
		exit 1
	fi

.PHONY: test
.ONESHELL:
test: checkiso
	scripts/check-qemu-install --debug --configd --match="$(MATCH)" --smoketest --uefi --cpu 4 --memory 8 --iso build/live-image-amd64.hybrid.iso $(filter-out $@,$(MAKECMDGOALS))

.PHONY: test-no-interfaces
.ONESHELL:
test-no-interfaces: checkiso
	scripts/check-qemu-install --debug --configd --smoketest --uefi --no-interfaces --cpu 4 --memory 8 --huge-page-size 2M --huge-page-count 1800 --iso build/live-image-amd64.hybrid.iso

.PHONY: test-no-interfaces-no-vpp
.ONESHELL:
test-no-interfaces-no-vpp: checkiso
	scripts/check-qemu-install --debug --configd --smoketest --uefi --no-interfaces --no-vpp --arch $(arch) --iso build/live-image-$(arch).hybrid.iso

.PHONY: test-interfaces
.ONESHELL:
test-interfaces: checkiso
	scripts/check-qemu-install --debug --configd --match="interfaces_" --smoketest --uefi --iso build/live-image-amd64.hybrid.iso

.PHONY: test-vpp
.ONESHELL:
test-vpp: checkiso
	scripts/check-qemu-install --debug --configd --match="vpp" --smoketest --uefi --cpu 4 --memory 8 --huge-page-size 2M --huge-page-count 1800 --iso build/live-image-amd64.hybrid.iso

.PHONY: testc
.ONESHELL:
testc: checkiso
	scripts/check-qemu-install --debug --configd --match="!vpp" --cpu 2 --memory 7 --configtest --iso build/live-image-amd64.hybrid.iso $(filter-out $@,$(MAKECMDGOALS))

.PHONY: testcvpp
.ONESHELL:
testcvpp: checkiso
	scripts/check-qemu-install --debug --configd --match="vpp" --cpu 4 --memory 8 --huge-page-size 2M --huge-page-count 1800 --configtest --iso build/live-image-amd64.hybrid.iso $(filter-out $@,$(MAKECMDGOALS))

.PHONY: testraid
.ONESHELL:
testraid: checkiso
	scripts/check-qemu-install --debug --configd --raid --iso build/live-image-amd64.hybrid.iso $(filter-out $@,$(MAKECMDGOALS))

.PHONY: testsb
.ONESHELL:
testsb: checkiso
	scripts/check-qemu-install --debug --uefi --sbtest --iso build/live-image-amd64.hybrid.iso $(filter-out $@,$(MAKECMDGOALS))

.PHONY: testtpm
.ONESHELL:
testtpm: checkiso
	scripts/check-qemu-install --debug --tpmtest --iso build/live-image-amd64.hybrid.iso $(filter-out $@,$(MAKECMDGOALS))

.PHONY: test-ci-qcow2
.ONESHELL:
test-ci-qcow2:
	if [ ! -f build/*.qcow2 ]; then
		echo "Could not find any QCOW2 disk image"
		exit 1
	fi
	rm -f cloud-init-image-amd64.qcow2 ; cp $$(ls -t build/*.qcow2 | head -n 1) cloud-init-image-amd64.qcow2
	scripts/check-qemu-install --debug --cloud-init --disk cloud-init-image-amd64.qcow2 $(filter-out $@,$(MAKECMDGOALS))

.PHONY: qemu-live
.ONESHELL:
qemu-live: checkiso
	scripts/check-qemu-install --qemu-cmd --iso build/live-image-amd64.hybrid.iso $(filter-out $@,$(MAKECMDGOALS))

.PHONY: oci
.ONESHELL:
oci: checkiso
	scripts/iso-to-oci build/live-image-amd64.hybrid.iso

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
	rm -f *.img *.efivars
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
	rm -rf build packer_build packer_cache testinstall-*.raw ci_data ci_seed.iso

.PHONY: ansible-install ansible-check ansible-clean
.ONESHELL:

ANSIBLE_SCRIPT := ./scripts/ansible-install
VENV_DIR := .venv

ansible-install:
	@test -x $(ANSIBLE_SCRIPT) || chmod +x $(ANSIBLE_SCRIPT)
	$(ANSIBLE_SCRIPT)

ansible-check:
	@if [ -d $(VENV_DIR) ]; then
		. $(VENV_DIR)/bin/activate
		ansible --version
	else
		echo "Virtual environment not found. Run 'make ansible-install' first."
	fi

ansible-clean:
	@echo "Cleaning Ansible installation..."
	@rm -rf $(VENV_DIR)
	@echo "Done."
