> Final acceptance PASS (17 October 2026): a real 1 GiB Windows98 disk and a 22.9 MB machine state were published via the Mac CLI. Chromium and WebKit cold boot to the desktop, complete the IndexedDB disk cache, and restore the published state in fresh persistent profiles, preserving an unsaved Notepad document. The Mac publisher is closed. NUC/Piensa restarts preserve the exact disk/state hashes and signed record. WebKit also passes with WebRTC disabled. Current services use runtime9; evidence: build/transport-retirement/real-machine-20261017/acceptance.{md,json}.

# Publication transport replacement

The legacy publication transport has been replaced with WebTorrent and BEP46.
Local encrypted files, read-only capabilities, machine states and initialized
local agent machines remain supported. Publishing uses the Python CLI.

Logging in automatically resolves and opens the latest accepted signed descriptor
using the identity's public key, without another button or confirmation. Read-only access resolves the same
way using the public key embedded in the read key. Choose Or use a read key
below Log in to switch forms, or Or log in to return. URL infoHash/publicKey
arguments do not override either identity. A same-origin torrent-sources.json
may override the default {apis,trackers,webseeds}; no old transport arguments
are accepted.
If no publication exists or opening fails, the identity stays unlocked and the
error is shown. Disk still offers creation and opening a local encrypted file.
Disk, State and Tools group the workspace actions. Boot and Resume state stay
manual and visible when available; actions that do not apply to the current disk
are hidden.
Progress, cancellation and recovery controls remain visible when needed.
The file/VM controls and state formats are preserved. Browser publishing is not
part of this delivery.

Focused client acceptance and make site-test pass in Chromium and WebKit,
including encrypted ranges, boot/state restoration, profiles, cache/cancellation,
read-only access and UI. The delivered WebTorrent source build excludes only the
unused FSA store adapter, whose import otherwise opens/removes an OPFS directory.
Peer scheduling and verification remain upstream's. All pieces use our explicit
IndexedDB store. Locked browser platform shims and licenses are included.

Runtime8 was the initial deployment. Its first activation exposed an inherited
owner-only Aquatic executable mode; packaging/installation now normalize native
binary modes and installation exercises Aquatic under the service account.
Aquatic's pinned source also enables SO_REUSEADDR alongside SO_REUSEPORT,
with original/modified source hashes recorded. Tracker shutdown waits briefly for
io_uring socket release. The old binary reproduced the restart failure; five
isolated WSS restart cycles and three real production restarts now pass with
zero automatic restarts and preserved files. Trusted public HTTPS/CORS/WSS pass.
Router forwarding preserves seven existing rules; external TCP/UDP probes pass.
NUC, OpenBSD and Oregon are active in that order. All three public IPv4 port
probes, trusted HTTPS/API/CORS and restart persistence checks pass. NUC and
Oregon also pass public WSS restrictions and three restarts after WSS requests.
Oregon uses the verified NUC artifact and performs no native compilation.
The existing deployed website and publication/relay services remain unchanged.

OpenBSD's private Nginx currently inherits a 128-descriptor soft limit, below its
256 worker connection setting; installation reports that warning. Functional
acceptance passes; high-concurrency capacity has not been tested. No existing
login classes or global limits were changed.


## Runtime9 corrections from real-machine acceptance

Runtime9 is installed in NUC, OpenBSD and Oregon, in that order. Native binaries,
versions and dependency locks remain those verified in runtime8; installation is
offline and Oregon performs no compilation. Before/after checks preserve all 14
protected configurations and all old service PIDs. Only dedicated new services
were restarted.

Public DHT lookups may deliver a valid signed record before the search completes.
Followers retain the highest verified record seen within their lookup interval;
signature, identity, sequence and conflict checks still apply. Publisher conflict
checks and commit readback continue to require a completed lookup. The HTTPS
proxy hides the backend Allow-Origin header and emits its own single header;
duplicate CORS headers on successful API responses previously blocked browsers.
Regression tests cover both conditions, including invalid signatures/conflicts,
real TLS/API/ranges/WebSocket proxying and certificate renewal on Linux/OpenBSD.

The Mac's updated native suite passes 20 cases. Real Chromium acceptance also
exercises an incognito quota failure with a controlled storage error; a persistent
profile completes the full encrypted 1 GiB disk in IndexedDB. Private-browser
quotas may be too small for that disk; no whole-disk RAM fallback is used. A state
restore started during OpenBSD rehash timed out; retrying from a fresh profile
after both complete webseeds were ready passed. Restart acceptance waits for
verified webseed files after the persistent signed name becomes available.

Runtime9 archives: Linux SHA-256
`fbd2032948113b329f854396acca49f676afe7572d89d25f49eb7cfcc377d410`;
OpenBSD SHA-256
`f573f2570e84840ae2f2677603460792e49327d9b0523a2a869c54b169ff4806`.
Evidence is under `build/transport-retirement/real-machine-20261017/`.
The runtime8 details below remain the baseline build/deployment provenance.

## Native publication runtime (isolated acceptance passed)

The native publication engine, service and CLI are implemented. Isolated browser,
Linux/OpenBSD native interoperability and dedicated deployment gates have passed.
The procedures below describe their reproducible validation.

Build into a private prefix and install locked Python dependencies:

```sh
make torrent-native TORRENT_ROOT=build/torrent-native/mac TORRENT_WEBRTC=off
make torrent-python TORRENT_ROOT=build/torrent-native/mac
make torrent-test TORRENT_ROOT=build/torrent-native/mac
```

Use WebRTC ON for Linux seeders and OFF for Mac/OpenBSD. The builder pins source
archive hashes, installs official Python bindings and our presigned-record bridge
from the same libtorrent compilation, and records flags/platform/source changes
in `native-build.json`. OpenBSD needs a guard around an unused `RLIMIT_AS`
declaration in upstream 2.1.2; the builder records both source hashes. Resource
limits and the `RLIMIT_NOFILE` implementation stay enabled. No alternate torrent
engine is selected. `--release-flags='-O1 -DNDEBUG'` is available for builds with a
strict memory limit; this flag is recorded and does not claim measured performance.

Python bootstrap uses a dedicated venv, fixed pip wheel/hash, separately locked
build dependencies, and runtime hashes. Source builds run without dependency
build isolation so build tools cannot float to unpinned releases. Existing global
Python packages are never installed or upgraded.

Run the CLI with the venv interpreter:

```sh
build/torrent-native/mac/venv/bin/python scripts/my98-torrent.py --help
```

A checked-in public configuration names the three deployed seedboxes:

```sh
build/torrent-native/mac/venv/bin/python scripts/my98-torrent.py --config src/torrent/publisher.example.json publish disk.my98
build/torrent-native/mac/venv/bin/python scripts/my98-torrent.py --config src/torrent/publisher.example.json state snapshot.my98state
build/torrent-native/mac/venv/bin/python scripts/my98-torrent.py --config src/torrent/publisher.example.json clear-state
```

Run `identity` to obtain the public key and `status PUBLIC_KEY` to inspect it.
Seedboxes accept only their explicitly configured followed keys. Add new
identities deliberately to their configuration. Deployment acceptance uses
disposable fixtures; users recreate their own publications with the CLI.

Supported commands: `identity`, `status PUBLIC_KEY`, `publish DISK [--state FILE]
[--profile FILE]`, `state FILE`, `clear-state`, `profile FILE`, `clear-profile`,
`resume`, and `serve`. State changes can explicitly `--clear-profile` when
removing an incompatible state-bound profile; otherwise such changes fail.
A new disk starts without state/profile unless explicitly supplied.

Every publishing command prompts for credentials. Prepared journals contain
only signed public records, the previous public record, admission status, and
progress phase. Private keys/passwords are never serialized. Interrupted
candidates keep their torrents and sequence; `resume` reobserves all pieces on
one configured seedbox before the DHT commit. Conflicts are explicit and allow
preparing a fresh publication. Cached records never replace DHT readback.

The Mac connects outward to configured seedbox TCP listeners and does not
announce its temporary content listener through DHT/PEX/trackers. BEP44/46 still
uses the session DHT. This keeps confirmation tied to configured node endpoints.

Configuration is JSON with explicit `nodes` (`name`, HTTPS `api`, `[host,port]`
`peer`), `trackers` (WSS), and `webseeds` (HTTPS content roots). Service config also
requires its own `data` directory, `follow` public keys, native `listen`, and an
`api` loopback host/port. `publisherData` optionally selects a separate CLI cache.
Unencrypted sources are allowed only for loopback fixtures. CLI `--isolated`
disables public DHT bootstrap and requires all source endpoints to be loopback.
Administrative HTTP stays on loopback; public TLS and file serving are separate.

API routes: GET `/v1/names/KEY`, GET `/v1/torrents/INFOHASH.torrent`, POST
`/v1/candidates` with `record` and base64 descriptor `torrent`. The 202 response
only admits a transfer and never acknowledges a complete copy. Pending candidates
never change the public name. Webseed links are exposed only after complete
piece verification and format/binding checks; current adopted files remain while
a replacement transfers. Reopening rehashes preserved files before exposing them.

Evidence and intermediate logs live in `build/transport-retirement/`. The original
retirement evidence is `results.json`, `native.log` and `validation.log`. Native
protocol/transfer/service/publisher/CLI logs are named `*-tests.log`; they are
isolated and use disposable public fixture credentials. No public services are
activated by these tests.

## Baseline execution — 2026-10-17 (runtime8)

Native publication validation is complete in isolated fixtures: 19 cases pass on
Mac, NUC Linux and OpenBSD (WebRTC OFF). Oregon passed the earlier 18-case suite
and offline installation of the final runtime8 using binaries copied from the
NUC. The NUC produced optimized WebRTC-enabled libtorrent 2.1.2, official bindings,
the presigned-record bridge, and Aquatic. Oregon installation was offline and
verified all artifact hashes, Python imports, shared libraries, and dependencies.
The Linux archive SHA-256 is
`f8d755613986d8b8e290812095295ce874f77276e72c71542944255bc80f5995`
for the runtime8 release, including dedicated Nginx and service supervision.
Do not compile on Oregon. Cross compilation was discarded.

Real Aquatic/libtorrent/WebTorrent interoperability passes in Chromium and WebKit:
627500 exact bytes and SHA-256 through WebRTC alone, without TCP, uTP or webseeds.
Aquatic rejects unknown swarms; atomic allowlist replacement and signals to owned
children permit then remove a test swarm. Browser tests separately cover normal
webseed ranges, background downloading, offline cache, corrupt pieces, cancellation,
quota errors, and publication verification using Rust/WASM. Evidence is in
`build/transport-retirement/{webtorrent-interop,torrent-window,torrent-records}.json`
and the platform reports `*-results*.json` and `oregon-runtime-install.json`.

Browser integration acceptance is complete, including full site regression and
real WebRTC with WindowTorrents and IndexedDB. Isolated infrastructure validation
is complete; sequential public rollout is gated on NUC port exposure. Private Nginx 1.30.6 builds and real TLS/range/proxy/renewal fixtures pass on
Linux/OpenBSD. Expanded runtime2 artifacts pass fresh offline installation on
Oregon and OpenBSD with imports and shared libraries resolved inside the relocated
prefix. Linux user-systemd lifecycle passes: separate node/HTTPS processes, TLS
oneshot, restart preserving files, and own-unit cleanup. OpenBSD root rc.d lifecycle passes, including reload, restart retaining files
and stopping only its processes. Its process pattern is assigned after rc.subr
initialization. Dedicated installation, supervision and combined Aquatic WSS
acceptance pass; real mixed WebRTC/HTTPS and HTTPS-only browser fixtures pass.
CORS OPTIONS is served by an internal static response independent of the API.
The TCP preflight permits TIME_WAIT during restart and still rejects live
listeners; UDP bindings remain exclusive. Final native regression has 19 cases
on Mac/Linux/OpenBSD. Runtime6 artifacts pass offline installation in fresh
prefixes, including Oregon without compilation. No public services are activated. Existing services
remain untouched. Historical fixture units are never restart instructions.

The service can own Aquatic children using an optional configuration field:

```json
{"aquatic":{"binary":"/private/prefix/bin/aquatic_ws","listen":[
  {"host":"127.0.0.1","port":17499},
  {"host":"::1","port":17499}
]}}
```

Python writes the shared allowlist atomically and signals only its own child
Process objects. Root hashes require an accepted followed-key candidate or public
record; child hashes require a verified descriptor or an adopted publication.
Current components remain permitted during replacement and shared references are
retained. Separate IPv4/IPv6 loopback children preserve the address family for the
future TLS proxy. The parent service exits if a tracker child unexpectedly stops.
Linux supervision must provide Aquatic's required per-process locked-memory
limit; global resource limits are not changed. Administrative listeners remain
on loopback and startup conflicts stop the new service.

Aquatic source commit and Cargo.lock hashes are pinned in
`src/torrent/aquatic.lock.json`; `scripts/build-aquatic.py` uses a private pinned
Rust toolchain and `cargo --locked`. Its optional fixture build profile is recorded
and makes no measured performance claim. The real Linux tracker and
`tests/torrent-webtorrent.mjs` interoperability gate pass in Chromium and WebKit,
including WSS through the dedicated Nginx configuration. The isolated WSS test
uses a generated fixture certificate and a browser exception restricted to that
loopback fixture; production trust validation is unchanged.
That browser fixture checks exact content and an exclusively WebRTC wire, with
conventional native peer transports disabled and no webseed configured.

## Dedicated service installation

Use a reviewed deployment JSON with explicit followed public keys, current TLS
source paths, trusted torrent sources and the private runtime paths. Public roots
are fixed at /opt/my98-torrent/runtime and /var/lib/my98-torrent. Linux includes
two loopback Aquatic listeners; OpenBSD includes neither Aquatic nor WebRTC.

As root, install a matching verified artifact without starting listeners:

```sh
python3 /path/to/artifact/release/scripts/install-torrent-services.py --artifact /path/to/artifact --config /path/to/deployment.json
```

This creates the dedicated account and only marked service definitions, installs
Python wheels offline, validates copied certificates and tests the private Nginx
configuration. It does not update global packages or existing service files.
Before activation, verify dedicated TCP8444 and TCP/UDP51413 listeners are free,
firewall rules and external forwarding are available, and isolated acceptance
has passed. Roll out Linux NUC, then OpenBSD, then Oregon using NUC binaries.

```sh
/opt/my98-torrent/runtime/bin/my98-torrent-services --config /var/lib/my98-torrent/config/deployment.json activate
```

Activation verifies reviewed definitions, starts only the dedicated services,
checks trusted TLS/API health and enables hourly certificate maintenance. Failure
stops and disables only these definitions. The same command with `stop` stops only
owned services. TLS renewal preserves source paths and replaces copied pairs
atomically; it reloads only the private Nginx master. Existing services remain
independent.

## Historical clean pause checkpoint — 2026-10-16

Retained for provenance. The completed gates and deployment above supersede
this checkpoint and its restart instructions.

Execution is paused at the user's request. No build/test/service processes from
this work remain active on Mac, OpenBSD or Oregon; no new public service has
been activated. Resume only on a new user instruction. Existing website services,
repository pins and indexes are preserved. Sources remain unstaged/uncommitted.

Completed evidence:

- Mac: private libtorrent 2.1.2, official Python bindings and our C++ bridge
  build/import successfully. All six transport suites (14 cases) pass in
  `build/transport-retirement/torrent-suite.log`. Rust crypto has 15 passing
  tests, including two frozen BEP44 signatures matching PyNaCl, recorded in
  `rust-bep44-vectors.log`.
- OpenBSD: private WebRTC-OFF native build, imports and locked Python install
  pass. The same six suites/14 cases pass, including cut/retry, independent
  state/profile changes, conflicts, exact complete-copy observation, retention
  and recovery after closing the publisher. The final signature-vector rerun
  passes all eight protocol tests. Copied evidence is `native-build-openbsd.json`,
  `openbsd-test-results.json` and `native-openbsd-complete.log` in the same local
  evidence directory. The private remote root is
  `/home/jlxip/.local/state/my98-torrent-fixtures/native-v2.1.2`; its logs and
  `native-test-results.json` are retained. These structural fixtures do not
  prove remote browser boot or WebRTC interoperability.
- Oregon: WebRTC-ON build is incomplete at 40%. The 512 MiB per-process virtual
  address-space guard stops GCC in `bt_peer_connection.cpp`; this is a resource
  limit, not an established incompatibility. An earlier guarded attempt stopped
  at 36%. Source objects and a privately extracted, hash-verified Debian toolchain
  remain under `/home/admin/.local/state/my98-torrent-fixtures/native-v2.1.2`.
  See `build-linux.log`, `build-linux-512m-first.log` and
  `toolchain-packages.json` there. No system packages were installed or upgraded.
  No compiler fixture systemd unit was created (`LoadState=not-found`).
- NUC: unavailable while the user is away. Do not retry connections until that
  instruction changes. Its earlier WebRTC-ON build remains at 81%, stopped, in
  `/home/jlxip/.local/state/my98-torrent-fixtures/native-v2.1.2`.

Restart sequence:

1. Read this checkpoint and `build/transport-retirement/pause.json`; compare
   repository HEAD/index/submodule checks and verify ownership of any remaining
   runtime processes before acting. No jobs should resume automatically.
2. Finish a bounded private Linux WebRTC-ON build without affecting existing
   services. Do not repeat the same failing 512 MiB virtual-address-space cap.
   Any changed containment must bound the complete build's memory and be
   documented before launch. Synchronize the current builder and bridge before
   resuming old NUC objects once that host is available and authorized again.
3. Validate Linux transfers and browser WebTorrent interoperability. Complete
   Aquatic's current/candidate allowlist integration, pinned commit/lockfile and
   isolated service checks. Aquatic was only inspected; Nginx/TLS/supervision
   and public configuration are not implemented or activated yet.
4. Native publication remains incomplete. The next planned phase is the
   WebTorrent browser client (Window/Worker bridge, encrypted range reads, bounded
   IndexedDB, priorities, states/profiles and cancellation/cache cleanup), followed
   by isolated validation and then sequential deployment NUC → OpenBSD → Oregon.
   These phases have not started. Webseeds are normal sources from the start
   alongside WebRTC, without an assumed fixed performance priority.

## Read-only presentation clients

`openRemote` and `openRemoteReadOnly` accept `prefetchScope:"none"` to open
without a full disk download; the default remains `disk`. After restoring a
published state, select `setLoadPrefetch({origin:"restored",scope:"profile"})`
to download only its matching ranges. Profile completion does not select the
whole disk. Ordinary demand reads still work, including after profile completion
and cancellation/resume. Selection maintenance must preserve active profile
ranges while IndexedDB rescan or background-policy notifications complete.
