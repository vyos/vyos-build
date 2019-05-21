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
	@set -e
	@echo "It's not like I'm building this specially for you or anything!"
	cd $(build_dir)
	lb build 2>&1 | tee build.log
	cd ..
	@scripts/copy-image

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

.PHONY: vagrant-libvirt
.ONESHELL:
vagrant-libvirt:
	@set -e
	@scripts/check-vm-build-env
	@scripts/build-vagrant-libvirt-box

.PHONY: vmware
.ONESHELL:
vmware: clean prepare
	@set -e
	@echo "It's not like I'm building this specially for you or anything!"
	mkdir -p build/config/includes.chroot/etc/cloud/cloud.cfg.d
	cp tools/cloud-init/vmware/90_dpkg.cfg build/config/includes.chroot/etc/cloud/cloud.cfg.d/
	cp tools/cloud-init/cloud-init.list.chroot build/config/package-lists/
	cp -f tools/cloud-init/vmware/config.boot.default build/config/includes.chroot/opt/vyatta/etc/
	cd $(build_dir)
	@../scripts/build-vmware-image

.PHONY: hyperv
.ONESHELL:
hyperv:
	@set -e
	@scripts/check-vm-build-env
	@scripts/build-hyperv-image

.PHONY: clearfog
.ONESHELL:
clearfog: clean prepare
	@set -e
	@echo "It's not like I'm building this specially for you or anything!"
	cd $(build_dir)
	@../scripts/build-clearfog-image

.PHONY: azure
.ONESHELL:
azure: clean prepare
	@set -e
	@echo "It's not like I'm building this specially for you or anything!"
	cp tools/cloud-init/azure/99-walinuxagent.chroot build/config/hooks/live/
	cp tools/cloud-init/azure/vyos-azure.list.chroot build/config/package-lists/
	cp tools/cloud-init/cloud-init.list.chroot build/config/package-lists/
	cp -f tools/cloud-init/azure/config.boot.default build/config/includes.chroot/opt/vyatta/etc/
	cd $(build_dir)
	@../scripts/build-azure-image

.PHONY: GCE
.ONESHELL:
GCE: clean prepare
	@set -e
	@echo "It's not like I'm building this specially for you or anything!"
	mkdir -p build/config/includes.chroot/etc/cloud/cloud.cfg.d
	cp tools/cloud-init/GCE/90_dpkg.cfg build/config/includes.chroot/etc/cloud/cloud.cfg.d/
	cp tools/cloud-init/cloud-init.list.chroot build/config/package-lists/
	cp -f tools/cloud-init/GCE/config.boot.default build/config/includes.chroot/opt/vyatta/etc/
	cd $(build_dir)
	@../scripts/build-GCE-image

.PHONY: GCE-debug
.ONESHELL:
GCE-debug: clean prepare
	@set -e
	@echo "It's not like I'm building this specially for you or anything!"
	mkdir -p build/config/includes.chroot/etc/cloud/cloud.cfg.d
	cp tools/cloud-init/99-debug-user.chroot build/config/hooks/live/
	cp tools/cloud-init/GCE/90_dpkg.cfg build/config/includes.chroot/etc/cloud/cloud.cfg.d/
	cp tools/cloud-init/cloud-init.list.chroot build/config/package-lists/
	cp -f tools/cloud-init/GCE/config.boot.default-debug build/config/includes.chroot/opt/vyatta/etc/config.boot.default
	cd $(build_dir)
	@../scripts/build-GCE-image

.PHONY: AWS
.ONESHELL:
AWS: clean prepare
	@set -e
	@echo "It's not like I'm building this specially for you or anything!"
	mkdir -p build/config/includes.chroot/etc/cloud/cloud.cfg.d
	cp tools/cloud-init/AWS/90_dpkg.cfg build/config/includes.chroot/etc/cloud/cloud.cfg.d/
	cp tools/cloud-init/cloud-init.list.chroot build/config/package-lists/
	cp -f tools/cloud-init/AWS/config.boot.default build/config/includes.chroot/opt/vyatta/etc/
	cd $(build_dir)
	lb build 2>&1 | tee build.log
	cd ..
	@scripts/copy-image

.PHONY: openstack
.ONESHELL:
openstack: clean prepare
	@set -e
	@echo "It's not like I'm building this specially for you or anything!"
	mkdir -p build/config/includes.chroot/etc/cloud/cloud.cfg.d
	cp tools/cloud-init/openstack/90_dpkg.cfg build/config/includes.chroot/etc/cloud/cloud.cfg.d/
	cp tools/cloud-init/cloud-init.list.chroot build/config/package-lists/
	cp -f tools/cloud-init/openstack/config.boot.default build/config/includes.chroot/opt/vyatta/etc/
	cd $(build_dir)
	lb build 2>&1 | tee build.log
	cd ..
	@scripts/copy-image

.PHONY: oracle
.ONESHELL:
oracle: clean prepare
	@set -e
	@echo "It's not like I'm building this specially for you or anything!"
	mkdir -p build/config/includes.chroot/etc/cloud/cloud.cfg.d
	cp tools/cloud-init/OCI/90_dpkg.cfg build/config/includes.chroot/etc/cloud/cloud.cfg.d/
	cp tools/cloud-init/cloud-init.list.chroot build/config/package-lists/
	cp -f tools/cloud-init/OCI/config.boot.default build/config/includes.chroot/opt/vyatta/etc/
	cd $(build_dir)
	@../scripts/build-oracle-image

.PHONY: PACKET
.ONESHELL:
PACKET: clean prepare
	@set -e
	@echo "It's not like I'm building this specially for you or anything!"
	mkdir -p build/config/includes.chroot/etc/cloud/cloud.cfg.d
	cp tools/cloud-init/99-disable-networking.chroot build/config/hooks/live/
	cp tools/cloud-init/PACKET/90_dpkg.cfg build/config/includes.chroot/etc/cloud/cloud.cfg.d/
	cp tools/cloud-init/cloud-init.list.chroot build/config/package-lists/
	cp -f tools/cloud-init/PACKET/config.boot.default build/config/includes.chroot/opt/vyatta/etc/
	cd $(build_dir)
	lb build 2>&1 | tee build.log
	cd ..
	@scripts/copy-image

.PHONY: PACKET-debug
.ONESHELL:
PACKET-debug: clean prepare
	@set -e
	@echo "It's not like I'm building this specially for you or anything!"
	mkdir -p build/config/includes.chroot/etc/cloud/cloud.cfg.d
	cp tools/cloud-init/99-debug-user.chroot build/config/hooks/live/
	cp tools/cloud-init/99-disable-networking.chroot build/config/hooks/live/
	cp tools/cloud-init/PACKET/90_dpkg.cfg build/config/includes.chroot/etc/cloud/cloud.cfg.d/
	cp tools/cloud-init/cloud-init.list.chroot build/config/package-lists/
	cp -f tools/cloud-init/PACKET/config.boot.default-debug build/config/includes.chroot/opt/vyatta/etc/config.boot.default
	cd $(build_dir)
	lb build 2>&1 | tee build.log
	cd ..
	@scripts/copy-image

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
	rm -f *.vmdk

.PHONY: purge
purge:
	rm -rf build/*
