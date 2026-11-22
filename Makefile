# my98 application; the emulator remains a pinned, unmodified submodule.
.DEFAULT_GOAL := all
.PHONY: hooks
hooks:
	git config --local core.hooksPath .githooks

.PHONY: prefetch-test all emulator prepare-emulator run crypto crypto-test crypto-test-browser disk disk-test disk-test-browser test-stop
all: emulator crypto disk

prepare-emulator:
	python3 scripts/prepare-emulator.py

emulator: prepare-emulator
	$(MAKE) -C build/slop86 all

run:
	python3 scripts/serve.py 8686

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
	$(MAKE) -C build/slop86 stop-test

prefetch-test: disk
	node --test src/disk/scripts/range-profile.test.mjs
	node --test src/disk/scripts/boot-analysis.test.mjs
	node --test src/disk/scripts/load-profiles.test.mjs

.PHONY: site site-test site-test-clean
site-test-clean:
	python3 scripts/clean-site-test.py

site: all
	python3 scripts/package-site.py

site-test: site
	node --test src/disk/scripts/range-profile.test.mjs src/disk/scripts/boot-analysis.test.mjs src/disk/scripts/load-profiles.test.mjs
	PYTHONDONTWRITEBYTECODE=1 python3 scripts/clean-site-test.test.py
	PYTHONDONTWRITEBYTECODE=1 python3 scripts/prepare-feedtorrent.test.py
	PYTHONDONTWRITEBYTECODE=1 python3 tests/prepare-emulator.test.py
	PYTHONDONTWRITEBYTECODE=1 python3 tests/server_test.py
	CARGO_TARGET_DIR="$(CURDIR)/build/disk-target" cargo run --manifest-path src/disk/Cargo.toml --locked --release --example compat
	node --test scripts/run-browser-test.test.mjs
	node --test tests/pages/server.test.mjs
	node scripts/run-browser-test.mjs tests/pages/audio.mjs
	node scripts/run-browser-test.mjs tests/pages/run.mjs
	node scripts/run-browser-test.mjs tests/pages/login.mjs
	node scripts/run-browser-test.mjs tests/pages/empty-disk.mjs
	node scripts/run-browser-test.mjs tests/pages/state-api.mjs
	node scripts/run-browser-test.mjs tests/pages/state-large.mjs
	node scripts/run-browser-test.mjs tests/pages/state.mjs
	node scripts/run-browser-test.mjs tests/pages/media.mjs
	node scripts/run-browser-test.mjs tests/pages/mobile.mjs
	node scripts/run-browser-test.mjs tests/pages/controls.mjs
	node --test tests/feedtorrent-protocol.test.mjs tests/torrent-state-queue.test.mjs tests/startup-prefetch.test.mjs tests/torrent-startup-window.test.mjs
	node scripts/run-browser-test.mjs tests/torrent-store.mjs
	node scripts/run-browser-test.mjs tests/feedtorrent-records.mjs
	node scripts/run-browser-test.mjs tests/feedtorrent-discovery.mjs
	node scripts/run-browser-test.mjs tests/torrent-ice.mjs
	node scripts/run-browser-test.mjs tests/pages/direct-pointer.mjs
	node scripts/run-browser-test.mjs tests/pages/display.mjs

.PHONY: state-test
.PHONY: agent-test
agent-test: site
	CARGO_TARGET_DIR="$(CURDIR)/build/disk-target" cargo build --manifest-path src/disk/Cargo.toml --locked --release --example compat
	node --test tests/agent.test.mjs
	node scripts/run-browser-test.mjs tests/agent-network.mjs
	node scripts/run-browser-test.mjs tests/agent-viewer.mjs

state-test: site
	CARGO_TARGET_DIR="$(CURDIR)/build/disk-target" cargo build --manifest-path src/disk/Cargo.toml --locked --release --example compat
	node scripts/run-browser-test.mjs tests/pages/state-api.mjs
	node scripts/run-browser-test.mjs tests/pages/state-large.mjs
	node scripts/run-browser-test.mjs tests/pages/state.mjs

.PHONY: relay relay-test
relay:
	CARGO_TARGET_DIR="$(CURDIR)/build/relay-target" cargo build --manifest-path src/relay/Cargo.toml --locked --release --jobs 1

relay-test:
	CARGO_TARGET_DIR="$(CURDIR)/build/relay-target" cargo test --manifest-path src/relay/Cargo.toml --locked
	node --test tests/relay-network.test.mjs
	node --test tests/relay-discovery.test.mjs
	PYTHONDONTWRITEBYTECODE=1 python3 tests/relay-deploy.test.py

# FeedTorrent source, native backend and the provisional publishing CLI.
.PHONY: torrent-native torrent-test torrent-integration-test
torrent-native:
	python3 scripts/prepare-feedtorrent.py
	CARGO_TARGET_DIR="$$PWD/build/torrent-target" sh -c 'cd build/feedtorrent && cargo build --manifest-path ../../src/torrent/Cargo.toml --locked --release'

torrent-test: torrent-native
	python3 tests/torrent-prompt.test.py build/torrent-target/release/my98-torrent
	CARGO_TARGET_DIR="$$PWD/build/torrent-target" sh -c 'cd build/feedtorrent && cargo test --manifest-path ../../src/torrent/Cargo.toml --locked'
	node --test tests/feedtorrent-protocol.test.mjs tests/torrent-state-queue.test.mjs tests/torrent-startup-window.test.mjs

torrent-integration-test: torrent-native site
	$(MAKE) -C build/feedtorrent build test-deps
	CARGO_TARGET_DIR="$(CURDIR)/build/disk-target" cargo build --manifest-path src/disk/Cargo.toml --locked --release --example compat
	BROWSER_TEST_TIMEOUT_MS=1800000 node scripts/run-browser-test.mjs tests/feedtorrent-integration.mjs
