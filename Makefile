build_dir := build

.PHONY: all
all:
	@echo "Make what specifically?"
	@echo "The most common target is 'iso'"

.PHONY: prepare
prepare:
	set -e
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
iso: prepare
	set -e
	@echo "It's not like I'm building this specially for you or anything!"
	cd $(build_dir)
	lb build 2>&1 | tee build.log

.PHONY: prepare-package-env
.ONESHELL:
prepare-package-env:
	set -e
	@scripts/pbuilder-config
	@scripts/pbuilder-setup

.PHONY: clean
.ONESHELL:
clean:
	set -e
	cd $(build_dir)
	lb clean

	rm -f config/binary config/bootstrap config/chroot config/common config/source
	rm -f build.log

.PHONY: purge
purge:
	rm -rf build/*
