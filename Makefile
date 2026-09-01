SHELL := /bin/bash
build_dir := build

ARCH := $(shell dpkg-architecture -qDEB_HOST_ARCH)
ISO_PATH := $(build_dir)/live-image-$(ARCH).hybrid.iso

# scripts/check-qemu-install requires --uefi on arm64/aarch64 hosts; on
# amd64 it stays optional.
UEFI_FLAG := $(if $(filter arm64 aarch64,$(ARCH)),--uefi,)

# Common vCPU count for QEMU test targets, capped at the host's available CPUs
TEST_CPUS := $(shell printf '%s\n' "$$(nproc)" 4 | sort -n | head -n1)

# Common memory size (GB) for QEMU test targets: 8GB if the host has at
# least 10GB of RAM, otherwise 4GB
TEST_MEM := $(shell awk '/MemTotal/{if ($$2/1024/1024 >= 10) print 8; else print 4}' /proc/meminfo)

# Test targets forward extra CLI arguments (e.g. `make test -- --match foo`)
# to their scripts via $(MAKECMDGOALS). Those extra words are also goals as
# far as make is concerned, so without this they'd fall through to the `%:`
# flavor rule below and run build-vyos-image with garbage arguments.
TEST_TARGETS := test test-no-interfaces test-no-interfaces-no-vpp test-interfaces test-vpp testc testcvpp testraid testsb testtpm testifname test-ci-qcow2 test-image-update qemu-live test-suite
ifneq ($(filter $(TEST_TARGETS),$(firstword $(MAKECMDGOALS))),)
$(eval $(filter-out $(firstword $(MAKECMDGOALS)),$(MAKECMDGOALS)):;@:)
endif

.PHONY: all
all:
	@echo "Make what specifically?"
	@echo "The most common target is 'generic'"

%:
	./build-vyos-image $*

.PHONY: test
.ONESHELL:
test:
	scripts/check-qemu-install --debug --match="$(MATCH)" --smoketest --uefi --cpu $(TEST_CPUS) --memory $(TEST_MEM) --iso $(ISO_PATH) $(filter-out $@,$(MAKECMDGOALS))

.PHONY: test-no-interfaces
.ONESHELL:
test-no-interfaces:
	scripts/check-qemu-install --debug --smoketest --uefi --no-interfaces --cpu $(TEST_CPUS) --memory $(TEST_MEM) --huge-page-size 2M --huge-page-count 1800 --isolate-cpus 2-3 --iso $(ISO_PATH) $(filter-out $@,$(MAKECMDGOALS))

.PHONY: test-no-interfaces-no-vpp
.ONESHELL:
test-no-interfaces-no-vpp:
	scripts/check-qemu-install --debug --smoketest --uefi --no-interfaces --no-vpp --cpu $(TEST_CPUS) --memory $(TEST_MEM) --iso $(ISO_PATH) $(filter-out $@,$(MAKECMDGOALS))

.PHONY: test-interfaces
.ONESHELL:
test-interfaces:
	scripts/check-qemu-install --debug --match="interfaces_" --smoketest --uefi --cpu $(TEST_CPUS) --memory $(TEST_MEM) --iso $(ISO_PATH) $(filter-out $@,$(MAKECMDGOALS))

.PHONY: test-vpp
.ONESHELL:
test-vpp:
	scripts/check-qemu-install --debug --match="vpp" --smoketest --uefi --cpu $(TEST_CPUS) --memory $(TEST_MEM) --huge-page-size 2M --huge-page-count 1800 --isolate-cpus 2-3 --iso $(ISO_PATH) $(filter-out $@,$(MAKECMDGOALS))

.PHONY: testc
.ONESHELL:
testc:
	scripts/check-qemu-install --debug --match="!vpp" $(UEFI_FLAG) --cpu $(TEST_CPUS) --memory $(TEST_MEM) --configtest --iso $(ISO_PATH) $(filter-out $@,$(MAKECMDGOALS))

.PHONY: testcvpp
.ONESHELL:
testcvpp:
	scripts/check-qemu-install --debug --match="vpp" $(UEFI_FLAG) --cpu $(TEST_CPUS) --memory $(TEST_MEM) --huge-page-size 2M --huge-page-count 1800 --isolate-cpus 2-3 --configtest --iso $(ISO_PATH) $(filter-out $@,$(MAKECMDGOALS))

.PHONY: testraid
.ONESHELL:
testraid:
	scripts/check-qemu-install --debug $(UEFI_FLAG) --raid --iso $(ISO_PATH) $(filter-out $@,$(MAKECMDGOALS))

.PHONY: testsb
.ONESHELL:
testsb:
	scripts/check-qemu-install --debug --uefi --sbtest --iso $(ISO_PATH) $(filter-out $@,$(MAKECMDGOALS))

.PHONY: testtpm
.ONESHELL:
testtpm:
	scripts/check-qemu-install --debug $(UEFI_FLAG) --tpmtest --iso $(ISO_PATH) $(filter-out $@,$(MAKECMDGOALS))

.PHONY: testifname
.ONESHELL:
testifname:
	scripts/check-qemu-install --debug $(UEFI_FLAG) --ifnametest --iso $(ISO_PATH) $(filter-out $@,$(MAKECMDGOALS))

# Runs each test target as its own $(MAKE) invocation (rather than as
# prerequisites) so make aborts immediately on the first failing testcase
# instead of collecting failures across a parallel-eligible dependency list.
.PHONY: test-suite
test-suite:
	$(MAKE) test-interfaces
	$(MAKE) test-no-interfaces-no-vpp
	$(MAKE) testc
	$(MAKE) testcvpp
	$(MAKE) test-vpp
	$(MAKE) testraid
	$(MAKE) testifname
	$(MAKE) testtpm

.PHONY: test-ci-qcow2
.ONESHELL:
test-ci-qcow2:
	if [[ ! -n $$(ls -t build/*.qcow2 | head -n 1) ]]; then
		echo "Could not find any QCOW2 disk image"
		exit 1
	fi
	rm -f cloud-init-image-$(ARCH).qcow2 ; cp $$(ls -t build/*.qcow2 | head -n 1) cloud-init-image-$(ARCH).qcow2
	scripts/check-qemu-install --debug $(UEFI_FLAG) --cloud-init --disk cloud-init-image-$(ARCH).qcow2 $(filter-out $@,$(MAKECMDGOALS))

.PHONY: test-image-update
.ONESHELL:
test-image-update:
	scripts/check-qemu-install --debug $(UEFI_FLAG) --test-image-update --iso $(ISO_PATH) $(filter-out $@,$(MAKECMDGOALS))

.PHONY: qemu-live
.ONESHELL:
qemu-live:
	scripts/check-qemu-install --qemu-cmd $(UEFI_FLAG) --iso $(ISO_PATH) $(filter-out $@,$(MAKECMDGOALS))

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
	rm -rf build packer_build packer_cache testinstall-*.raw ci_data ci_seed.iso nested_iso_data nested_installer_payload.iso vyos-*.tar.xz

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
