# my98 application; the emulator remains a pinned, unmodified submodule.
.DEFAULT_GOAL := all
.PHONY: remote-test all emulator prepare-emulator run crypto crypto-test crypto-test-browser disk disk-test disk-test-browser test-stop
all: emulator crypto disk

prepare-emulator:
	python3 scripts/prepare-emulator.py

emulator: prepare-emulator
	$(MAKE) -C build/slop86 all build/v86-fallback.wasm

run:
	python3 slop86/tools/serve.py

crypto:
	sh crypto/scripts/build.sh

crypto-test:
	CARGO_TARGET_DIR="$(CURDIR)/build/crypto-target" cargo test --manifest-path crypto/Cargo.toml --locked --release -- --test-threads=2

crypto-test-browser: crypto
	sh crypto/scripts/test-browser.sh

node_modules/.package-lock.json: package.json package-lock.json
	npm ci

disk: node_modules/.package-lock.json
	sh disk/scripts/build.sh

disk-test:
	CARGO_TARGET_DIR="$(CURDIR)/build/disk-target" cargo test --manifest-path disk/Cargo.toml --locked --release

disk-test-browser: emulator disk
	CARGO_TARGET_DIR="$(CURDIR)/build/disk-target" cargo run --manifest-path disk/Cargo.toml --locked --release --example compat
	node disk/browser-tests/run.mjs

test-stop: prepare-emulator
	node tests/api/stop.js

remote-test: disk
	CARGO_TARGET_DIR="$(CURDIR)/build/disk-target" cargo run --manifest-path disk/Cargo.toml --locked --release --example compat
	node disk/browser-tests/remote-run.mjs

.PHONY: site site-test
site: all
	python3 scripts/package-site.py

site-test: site
	CARGO_TARGET_DIR="$(CURDIR)/build/disk-target" cargo build --manifest-path disk/Cargo.toml --locked --release --example compat
	node tests/pages/run.mjs
	node tests/pages/integration.mjs
