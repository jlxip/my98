#!/usr/bin/env python3
"""Build pinned Aquatic in a private Linux prefix, without global installs."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request

RUST = {
    "version":"1.90.0",
    "date":"2025-09-18",
    "target":"x86_64-unknown-linux-gnu",
    "packages":{
        "rustc":"48c2a42de9e92fcae8c24568f5fe40d5734696a6f80e83cc6d46eef1a78f13c9",
        "cargo":"9853db03d68578a30972e2755c89c66aec035fec641cf8f3a7117c81eec2578d",
        "rust-std":"663f4ab7945b392d5e5294dec1b050a66820a20e86f084ec37eeb0f2f7ff5569"
    }
}


def obtain(url,digest,archive,target,folder):
    if not archive.exists():
        partial=archive.with_name(archive.name+".download")
        try:
            with urllib.request.urlopen(url,timeout=60) as source,partial.open("wb") as output:
                shutil.copyfileobj(source,output)
            partial.replace(archive)
        finally:partial.unlink(missing_ok=True)
    with archive.open("rb") as stream:actual=hashlib.file_digest(stream,"sha256").hexdigest()
    if actual!=digest:raise RuntimeError("Archive checksum mismatch: "+url)
    destination=target/folder
    if not destination.exists():
        with tempfile.TemporaryDirectory(prefix=".extract-",dir=target) as temporary:
            with tarfile.open(archive) as package:package.extractall(temporary,filter="data")
            Path(temporary,folder).rename(destination)
    return destination


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root",required=True,type=Path)
    parser.add_argument("--lock",type=Path,default=Path(__file__).resolve().parent.parent/"src/torrent/aquatic.lock.json")
    parser.add_argument("--prepare-only",action="store_true",help="Download and install private toolchain without compiling")
    parser.add_argument("--fixture",action="store_true",help="Record low-cost release profile for isolated compatibility fixtures")
    args=parser.parse_args()
    if platform.system()!="Linux" or platform.machine() not in ("x86_64","amd64"):
        parser.error("This pinned toolchain targets Linux x86_64")
    root=args.root.resolve()
    if root in (Path("/"),Path.home()):parser.error("Use a dedicated private directory")
    root.mkdir(parents=True,exist_ok=True)
    archives=root/"archives";archives.mkdir(exist_ok=True)
    sources=root/"sources";sources.mkdir(exist_ok=True)
    lock=json.loads(args.lock.read_text())
    source=obtain(lock["url"],lock["sha256"],archives/"aquatic.tar.gz",sources,"aquatic-"+lock["commit"])
    if hashlib.sha256((source/"Cargo.lock").read_bytes()).hexdigest()!=lock["cargoLockSha256"]:
        raise RuntimeError("Aquatic Cargo.lock checksum mismatch")
    # Aquatic uses SO_REUSEPORT without SO_REUSEADDR. Enable both so an
    # accepted WebSocket in TIME_WAIT does not block our exclusive preflight.
    socket_source=source/"crates/ws/src/workers/socket/mod.rs"
    original=socket_source.read_bytes()
    marker=b'    ::log::info!("setting SO_REUSEPORT on socket..");'
    addition=b'    socket.set_reuse_address(true).with_context(|| "socket: set reuse address")?;\n\n'
    if hashlib.sha256(original).hexdigest()=="53128dcc580f99b480e2451f1d09c608d53284431baf001fd7fff0fb5c2532a3":
        if original.count(marker)!=1:raise RuntimeError("Review the pinned Aquatic listener")
        socket_source.write_bytes(original.replace(marker,addition+marker))
    elif addition not in original or hashlib.sha256(original.replace(addition,b"",1)).hexdigest()!=            "53128dcc580f99b480e2451f1d09c608d53284431baf001fd7fff0fb5c2532a3":
        raise RuntimeError("Unexpected Aquatic listener source")
    socket_fix={"file":str(socket_source.relative_to(source)),
        "originalSha256":"53128dcc580f99b480e2451f1d09c608d53284431baf001fd7fff0fb5c2532a3",
        "sha256":hashlib.sha256(socket_source.read_bytes()).hexdigest(),"change":"SO_REUSEADDR for immediate restart after WebSocket close"}
    rust=root/"rust"
    for name,digest in RUST["packages"].items():
        folder=f"{name}-{RUST['version']}-{RUST['target']}"
        filename=folder+".tar.xz"
        package=obtain(f"https://static.rust-lang.org/dist/{RUST['date']}/{filename}",
            digest,archives/filename,sources,folder)
        marker=rust/("."+name+"-complete")
        if not marker.exists():
            subprocess.run(["sh",str(package/"install.sh"),"--prefix="+str(rust),"--disable-ldconfig"],check=True)
            marker.write_text(digest+"\n")
    env=os.environ.copy()
    env.update(PATH=str(rust/"bin")+os.pathsep+env["PATH"],RUSTC=str(rust/"bin/rustc"),
        CARGO_HOME=str(root/"cargo"),CARGO_TARGET_DIR=str(root/"target"),CARGO_BUILD_JOBS="1")
    if args.fixture:
        env.update(CARGO_PROFILE_RELEASE_OPT_LEVEL="1",CARGO_PROFILE_RELEASE_LTO="false",
            CARGO_PROFILE_RELEASE_DEBUG="0",CARGO_PROFILE_RELEASE_CODEGEN_UNITS="16")
    manifest={"aquatic":lock,"toolchain":RUST,"fixtureProfile":args.fixture,"preparedOnly":args.prepare_only}
    manifest["socketRestartFix"]=socket_fix
    if not args.prepare_only:
        # glommio's published crate already contains liburing, but its default
        # build script still invokes git submodule update. Point it at the exact
        # locked crate payload instead: no git executable or floating fetch.
        subprocess.run([str(rust/"bin/cargo"),"fetch","--locked","--target",RUST["target"]],
            cwd=source,env=env,check=True)
        candidates=list((root/"cargo/registry/src").glob("*/glommio-0.9.0/liburing"))
        if len(candidates)!=1 or not (candidates[0]/"configure").is_file():
            raise RuntimeError("Review the locked glommio/liburing source")
        env["GLOMMIO_LIBURING_DIR"]=str(candidates[0])
        manifest["liburing"]="Bundled in glommio0.9.0, verified by Cargo.lock crate checksum"
        subprocess.run([str(rust/"bin/cargo"),"build","--locked","--release","-p","aquatic_ws","--jobs","1"],cwd=source,env=env,check=True)
        prefix=root/"prefix/bin";prefix.mkdir(parents=True,exist_ok=True)
        shutil.copy2(root/"target/release/aquatic_ws",prefix/"aquatic_ws")
        (prefix/"aquatic_ws").chmod(0o755)
        manifest["binary"]=str(prefix/"aquatic_ws")
        manifest["binarySha256"]=hashlib.sha256((prefix/"aquatic_ws").read_bytes()).hexdigest()
    (root/"aquatic-build.json").write_text(json.dumps(manifest,indent=2)+"\n")


if __name__=="__main__":main()
