# my98 application; the emulator remains a pinned, unmodified submodule.
.DEFAULT_GOAL := all
.PHONY: hooks
hooks:
	git config --local core.hooksPath .githooks

.PHONY: seedbox-test seedbox-integration
seedbox-test:
	PYTHONDONTWRITEBYTECODE=1 python3 scripts/seedbox_test.py

seedbox-integration:
	PYTHONDONTWRITEBYTECODE=1 python3 scripts/seedbox_integration.py

.PHONY: prefetch-test remote-test all emulator prepare-emulator run crypto crypto-test crypto-test-browser disk disk-test disk-test-browser test-stop
all: emulator crypto disk

prepare-emulator:
	python3 scripts/prepare-emulator.py

emulator: prepare-emulator
	$(MAKE) -C build/slop86 all

run:
	python3 scripts/serve.py

crypto:
	sh src/crypto/scripts/build.sh

crypto-test:
	CARGO_TARGET_DIR="$(CURDIR)/build/crypto-target" cargo test --manifest-path src/crypto/Cargo.toml --locked --release -- --test-threads=2

crypto-test-browser: crypto
	sh src/crypto/scripts/test-browser.sh

node_modules/.package-lock.json: package.json package-lock.json
	npm ci

disk: node_modules/.package-lock.json
	sh src/disk/scripts/build.sh

disk-test:
	CARGO_TARGET_DIR="$(CURDIR)/build/disk-target" cargo test --manifest-path src/disk/Cargo.toml --locked --release

disk-test-browser: emulator disk
	CARGO_TARGET_DIR="$(CURDIR)/build/disk-target" cargo run --manifest-path src/disk/Cargo.toml --locked --release --example compat
	node src/disk/browser-tests/run.mjs

test-stop: prepare-emulator
	node tests/api/stop.js

.PHONY: parallel-test parallel-test-browser discovery-test discovery-test-browser resolution-test resolution-test-browser
parallel-test: node_modules/.package-lock.json
	node --test src/disk/scripts/parallel.test.mjs

parallel-test-browser: disk
	node scripts/run-browser-test.mjs tests/pages/parallel.mjs

discovery-test: disk
	node --test src/disk/scripts/discovery.test.mjs

discovery-test-browser: disk
	CARGO_TARGET_DIR="$(CURDIR)/build/disk-target" cargo run --manifest-path src/disk/Cargo.toml --locked --release --example compat
	node scripts/run-browser-test.mjs tests/pages/discovery.mjs

resolution-test: disk
	node --test src/disk/scripts/resolution.test.mjs

resolution-test-browser: site
	CARGO_TARGET_DIR="$(CURDIR)/build/disk-target" cargo build --manifest-path src/disk/Cargo.toml --locked --release --example compat
	node scripts/run-browser-test.mjs tests/pages/resolution.mjs

remote-test: disk
	CARGO_TARGET_DIR="$(CURDIR)/build/disk-target" cargo run --manifest-path src/disk/Cargo.toml --locked --release --example compat
	node src/disk/browser-tests/remote-run.mjs

# Uses only disposable fixtures and a local, offline Kubo gateway; requires nasm.
.PHONY: read-only-test
read-only-test: disk emulator
	CARGO_TARGET_DIR="$(CURDIR)/build/disk-target" cargo build --manifest-path src/disk/Cargo.toml --locked --release --example compat
	node scripts/run-browser-test.mjs src/disk/browser-tests/read-only-run.mjs

.PHONY: read-only-key-test
read-only-key-test: disk
	CARGO_TARGET_DIR="$(CURDIR)/build/disk-target" cargo run --manifest-path src/disk/Cargo.toml --locked --release --example compat
	node scripts/read-only-key-test.mjs

prefetch-test: disk
	node --test src/disk/scripts/range-profile.test.mjs
	node --test src/disk/scripts/boot-analysis.test.mjs
	CARGO_TARGET_DIR="$(CURDIR)/build/disk-target" cargo run --manifest-path src/disk/Cargo.toml --locked --release --example compat
	node src/disk/browser-tests/prefetch-run.mjs

.PHONY: site site-test site-test-clean
site-test-clean:
	python3 scripts/clean-site-test.py

site: all
	python3 scripts/package-site.py

site-test: site
	PYTHONDONTWRITEBYTECODE=1 python3 scripts/clean-site-test.test.py
	PYTHONDONTWRITEBYTECODE=1 python3 tests/server_test.py
	CARGO_TARGET_DIR="$(CURDIR)/build/disk-target" cargo run --manifest-path src/disk/Cargo.toml --locked --release --example compat
	node --test scripts/run-browser-test.test.mjs
	node --test src/disk/scripts/resolution.test.mjs
	node --test src/disk/scripts/discovery.test.mjs
	node --test src/disk/scripts/parallel.test.mjs
	node scripts/run-browser-test.mjs tests/pages/parallel.mjs
	node scripts/run-browser-test.mjs tests/pages/audio.mjs
	node scripts/run-browser-test.mjs tests/pages/run.mjs
	node scripts/run-browser-test.mjs tests/pages/login.mjs
	node scripts/run-browser-test.mjs tests/pages/empty-disk.mjs
	node scripts/run-browser-test.mjs tests/pages/integration.mjs
	node scripts/run-browser-test.mjs tests/pages/resolution.mjs
	node scripts/run-browser-test.mjs tests/pages/discovery.mjs
	node scripts/run-browser-test.mjs tests/pages/boot-analysis.mjs
	node scripts/run-browser-test.mjs tests/pages/media.mjs
	node scripts/run-browser-test.mjs tests/pages/mobile.mjs
	node scripts/run-browser-test.mjs tests/pages/direct-pointer.mjs
	node scripts/run-browser-test.mjs tests/pages/display.mjs
