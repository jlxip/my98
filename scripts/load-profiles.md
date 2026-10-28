# Load profiles

Profiles are public hints for an immutable disk torrent. A version 2 profile contains
`infoHash` (40 lowercase hexadecimal digits), `origin` (`boot` or `state` with the
state SHA-256), `unitBytes:65536`, and 32 bounded non-overlapping `ranges` slots.
The encrypted disk and state authentication remain authoritative.

`generate-boot-ranges.mjs` accepts a trace with `infoHash` and `firstTouchUnits`.
Remote collection and publication are available through Tools → Analyze loads
and the publisher CLI described in the repository README.


## Blocking startup for an embedded publication

The normal my98 UI keeps its existing optional `setLoadPrefetch` behavior. An
embedder can opt into a separate startup job while preparing a published state:

```js
const prepared = await disk.prepareState({
    publication: true,
    prefetch: {
        scope: 'profile',
        maxAttempts: 3,
        postRestoreBudgetMs: 10000,
        windowPieces: 8,
    },
});
// Restore prepared.state into a stopped VM, then commit its matching disk overlay.
await disk.commitState(prepared.token);
const result = await disk.waitLoadPrefetch(prepared.prefetchId);
// result.outcome is 'complete' or 'fallback'; either permits running/showing the VM.
```

`restoreMachineState` propagates `prefetchId` to callers. Discard a failed candidate
with `discardState(token)`; cancellation and supersession also stop its job. Wait
only after committing. A failed state, authentication or Worker remains an error.

State and profile downloads overlap, while Vault operations remain serialized.
Profile ciphertext is accepted only for the selected disk and authenticated state
SHA-256. Transient profile metadata or piece failures retry at most twice, keeping
verified pieces. Missing, invalid or incompatible profiles immediately fall back.
The shared ten-second allowance starts once at commit, after VM restoration, and
does not restart on retry. Fallback removes only this job's selections and leaves
healthy demand reads available, including recovery with the same infohash/cache.

The window selects up to eight unique missing 256 KiB pieces across the union of
profile ranges and replenishes after any verification. It is not a global traffic
limit: ordinary reads, state downloads and existing connection limits are separate.

The `download-startup` progress phase reports verified encrypted state bytes plus
verified bytes of the unique target disk pieces, including valid cache. The final
short piece contributes its actual size. It excludes JSON, metadata and unrelated
assets; retries and overlapping ranges do not count twice. Events begin only when
the full target is known, with stable `total` and monotonic `completed`. A fallback
can leave an incomplete counter; it never reduces the total or fabricates 100%.
The existing `download-state` phase remains available to current consumers.
