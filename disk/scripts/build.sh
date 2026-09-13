#!/bin/sh
set -eu
disk_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
repo_dir=$(CDPATH= cd -- "$disk_dir/.." && pwd)
export CARGO_TARGET_DIR="$repo_dir/build/disk-target"
bindgen="${WASM_BINDGEN:-$repo_dir/build/crypto-tools/bin/wasm-bindgen}"
if [ ! -x "$bindgen" ]; then
    printf '%s\n' 'Install the pinned build tool from the repository root:' 'cargo install wasm-bindgen-cli --version 0.2.100 --locked --root build/crypto-tools' >&2
    exit 1
fi
[ "$("$bindgen" --version)" = 'wasm-bindgen 0.2.100' ] || { printf '%s\n' 'wasm-bindgen 0.2.100 required' >&2; exit 1; }
cargo build --manifest-path "$disk_dir/Cargo.toml" --locked --release --target wasm32-unknown-unknown
mkdir -p "$repo_dir/build/disk/pkg" "$repo_dir/build/disk/web"
"$bindgen" --target web --out-dir "$repo_dir/build/disk/pkg" --out-name slop86_disk "$CARGO_TARGET_DIR/wasm32-unknown-unknown/release/slop86_disk.wasm"
cp "$disk_dir"/web/client.* "$repo_dir/build/disk/web/"
node "$disk_dir/scripts/bundle.mjs"
