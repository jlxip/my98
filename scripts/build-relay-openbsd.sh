#!/bin/sh
# Native, unprivileged build. System dependencies must already be installed.
set -eu
[ "$(uname -s)" = OpenBSD ] || { echo 'Run natively on OpenBSD' >&2; exit 1; }
[ "$(id -u)" -ne 0 ] || { echo 'Build as an ordinary user, install separately with doas' >&2; exit 1; }
for tool in cargo cc pkg-config meson ninja curl python3; do
    command -v "$tool" >/dev/null || { echo "Missing $tool; install rust meson ninja glib2" >&2; exit 1; }
done
pkg-config --exists glib-2.0
task_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
task_build="$task_root/build/relay-openbsd"
mkdir -p "$task_build"
archive="$task_build/libslirp-v4.9.5.tar.gz"
if [ ! -f "$archive" ]; then
    curl --fail --location --proto '=https' --tlsv1.2 \
        https://gitlab.freedesktop.org/slirp/libslirp/-/archive/v4.9.5/libslirp-v4.9.5.tar.gz -o "$archive"
fi
python3 - "$archive" <<'PY'
import hashlib,sys
from pathlib import Path
assert hashlib.sha256(Path(sys.argv[1]).read_bytes()).hexdigest()=='f43e68b60b580647574ec4a0e2b6c600a56281e6c39f79426510832dc810f483', 'Invalid libslirp source checksum'
PY
if [ ! -d "$task_build/libslirp-v4.9.5" ]; then tar -xzf "$archive" -C "$task_build"; fi
if [ ! -d "$task_build/slirp-build" ]; then
    meson setup "$task_build/slirp-build" "$task_build/libslirp-v4.9.5" \
        --prefix="$task_build/slirp-native" --libdir=lib --buildtype=release -Ddefault_library=shared
fi
ulimit -d 1048576
ninja -C "$task_build/slirp-build" -j 1
meson install -C "$task_build/slirp-build"
export PKG_CONFIG_PATH="$task_build/slirp-native/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
export CARGO_TARGET_DIR="$task_build/target"
export RUSTFLAGS='-C link-arg=-Wl,-rpath,/usr/local/lib/my98-relay/slirp/lib'
cargo build --manifest-path "$task_root/src/relay/Cargo.toml" --locked --release --jobs 1
LD_LIBRARY_PATH="$task_build/slirp-native/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
    cargo test --manifest-path "$task_root/src/relay/Cargo.toml" --locked --jobs 1
echo "Binary: $task_build/target/release/my98-relay"
echo "Libraries: $task_build/slirp-native/lib"
echo 'Native service, supervisor and WSS acceptance are required before activation.'
