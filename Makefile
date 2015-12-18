.PHONY: all
all:
	@echo "Make what specifically?"
	@echo "The most common target is 'iso'"

.PHONY: iso
iso:
	@echo "Starting VyOS ISO image build"

	@scripts/check-build-env
	@scripts/check-config

	@scripts/live-build-config
	cp -r data/includes.chroot/* build/config/includes.chroot/

	@echo "The rest is not yet implemented ;)"

	@echo "ISO build successful"
