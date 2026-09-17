# Export a read-only disk credential

From the repository, prepare the existing disk dependencies and WASM once:

```sh
make disk
python3 scripts/read-only-key.py [--gateway URL]
```

Requires Python 3 and Node.js 24 or later. The command never installs or builds
anything automatically. Enter username, hidden password and machine (`main` by
default). Prompts, progress and errors go to stderr. On success stdout is exactly
one JSON object with `cid` and `readKey`; failures return a nonzero status without
JSON. Ctrl-C cancels and closes the helper.

The command verifies the published IPNS record, pins the file CID, authenticates
the disk header and decrypts the first block. Prefetch is disabled. The default
gateway is the same as my98; `--gateway` accepts HTTPS or local HTTP for tests.
It does not start Windows, write the disk or publish anything.

The read key grants access to that disk version. After saving a new version,
export again to obtain its matching CID and read key. Keep the resulting JSON
private if the disk contents are private. Credentials travel to the Node helper
through stdin, never arguments or temporary files; mutable secret buffers are
cleared on exit (Python/JavaScript immutable strings cannot be zeroized).

Run `make read-only-key-test` for isolated gateway, authentication, corruption,
cancellation and pseudoterminal checks. It uses the existing offline Kubo test
fixture (`KUBO_BINARY` can select its executable) and never uses a real account.
