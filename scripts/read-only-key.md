# Export a read-only disk credential

From the repository, prepare the existing disk dependencies and WASM once:

```sh
make disk
python3 scripts/read-only-key.py [--gateway URL]
```

Requires Python 3 and Node.js 24 or later. The command never installs or builds
anything automatically. Enter username, hidden password and machine (`main` by
default). Prompts, progress and errors go to stderr. On success stdout is exactly
one JSON object with `cid` and `readKey`. When a state is published it also includes
`publicationCid`, the directory containing the base disk and its state; `cid`
continues to identify the disk file. Pass `publicationCid` as the `cid` argument
to `openReadOnly` to discover the state, then use `prepareState({published:true})`
through the machine-state restoration API. Failures return a nonzero status without
JSON. Ctrl-C cancels and closes the helper.

The command verifies the published IPNS record, pins the file CID, authenticates
the disk header and decrypts the first block. Prefetch is disabled. By default it
uses my98's query-server list, discovers advertised HTTPS providers for the chosen
CID and reads through the first provider that returns a verified root block.
Discovery runs for at most 30 seconds after resolution; an absent usable provider
is an error, with no fixed data-gateway fallback. An explicit `--gateway` uses
only that server for both resolution and download; it accepts HTTPS or loopback
HTTP.
It does not start Windows, write the disk or publish anything.

The read key grants access to that disk version. After saving a new version,
export again to obtain its matching CID and read key. Keep the resulting JSON
private if the disk contents are private. Credentials travel to the Node helper
through stdin, never arguments or temporary files; mutable secret buffers are
cleared on exit (Python/JavaScript immutable strings cannot be zeroized).

Run `make read-only-key-test` for isolated gateway, authentication, corruption,
cancellation and pseudoterminal checks. It uses the existing offline Kubo test
fixture (`KUBO_BINARY` can select its executable) and never uses a real account.
