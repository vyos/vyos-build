SHELL := /bin/bash
build_dir := build

ARCH := $(shell dpkg-architecture -qDEB_HOST_ARCH)
ISO_PATH := $(build_dir)/live-image-$(ARCH).hybrid.iso

.PHONY: all
all:
	@echo "Make what specifically?"
	@echo "The most common target is 'generic'"

%:
	./build-vyos-image $*

.PHONY: test
.ONESHELL:
test:
	scripts/check-qemu-install --debug --match="$(MATCH)" --smoketest --uefi --cpu 4 --memory 8 --iso $(ISO_PATH) $(filter-out $@,$(MAKECMDGOALS))

.PHONY: test-no-interfaces
.ONESHELL:
test-no-interfaces:
	scripts/check-qemu-install --debug --smoketest --uefi --no-interfaces --cpu 4 --memory 8 --huge-page-size 2M --huge-page-count 1800 --isolate-cpus 2-3 --iso $(ISO_PATH) $(filter-out $@,$(MAKECMDGOALS))

.PHONY: test-no-interfaces-no-vpp
.ONESHELL:
test-no-interfaces-no-vpp:
	scripts/check-qemu-install --debug --smoketest --uefi --no-interfaces --no-vpp --iso $(ISO_PATH) $(filter-out $@,$(MAKECMDGOALS))

.PHONY: test-interfaces
.ONESHELL:
test-interfaces:
	scripts/check-qemu-install --debug --match="interfaces_" --smoketest --uefi --iso $(ISO_PATH) $(filter-out $@,$(MAKECMDGOALS))

.PHONY: test-vpp
.ONESHELL:
test-vpp:
	scripts/check-qemu-install --debug --match="vpp" --smoketest --uefi --cpu 4 --memory 8 --huge-page-size 2M --huge-page-count 1800 --isolate-cpus 2-3 --iso $(ISO_PATH) $(filter-out $@,$(MAKECMDGOALS))

.PHONY: testc
.ONESHELL:
testc:
	scripts/check-qemu-install --debug --match="!vpp" --cpu 2 --memory 7 --configtest --iso $(ISO_PATH) $(filter-out $@,$(MAKECMDGOALS))

.PHONY: testcvpp
.ONESHELL:
testcvpp:
	scripts/check-qemu-install --debug --match="vpp" --cpu 4 --memory 8 --huge-page-size 2M --huge-page-count 1800 --isolate-cpus 2-3 --configtest --iso $(ISO_PATH) $(filter-out $@,$(MAKECMDGOALS))

.PHONY: testraid
.ONESHELL:
testraid:
	scripts/check-qemu-install --debug --raid --iso $(ISO_PATH) $(filter-out $@,$(MAKECMDGOALS))

.PHONY: testsb
.ONESHELL:
testsb:
	scripts/check-qemu-install --debug --uefi --sbtest --iso $(ISO_PATH) $(filter-out $@,$(MAKECMDGOALS))

.PHONY: testtpm
.ONESHELL:
testtpm:
	scripts/check-qemu-install --debug --tpmtest --iso $(ISO_PATH) $(filter-out $@,$(MAKECMDGOALS))

.PHONY: test-ci-qcow2
.ONESHELL:
test-ci-qcow2:
	if [[ ! -n $$(ls -t build/*.qcow2 | head -n 1) ]]; then
		echo "Could not find any QCOW2 disk image"
		exit 1
	fi
	rm -f cloud-init-image-$(ARCH).qcow2 ; cp $$(ls -t build/*.qcow2 | head -n 1) cloud-init-image-$(ARCH).qcow2
	scripts/check-qemu-install --debug --cloud-init --disk cloud-init-image-$(ARCH).qcow2 $(filter-out $@,$(MAKECMDGOALS))

.PHONY: test-image-update
.ONESHELL:
test-image-update:
	scripts/check-qemu-install --debug --test-image-update --iso $(ISO_PATH) $(filter-out $@,$(MAKECMDGOALS))

.PHONY: qemu-live
.ONESHELL:
qemu-live:
	scripts/check-qemu-install --qemu-cmd --iso $(ISO_PATH) $(filter-out $@,$(MAKECMDGOALS))

.PHONY: oci
.ONESHELL:
oci:
	@scripts/iso-to-oci $(ISO_PATH)

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
	rm -rf build packer_build packer_cache testinstall-*.raw ci_data ci_seed.iso nested_iso_data nested_installer_payload.iso

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
