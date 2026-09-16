#!/bin/sh
set -eu
crypto_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
repo_dir=$(CDPATH= cd -- "$crypto_dir/../.." && pwd)
export CARGO_TARGET_DIR="$repo_dir/build/crypto-target"
sh "$crypto_dir/scripts/build.sh"
cargo run --manifest-path "$crypto_dir/Cargo.toml" --locked --release --example compat > "$repo_dir/build/crypto/native.json"
node "$crypto_dir/browser-tests/run.mjs"
cargo run --manifest-path "$crypto_dir/Cargo.toml" --locked --release --example compat -- "$repo_dir/build/crypto/browser-output.json"
