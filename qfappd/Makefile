# qfappd developer Makefile.
#
# Targets that need libndpi / a live kernel are marked; they run in the
# WSL/docker build container or on a QuartzFire target, not on a bare dev host.

CARGO ?= cargo

.PHONY: help
help:
	@echo "qfappd make targets:"
	@echo "  test              pure-logic unit tests (any platform: core + daemon logic)"
	@echo "  test-ndpi         full test suite WITH libndpi (needs headers under /usr/local)"
	@echo "  lint              cargo fmt --check + clippy -D warnings"
	@echo "  build             debug build (stub classifier; no libndpi)"
	@echo "  build-ndpi        release build with the real nDPI classifier"
	@echo "  deb               build qfappd_*.deb (via docker; see build-deb.sh)"
	@echo "  catalog           dump the nDPI catalog as JSON (needs build-ndpi)"
	@echo "  integration-test  netns+veth end-to-end test (needs root + libndpi)"
	@echo "  loadtest          synthetic new-flow load test (needs root + libndpi)"

# ── portable (no libndpi) ────────────────────────────────────────────────────
.PHONY: test
test:
	$(CARGO) test -p qfappd-core
	$(CARGO) test -p qfappd

.PHONY: lint
lint:
	$(CARGO) fmt --all --check
	$(CARGO) clippy --workspace --all-targets -- -D warnings

.PHONY: build
build:
	$(CARGO) build -p qfappd

# ── needs libndpi (>= 4.8 under /usr/local) ──────────────────────────────────
.PHONY: test-ndpi
test-ndpi:
	$(CARGO) test --features ndpi -p qfappd
	$(CARGO) test -p qfappd-core

.PHONY: build-ndpi
build-ndpi:
	$(CARGO) build --release --features ndpi -p qfappd

.PHONY: catalog
catalog: build-ndpi
	./target/release/qfappd catalog --json

# ── packaging ────────────────────────────────────────────────────────────────
.PHONY: deb
deb:
	./build-deb.sh

# ── on-target / privileged ───────────────────────────────────────────────────
.PHONY: integration-test
integration-test:
	sudo -E ./tests/integration/run.sh

.PHONY: loadtest
loadtest:
	sudo -E ./scripts/loadtest/run.sh
