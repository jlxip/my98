#!/usr/bin/env python3
"""PTY checks; invoked by read-only-key-test.mjs against its isolated gateway."""
import errno
import json
import os
from pathlib import Path
import pty
import select
import signal
import sys
import termios
import time


def check(value, message):
    if not value:
        raise AssertionError(message)


def session(gateway, mode):
    output_read, output_write = os.pipe()
    pid, terminal = pty.fork()
    if pid == 0:
        os.close(output_read)
        os.dup2(output_write, 1)
        os.close(output_write)
        script = str(Path(__file__).with_name("read-only-key.py"))
        os.execv(sys.executable, [sys.executable, script, "--gateway", gateway])
    os.close(output_write)
    transcript, output = bytearray(), bytearray()
    steps = [(b"Username: ", b"disk fixtures\n"),
             (b"Password: ", b"public compatibility password\n" if mode != "wrong" else b"incorrect-password\n"),
             (b"Machine [main]: ", b"\n")]
    stage, status, cancelled = 0, None, False
    streams = {terminal: transcript, output_read: output}
    deadline = time.monotonic() + 45
    try:
        while streams or status is None:
            check(time.monotonic() < deadline, "interactive command timed out")
            ready, _, _ = select.select(list(streams), [], [], 0.1)
            for fd in ready:
                try:
                    data = os.read(fd, 65536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    data = b""
                if data:
                    streams[fd].extend(data)
                else:
                    del streams[fd]
            if stage < len(steps) and steps[stage][0] in transcript:
                if stage == 1:
                    check(not termios.tcgetattr(terminal)[3] & termios.ECHO, "password echo was enabled")
                os.write(terminal, steps[stage][1])
                stage += 1
            if mode == "cancel" and b"Finding and verifying" in transcript and not cancelled:
                os.kill(pid, signal.SIGINT)
                cancelled = True
            if status is None:
                done, result = os.waitpid(pid, os.WNOHANG)
                if done:
                    status = os.waitstatus_to_exitcode(result)
        check(stage == 3, "missing interactive prompts")
        check(b"public compatibility password" not in transcript and b"incorrect-password" not in transcript,
              "password appeared on terminal")
        check(b"my98-ro-v2." not in transcript, "read key appeared on stderr")
        if mode in ("success", "success-publication"):
            check(status == 0, "interactive export failed")
            result = json.loads(output)
            check(set(result) == ({"ipnsName", "cid", "readKey", "publicationCid"} if mode == "success-publication" else {"ipnsName", "cid", "readKey"}), "unexpected stdout fields")
            check(output.count(b"\n") == 1, "stdout contained extra output")
            check(result["readKey"].startswith("my98-ro-v2."), "missing read key")
        else:
            check(status == (130 if mode == "cancel" else 1), "incorrect failure status")
            check(not output, "partial JSON on failure")
    finally:
        if status is None:
            os.kill(pid, signal.SIGKILL)
            os.waitpid(pid, 0)
        os.close(terminal)
        os.close(output_read)
        output[:] = b"\0" * len(output)
    print("PTY " + mode + ": passed")


if __name__ == "__main__":
    session(sys.argv[1], sys.argv[2])
