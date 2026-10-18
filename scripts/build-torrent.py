#!/usr/bin/env python3
"""Build pinned libtorrent and Boost.Python in a private prefix; never use sudo."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
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


BUILD_ENV = os.environ.copy()

def run(args, cwd=None):
    print("+ " + " ".join(map(str, args)), flush=True)
    subprocess.run(list(map(str, args)), cwd=cwd, check=True, env=BUILD_ENV)


def unpack(name, directory):
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
    target = directory / folder
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
    root.mkdir(parents=True, exist_ok=True)
    sources = root / "sources"; sources.mkdir(exist_ok=True)
    prefix = root / "prefix"; prefix.mkdir(exist_ok=True)
    runtime = root / "venv"
    if not (runtime / "bin/python").exists():
        run([sys.executable, "-m", "venv", "--without-pip", runtime])
    python = runtime / "bin/python"
    boost = unpack("boost", sources)
    minor = str(sys.version_info.major) + str(sys.version_info.minor)
    libraries = list((prefix / "lib").glob("libboost_python" + minor + "*"))
    headers = prefix / "include/boost"
    marker = prefix / ".boost-headers-complete"
    if not marker.exists():
        shutil.copytree(boost / "boost", headers, dirs_exist_ok=True)
        marker.write_text("1.92.0\n")
    boost_marker = prefix / ".boost-python-cmake-complete"
    if not libraries or not boost_marker.exists():
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
        "-DCMAKE_PREFIX_PATH=" + str(prefix), "-DBoost_ROOT=" + str(prefix),
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
        "-DCMAKE_PREFIX_PATH=" + str(prefix), "-DBoost_ROOT=" + str(prefix),
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
    (root / "native-build.json").write_text(json.dumps({"libtorrent":"2.1.2","boost":"1.92.0","python":platform.python_version(),"platform":platform.platform(),"webrtc":args.webrtc,"prefix":str(prefix),"release_flags":args.release_flags,"compilers":compilers,"sources":SOURCES,"adaptations":adaptations}, indent=2) + "\n")


if __name__ == "__main__":
    main()
