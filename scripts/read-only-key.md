# Export a read-only disk credential

From the repository, prepare the existing disk dependencies and WASM once:

```sh
make disk
python3 scripts/read-only-key.py [--gateway URL]
```

Requires Python 3 and Node.js 24 or later. The command never installs or builds
anything automatically. Enter username, hidden password and machine (`main` by
default). Prompts, progress and errors go to stderr. On success stdout is exactly
one JSON object with `ipnsName`, `cid` and `readKey`. When a publication directory is used it also includes
`publicationCid`, the directory containing the base disk and optional state/profiles; `cid`
continues to identify the disk file. Pass `publicationCid` as the `cid` argument
to `openReadOnly` to discover the state, then use `prepareState({published:true})`
through the machine-state restoration API. Failures return a nonzero status without
JSON. Ctrl-C cancels and closes the helper.

The directory may additionally contain optional [load profiles](load-profiles.md).
They do not change credential export or state authentication. Consumers can select
`setLoadPrefetch({origin:"restored",scope:"profile"})` after restoration, before
running the VM; this schedules background work without waiting for the profile.

The command verifies the published IPNS record, pins the file CID, authenticates
the disk header and decrypts the first block. Prefetch is disabled. By default it
uses my98's query-server list, discovers advertised HTTPS providers for the chosen
CID and reads through the first provider that returns a verified root block.
Discovery runs for at most 30 seconds after resolution; an absent usable provider
is an error, with no fixed data-gateway fallback. An explicit `--gateway` uses
only that server for both resolution and download; it accepts HTTPS or loopback
HTTP.
It does not start Windows, write the disk or publish anything.

The `my98-ro-v2` key grants access to all available past and future disks and states
of the same identity (username, password and machine). It contains the public
signing key and the separate metadata decryption key, never the signing seed or
Argon2 master. Export once; subsequent disk saves do not change this credential.
The previous `my98-ro-v1` format is rejected; export again to migrate. No disk or
state conversion is needed. There is no independent revocation for a shared key:
changing credentials creates a different identity and cannot revoke old copies. Keep the resulting JSON
private if the disk contents are private. Credentials travel to the Node helper
through stdin, never arguments or temporary files; mutable secret buffers are
cleared on exit (Python/JavaScript immutable strings cannot be zeroized).

Run `make read-only-key-test` for isolated gateway, authentication, corruption,
cancellation and pseudoterminal checks. It uses the existing offline Kubo test
fixture (`KUBO_BINARY` can select its executable) and never uses a real account.
