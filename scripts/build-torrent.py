#!/usr/bin/env python3
"""Build pinned libtorrent and Boost.Python in a private prefix; never use sudo."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import runpy
import shutil
import subprocess
import sys
import sysconfig
import tarfile
import tempfile
import urllib.request

SOURCES = {
    "boost": ("https://archives.boost.io/release/1.92.0/source/boost_1_92_0.tar.bz2", "5c1d40cb8e19adbf740a4ec2da35b3e58f3f5804b1dce44deb53df72193cbc6c", "boost_1_92_0"),
    "libtorrent": ("https://github.com/arvidn/libtorrent/releases/download/v2.1.2/libtorrent-rasterbar-2.1.2.tar.gz", "3362546d9cd71b9e49ee6cac7d3f1f914ce9cdb217c86b63d5b22cbed0334dbc", "libtorrent-rasterbar-2.1.2"),
}


ICE_TRANSFORM = {'name': 'webtorrent-ice-udp-port', 'sha256': 'e2ab825bd3003cbdbd4b885d5fb668b1ea3c93357aad38f352b4afa6ada89ee2', 'files': {'include/libtorrent/settings_pack.hpp': {'before': 'f4907af713a1632cbc4286acac2f15742a8bc842539d759d93ba9cc05b24cd3e', 'after': '62337e41eb67a56c4365352143cc4444a18fd1df7fa16154762c6ac6248bbe01'}, 'src/settings_pack.cpp': {'before': 'ebba4f2fb56101e6ff425350d008bf61b30282a16b614a85ad7adbfc1195f07a', 'after': '4ccb75f1a1923dd1d59cea3610dc5f9f4da9de2be9a5e81b80fcb9cec2a87a0d'}, 'src/rtc_signaling.cpp': {'before': '16058554f3d04a5532275e63c18da610ba22091d038c35145015fb4310b18308', 'after': '7b8ff1263da4ea20f5fd91c3ad17b96218784db9130cef1e3e830c34bb8e6c72'}}}

BUILD_ENV = os.environ.copy()

def file_digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def apply_native_transform(root, source, transformations):
    transformer = transformations / "webtorrent_ice_udp_port.py"
    if file_digest(transformer) != ICE_TRANSFORM["sha256"]:
        raise RuntimeError("Native transformer checksum mismatch")
    marker = root / "native-source-transform.json"
    if marker.exists() and json.loads(marker.read_text()) != ICE_TRANSFORM:
        raise RuntimeError("Native build cache belongs to a different source transformation")
    actual = {name:file_digest(source/name) for name in ICE_TRANSFORM["files"]}
    before = {name:value["before"] for name,value in ICE_TRANSFORM["files"].items()}
    after = {name:value["after"] for name,value in ICE_TRANSFORM["files"].items()}
    if marker.exists() and actual == before:
        raise RuntimeError("Native sources were reverted underneath the transformation marker")
    runpy.run_path(str(transformer))["apply"](source)
    if any(file_digest(source/name) != digest for name,digest in after.items()):
        raise RuntimeError("Transformed native source checksum mismatch")
    marker.write_text(json.dumps(ICE_TRANSFORM, indent=2) + "\n")
    return ICE_TRANSFORM


def boost_ready(prefix, minor):
    try:
        return ((prefix/".boost-headers-complete").read_text().strip() == "1.92.0"
            and (prefix/".boost-python-cmake-complete").read_text().strip() == "1.92.0 python"+minor
            and (prefix/"include/boost/version.hpp").is_file()
            and bool(list((prefix/"lib").glob("libboost_python"+minor+"*"))))
    except FileNotFoundError:
        return False


def verify_boost(prefix, minor, archive):
    if not boost_ready(prefix, minor):
        raise RuntimeError("Reusable Boost prefix is incomplete or has a different Python ABI")
    tree = hashlib.sha256(); count = 0; license_bytes = None
    base = SOURCES["boost"][2] + "/"
    with tarfile.open(archive) as package:
        for member in package:
            if member.name == base+"LICENSE_1_0.txt":
                license_bytes = package.extractfile(member).read()
            if not member.name.startswith(base+"boost/") or member.isdir():
                continue
            if not member.isfile():
                raise RuntimeError("Review non-file Boost header member")
            name = member.name[len(base):]
            path = prefix/"include"/name
            expected = hashlib.sha256(package.extractfile(member).read()).hexdigest()
            if not path.is_file() or path.is_symlink() or file_digest(path) != expected:
                raise RuntimeError("Reusable Boost header differs from pinned source: "+name)
            tree.update(name.encode()+b"\0"+expected.encode()+b"\n"); count += 1
    actual_count = sum(p.is_file() for p in (prefix/"include/boost").rglob("*"))
    if actual_count != count or license_bytes is None:
        raise RuntimeError("Reusable Boost header set differs from pinned source")
    libraries = {p.name:file_digest(p) for p in sorted((prefix/"lib").glob("libboost_python"+minor+"*")) if p.is_file()}
    if not libraries:
        raise RuntimeError("Reusable Boost.Python library is missing")
    return {"prefix":str(prefix),"headers":count,"headerTreeSha256":tree.hexdigest(),"libraries":libraries}, license_bytes


def run(args, cwd=None):
    print("+ " + " ".join(map(str, args)), flush=True)
    subprocess.run(list(map(str, args)), cwd=cwd, check=True, env=BUILD_ENV)


def source_archive(name, directory):
    url, digest, folder = SOURCES[name]
    archive = directory / url.rsplit("/", 1)[1]
    if not archive.exists():
        partial = archive.with_suffix(archive.suffix + ".download")
        try:
            with urllib.request.urlopen(url, timeout=60) as source, partial.open("wb") as destination:
                shutil.copyfileobj(source, destination)
            partial.replace(archive)
        finally:
            partial.unlink(missing_ok=True)
    with archive.open("rb") as stream:
        actual = hashlib.file_digest(stream, "sha256").hexdigest()
    if actual != digest:
        raise RuntimeError("Source checksum mismatch: " + name)
    return archive


def unpack(name, directory):
    archive = source_archive(name, directory)
    folder = SOURCES[name][2]
    target = directory / folder
    if (target / ".my98-license-only").exists():
        raise RuntimeError("This cache has only the Boost license; use --reuse-boost-prefix or a fresh root")
    if not target.exists():
        with tempfile.TemporaryDirectory(prefix=".extract-", dir=directory) as staging:
            with tarfile.open(archive) as package:
                package.extractall(staging, filter="data")
            Path(staging, folder).rename(target)
    return target


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True, help="Private build/runtime directory")
    parser.add_argument("--webrtc", choices=["on", "off"], required=True)
    parser.add_argument("--jobs", type=int, default=1)
    parser.add_argument("--reuse-boost-prefix", type=Path, help="Verify and reuse an existing Boost prefix read-only; avoid extracting its full source")
    parser.add_argument("--python-include", type=Path)
    parser.add_argument("--python-library", type=Path)
    parser.add_argument("--openssl-root", type=Path)
    parser.add_argument("--release-flags", default="-O3 -DNDEBUG", help="Recorded C++ release flags; -O1 lowers fixture build memory")
    parser.add_argument("--bridge-source", type=Path, default=Path(__file__).resolve().parent.parent / "src/torrent/native")
    args = parser.parse_args()
    if args.jobs < 1 or args.jobs > 4:
        parser.error("Use 1–4 build jobs")
    include = args.python_include or Path(sysconfig.get_path("include"))
    if not (include / "Python.h").is_file():
        parser.error("Python development headers are required; pass a private --python-include")
    BUILD_ENV["CPLUS_INCLUDE_PATH"] = str(include) + os.pathsep + str(include.parent)
    root = args.root.resolve()
    if root == Path("/") or root == Path.home():
        parser.error("A dedicated directory is required")
    if args.reuse_boost_prefix:
        borrowed = args.reuse_boost_prefix.resolve()
        if root == borrowed or root in borrowed.parents or borrowed in root.parents:
            parser.error("The new build root and read-only Boost prefix must not overlap")
    if args.webrtc == "off" and any((root/name).exists() for name in ("native-source-transform.json", "native-patch.json")):
        parser.error("Use a fresh root when disabling WebRTC after a patched build")
    root.mkdir(parents=True, exist_ok=True)
    sources = root / "sources"; sources.mkdir(exist_ok=True)
    prefix = root / "prefix"; prefix.mkdir(exist_ok=True)
    runtime = root / "venv"
    if not (runtime / "bin/python").exists():
        run([sys.executable, "-m", "venv", "--without-pip", runtime])
    python = runtime / "bin/python"
    minor = str(sys.version_info.major) + str(sys.version_info.minor)
    boost_prefix = args.reuse_boost_prefix.resolve() if args.reuse_boost_prefix else prefix
    reuse_boost = None
    if args.reuse_boost_prefix or boost_ready(prefix, minor):
        archive = source_archive("boost", sources)
        reuse_boost, license_bytes = verify_boost(boost_prefix, minor, archive)
        boost = sources / SOURCES["boost"][2]
        if not boost.exists():
            boost.mkdir()
            (boost/".my98-license-only").write_text("Reused verified Boost headers and library\n")
        (boost/"LICENSE_1_0.txt").write_bytes(license_bytes)
        if boost_prefix != prefix:
            (prefix/"lib").mkdir(exist_ok=True)
            for name in reuse_boost["libraries"]:
                shutil.copy2(boost_prefix/"lib"/name, prefix/"lib"/name)
    else:
        boost = unpack("boost", sources)
        headers = prefix / "include/boost"
        marker = prefix / ".boost-headers-complete"
        shutil.copytree(boost / "boost", headers, dirs_exist_ok=True)
        marker.write_text("1.92.0\n")
    boost_marker = prefix / ".boost-python-cmake-complete"
    if reuse_boost is None:
        # Use the source list from upstream's CMake target, without modifying it.
        upstream = (boost / "libs/python/CMakeLists.txt").read_text().split("# Boost::python alias",1)[0]
        names = list(dict.fromkeys(re.findall(r"^  (src/[^\s]+\.cpp)$", upstream, re.M)))
        if len(names) < 20:
            raise RuntimeError("Review the Boost.Python upstream source list")
        cmake_source = root / "boost-python-cmake"
        cmake_source.mkdir(exist_ok=True)
        lines = ["cmake_minimum_required(VERSION 3.20)", "project(my98_boost_python LANGUAGES CXX)",
            "find_package(Python3 COMPONENTS Interpreter Development REQUIRED)",
            "add_library(boost_python" + minor + " SHARED"]
        lines += ['  "' + str(boost / "libs/python" / name) + '"' for name in names]
        target = "boost_python" + minor
        lines += [")", "target_compile_features(" + target + " PRIVATE cxx_std_17)",
            "target_include_directories(" + target + ' PRIVATE "' + str(prefix / "include") + '")',
            "target_compile_definitions(" + target + " PRIVATE BOOST_PYTHON_SOURCE BOOST_PYTHON_DYN_LINK BOOST_PYTHON_NO_LIB)",
            "target_link_libraries(" + target + " PRIVATE Python3::Module)",
            "set_target_properties(" + target + " PROPERTIES VERSION 1.92.0 SOVERSION 1.92.0)",
            "install(TARGETS " + target + " LIBRARY DESTINATION lib)"]
        (cmake_source / "CMakeLists.txt").write_text("\n".join(lines) + "\n")
        cmake_build = root / "boost-python-build"
        command = ["cmake", "-S", cmake_source, "-B", cmake_build, "-DCMAKE_BUILD_TYPE=Release", "-DCMAKE_CXX_FLAGS_RELEASE=" + args.release_flags,
            "-DCMAKE_INSTALL_PREFIX=" + str(prefix), "-DPython3_EXECUTABLE=" + str(python),
            "-DPython3_INCLUDE_DIR=" + str(include)]
        if args.python_library:
            command.append("-DPython3_LIBRARY=" + str(args.python_library.resolve()))
        run(command)
        run(["cmake", "--build", cmake_build, "--parallel", args.jobs])
        run(["cmake", "--install", cmake_build])
        boost_marker.write_text("1.92.0 python" + minor + "\n")
    libtorrent = unpack("libtorrent", sources)
    adaptations = []
    if args.webrtc == "on":
        adaptations.append(apply_native_transform(root, libtorrent, args.bridge_source.resolve()/"patches"))
    if platform.system() == "OpenBSD":
        # 2.1.2 captures this unused constant unconditionally, although OpenBSD
        # has no RLIMIT_AS. Guard only its declaration; keep RLIMIT_NOFILE and
        # every resource-limit feature intact. Record the exact source change.
        source = libtorrent / "src/platform_util.cpp"
        original = "const rlim_t rlimit_as = RLIMIT_AS;"
        guarded = "#ifdef RLIMIT_AS\n" + original + "\n#endif"
        text = source.read_text()
        if guarded not in text:
            if text.count(original) != 1:
                raise RuntimeError("Review the OpenBSD RLIMIT_AS adaptation")
            source.write_text(text.replace(original, guarded))
        restored = source.read_text().replace(guarded, original)
        adaptations.append({"name":"OpenBSD unused RLIMIT_AS declaration guard",
            "file":"src/platform_util.cpp", "before_sha256":hashlib.sha256(restored.encode()).hexdigest(),
            "after_sha256":hashlib.sha256(source.read_bytes()).hexdigest()})
    output = root / "libtorrent-build"
    rpath = str(prefix / "lib") if platform.system() in ("Darwin", "OpenBSD") else "$ORIGIN/../..;$ORIGIN"
    configure = ["cmake", "-S", libtorrent, "-B", output,
        "-DCMAKE_BUILD_TYPE=Release", "-DCMAKE_CXX_FLAGS_RELEASE=" + args.release_flags, "-DCMAKE_INSTALL_PREFIX=" + str(prefix),
        "-DCMAKE_PREFIX_PATH=" + str(prefix) + ";" + str(boost_prefix), "-DBoost_ROOT=" + str(boost_prefix),
        "-DBoost_NO_BOOST_CMAKE=ON", "-DCMAKE_POLICY_DEFAULT_CMP0167=OLD",
        "-DCMAKE_INSTALL_RPATH=" + rpath, "-DBUILD_SHARED_LIBS=ON",
        "-Dpython-bindings=ON", "-Dpython-egg-info=OFF", "-Dpython-install-system-dir=OFF",
        "-DPython3_EXECUTABLE=" + str(python), "-Dboost-python-module-name=python" + minor,
        "-Dwebtorrent=" + ("ON" if args.webrtc == "on" else "OFF"),
        "-Dbuild_tests=OFF", "-Dbuild_examples=OFF"]
    configure.append("-DPython3_INCLUDE_DIR=" + str(include))
    if args.python_library:
        configure.append("-DPython3_LIBRARY=" + str(args.python_library.resolve()))
    if args.openssl_root:
        configure.append("-DOPENSSL_ROOT_DIR=" + str(args.openssl_root.resolve()))
    elif platform.system() == "Darwin" and Path("/opt/homebrew/opt/openssl@3").exists():
        configure.append("-DOPENSSL_ROOT_DIR=/opt/homebrew/opt/openssl@3")
    run(configure)
    run(["cmake", "--build", output, "--parallel", args.jobs])
    run(["cmake", "--install", output])
    site = subprocess.check_output([python, "-c", "import sysconfig;print(sysconfig.get_path('platlib'))"], text=True).strip()
    native_site = prefix / "lib" / ("python" + str(sys.version_info.major) + "." + str(sys.version_info.minor)) / "site-packages"
    Path(site, "my98-native.pth").write_text(str(native_site) + "\n")
    run([python, "-c", "import libtorrent as lt; print('libtorrent',lt.__version__); assert lt.__version__.startswith('2.1.2')"])
    bridge = args.bridge_source.resolve()
    if not (bridge / "signed_record.cpp").is_file():
        parser.error("Pass --bridge-source pointing to my98's native extension")
    bridge_build = root / "bridge-build"
    command = ["cmake", "-S", bridge, "-B", bridge_build,
        "-DCMAKE_BUILD_TYPE=Release", "-DCMAKE_CXX_FLAGS_RELEASE=" + args.release_flags, "-DCMAKE_INSTALL_PREFIX=" + str(prefix),
        "-DCMAKE_PREFIX_PATH=" + str(prefix) + ";" + str(boost_prefix), "-DBoost_ROOT=" + str(boost_prefix),
        "-DBoost_NO_BOOST_CMAKE=ON", "-DCMAKE_POLICY_DEFAULT_CMP0167=OLD",
        "-DCMAKE_INSTALL_RPATH=" + rpath, "-DPython3_EXECUTABLE=" + str(python),
        "-DPython3_INCLUDE_DIR=" + str(include)]
    if args.python_library:
        command.append("-DPython3_LIBRARY=" + str(args.python_library.resolve()))
    if args.openssl_root:
        command.append("-DOPENSSL_ROOT_DIR=" + str(args.openssl_root.resolve()))
    elif platform.system() == "Darwin" and Path("/opt/homebrew/opt/openssl@3").exists():
        command.append("-DOPENSSL_ROOT_DIR=/opt/homebrew/opt/openssl@3")
    run(command)
    run(["cmake", "--build", bridge_build, "--parallel", args.jobs])
    run(["cmake", "--install", bridge_build])
    run([python, "-c", "import libtorrent,my98_libtorrent; print(libtorrent.__version__,my98_libtorrent.put_signed)"])
    compilers = {}
    cache = (output / "CMakeCache.txt").read_text()
    for kind in ("C", "CXX"):
        match = re.search(r"^CMAKE_" + kind + r"_COMPILER:FILEPATH=(.+)$", cache, re.M)
        if match:
            executable = match.group(1)
            compilers[kind] = {"path":executable,"version":subprocess.check_output(
                [executable,"--version"],text=True,env=BUILD_ENV).splitlines()[0]}
    (root / "native-build.json").write_text(json.dumps({"libtorrent":"2.1.2","boost":"1.92.0","python":platform.python_version(),"platform":platform.platform(),"webrtc":args.webrtc,"prefix":str(prefix),"release_flags":args.release_flags,"compilers":compilers,"sources":SOURCES,"adaptations":adaptations,"reusedBoost":reuse_boost}, indent=2) + "\n")


if __name__ == "__main__":
    main()
