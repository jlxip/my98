#!/usr/bin/env python3
"""Interactively export the published disk's CID and read-only capability."""
import argparse
import getpass
import json
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import warnings


class Failure(Exception):
    pass


def prompt(label):
    print(label, end="", file=sys.stderr, flush=True)
    value = sys.stdin.readline()
    if not value:
        raise EOFError
    return value.rstrip("\r\n")


def stop(child):
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()


def run():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gateway", help="IPFS gateway; defaults to my98's gateway")
    args = parser.parse_args()
    node = shutil.which("node")
    if not node:
        raise Failure("Node.js 24 or later is required. Install it, then run make disk.")
    helper = Path(__file__).resolve().with_suffix(".mjs")
    try:
        probe = subprocess.run([node, str(helper), "--check"], capture_output=True, timeout=30)
    except subprocess.TimeoutExpired as exc:
        raise Failure("Build check timed out. Run make disk and retry.") from exc
    if probe.returncode:
        raise Failure("Disk tools are unavailable or outdated. Use Node.js 24 or later and run make disk in the repository.")
    if not sys.stdin.isatty():
        raise Failure("Run this command in a terminal for interactive login.")
    username = prompt("Username: ")
    with warnings.catch_warnings():
        warnings.simplefilter("error", getpass.GetPassWarning)
        try:
            password = getpass.getpass("Password: ", stream=sys.stderr)
        except getpass.GetPassWarning as exc:
            raise Failure("A terminal with hidden password input is required.") from exc
    machine = prompt("Machine [main]: ") or "main"
    credentials = {"username": username, "password": password, "machine": machine, "gateway": args.gateway}
    if any(not value or len(value.encode("utf-8")) > 4096 for value in (username, password, machine)):
        raise Failure("Each credential must contain between 1 and 4096 UTF-8 bytes.")
    payload = bytearray(json.dumps(credentials, ensure_ascii=False).encode("utf-8"))
    password = None
    credentials.clear()
    child = None
    try:
        child = subprocess.Popen([node, str(helper)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=None, start_new_session=True)
        output, _ = child.communicate(input=payload, timeout=125)
        if child.returncode:
            return 130 if child.returncode in (130, -signal.SIGINT, -signal.SIGTERM) else 1
        # Do not emit partial or unexpected helper output.
        try:
            result = json.loads(output)
            valid = (isinstance(result, dict) and set(result) == {"cid", "readKey"}
                     and isinstance(result["cid"], str) and bool(result["cid"])
                     and isinstance(result["readKey"], str)
                     and re.fullmatch(r"my98-ro-v1\.[A-Za-z0-9_-]{64}", result["readKey"]))
        except (ValueError, TypeError):
            valid = False
        if not valid:
            raise Failure("The disk tool returned an invalid result. Run make disk and retry.")
        print(json.dumps(result, separators=(",", ":")), flush=True)
        return 0
    except subprocess.TimeoutExpired as exc:
        raise Failure("Export timed out; check the gateway and retry.") from exc
    finally:
        payload[:] = b"\0" * len(payload)
        if child is not None:
            stop(child)


def interrupt(_signum, _frame):
    raise KeyboardInterrupt


def main():
    signal.signal(signal.SIGTERM, interrupt)
    try:
        return run()
    except (KeyboardInterrupt, EOFError):
        print("\nCancelled.", file=sys.stderr)
        return 130
    except BrokenPipeError:
        return 1
    except (Failure, OSError) as error:
        print(str(error) if isinstance(error, Failure) else "Could not run the disk tool.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
