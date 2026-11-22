"""Cancelling the private prompt restores terminal echo and never publishes."""
import json
import os
from pathlib import Path
import pty
import select
import signal
import subprocess
import sys
import tempfile
import termios
import time

binary = str(Path(sys.argv[1]).resolve())
with tempfile.TemporaryDirectory(prefix="my98-prompt-") as temporary:
    root = Path(temporary)
    config = root / "sources.json"
    config.write_text(json.dumps({"gateways": [], "trackers": ["wss://127.0.0.1:1/announce"]}))
    master, slave = pty.openpty()
    previous = termios.tcgetattr(slave)
    process = subprocess.Popen([binary, "--root", str(root / "publisher"), "--config", str(config),
                                "--isolated", "--dht-bootstrap", "127.0.0.1:1", "publish", str(root / "unused.my98")],
                               stdin=slave, stdout=slave, stderr=slave)
    transcript = b""
    try:
        def until(needle):
            global transcript
            deadline = time.monotonic() + 15
            while needle not in transcript:
                assert process.poll() is None, transcript.decode(errors="replace")
                assert time.monotonic() < deadline, "Private prompt timed out"
                if select.select([master], [], [], 0.1)[0]:
                    transcript += os.read(master, 65536)
        until(b"Username:")
        os.write(master, b"signal fixture\n")
        until(b"Password:")
        assert not termios.tcgetattr(slave)[3] & termios.ECHO, "Password was echoed"
        process.send_signal(signal.SIGINT)
        assert process.wait(timeout=10) == 1
        assert termios.tcgetattr(slave)[3] == previous[3], "Terminal flags were not restored"
        assert not (root / "publisher/publication.json").exists(), "Cancelled prompt created a publication"
        print("PASS private prompt: hidden password, prompt cancellation, echo restored, no publication")
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        os.close(master)
        os.close(slave)
