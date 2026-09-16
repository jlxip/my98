#!/bin/sh
set -eu
crypto_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
repo_dir=$(CDPATH= cd -- "$crypto_dir/../.." && pwd)
output_dir="$repo_dir/build/crypto"
export CARGO_TARGET_DIR="$repo_dir/build/crypto-target"
mkdir -p "$output_dir/pkg" "$output_dir/web"
bindgen="${WASM_BINDGEN:-$repo_dir/build/crypto-tools/bin/wasm-bindgen}"
if [ ! -x "$bindgen" ]; then
    printf '%s\n' 'Install the pinned build tool:' 'cargo install wasm-bindgen-cli --version 0.2.100 --locked --root build/crypto-tools' >&2
    exit 1
fi
[ "$("$bindgen" --version)" = 'wasm-bindgen 0.2.100' ] || { printf '%s\n' 'wasm-bindgen 0.2.100 required' >&2; exit 1; }
cargo build --manifest-path "$crypto_dir/Cargo.toml" --locked --release --target wasm32-unknown-unknown
"$bindgen" --target web --out-dir "$output_dir/pkg" --out-name slop86_crypto "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/slop86_crypto.wasm"
cp "$crypto_dir/web/client.js" "$crypto_dir/web/worker.js" "$crypto_dir/web/client.d.ts" "$output_dir/web/"
printf 'Crypto module: %s\n' "$output_dir/web/client.js"
