# Published state transport

Published states use up to four parallel, continuous CAR v1 range downloads.
The normal raw-block reader remains the fallback and supplies small states or
budgets with only one network slot. State format, credentials and restoration
compatibility are unchanged; decryption, gzip and final authentication still run
through the existing incremental decoder.

The client only considers an explicit gateway or providers verified by ordinary
discovery. It races at most two actual first-range transfers, verifies their first
payload and reuses the winner; there is no fixed server or unverified fallback.
Other providers can join while discovery runs. Unsupported CAR is remembered for
that disk session. At most four providers are tried within a bounded selection.

Each stream requests `dag-scope=entity`, `car-order=dfs`, `car-dups=y` and an
`entity-bytes` range. Root, parent/child CIDs, full leaf hashes, UnixFS sizes, range
completeness and EOF are checked. Raw/protobuf leaves, inline data and nested file
DAGs work; unsupported shapes or proof limits fall back to the raw exporter.
A bad CAR never disables integrity checks in that exporter.

On CAR failure, all unused CAR queues are cancelled and raw download resumes at
exactly the byte following the verified prefix already emitted. It does not
restart decryption, append duplicate bytes or accept a partial state. Explicit
cancellation propagates without launching fallback; retry starts a fresh stream.

CAR leases share the disk's global concurrency budget with raw demand requests,
leave a slot for opening the base disk, and release on EOF/error/cancel. At most
four CAR streams run. Each output queue is 1 MiB plus at most one verified block;
blocks are at most 4 MiB, header 64 KiB, proof data 8 MiB/range, depth 64 and
16,384 blocks/range. The parser retains one incoming browser chunk and one CAR
section. Native browser/TCP buffering is not included in these application limits.
Timeouts apply while awaiting network I/O, not while consumer backpressure pauses
reads; both idle and cumulative I/O time are bounded.

`openReadOnly({..., stateTransport:"blocks"})` disables CAR for diagnostics;
`"auto"` is the default. `readStats().remote.stateTransport` reports the selected
mode/provider/lanes, CAR bytes emitted, fallback offset/reason and active leases.
`readTrace()` includes `car-start`, `car-end`, `car-error` and `car-fallback` when
tracing is enabled. This transport does not move the load profile earlier.

Validation: `node --test src/disk/scripts/car.test.mjs`,
`node scripts/run-browser-test.mjs tests/pages/car-stream.mjs`, and
`tests/pages/published-state-network.mjs` (native Worker/HTTP, authenticated state,
cancellation/retry and corruption fallback). These are included in `make site-test`.
