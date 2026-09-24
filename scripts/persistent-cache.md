# Published-state and load-profile cache

`openReadOnly({cid, readKey, persistentCache: {state: true, loadProfile: true}})`
enables automatic browser-local reuse. Both flags default to false. jlxip.net enables
both; the regular my98 interface keeps its previous behavior. `clearCaches()` clears
session memory, not IndexedDB; browser site-data deletion removes persistent data.

The Worker stores only verified IPFS blocks in IndexedDB `my98-published-cache-v1`.
States keep encrypted data and their UnixFS DAG. Profiles keep their own data, the
disk header and the DAG paths/whole leaves intersecting the selected encrypted-record
ranges. Whole leaves may include adjacent bytes. Eligibility comes from the current
validated profile, including blocks demand-fetched before profile selection. Changing
scope to `disk` does not broaden eligibility, even when Exit happens early.

The application still resolves IPNS and opens the selected publication before reuse.
Each local block is rehashed against its CID; the normal base-disk authentication,
state decoder and runtime checks remain mandatory. There is no offline/stale-state
fallback. A changed profile with the same state can reuse that state. Session writes
and decrypted RAM/overlay are never stored by this cache.

An existing state root enables streaming its DAG from local blocks, fetching only
missing/corrupt blocks. Completion is recorded only after validation and is a hint,
never a substitute for verifying the stream. Interrupted transfers may leave
individually verified blocks but never complete markers. CAR and raw readers
both feed the cache; optional caching does not change their network admission budget.

Payload budget is 128 MiB per origin (also capped at 16,384 blocks), shared by state
and profile, with transactional LRU eviction and accounting across tabs. Up to 128
state hints are retained; eviction clears hints conservatively. IndexedDB bookkeeping
and browser-internal overhead are outside the payload budget. The write queue retains
at most 4 MiB; overflow skips optional writes. Storage errors disable caching for that
session while loading continues normally. Read/open deadlines are one second.

`readStats().remote.persistentCache` reports enabled flags, storage availability,
queued bytes/pending writes and per-kind hits, misses, read/written bytes, writes,
errors and discarded writes. A pending write may be lost if the page is closed;
next visit can refill the cache. Storage policy may evict any site data.

Run `node scripts/run-browser-test.mjs tests/pages/persistent-cache.mjs` and
`node scripts/run-browser-test.mjs tests/pages/persistent-cache-api.mjs` after `make site`.
