# Load profiles

A publication can contain `disk.my98`, optionally `state.my98state`, and
optionally `load-profiles.json`. Direct disk CIDs and older disk/state directories
remain supported. There is one published state, with independent optional profiles
for cold boot and continuation from that state.

In my98, open a remote disk, select **Analyze loads**, then **Boot**, **Resume
state**, or **Load state**. Perform the expected actions and select **Stop
analyzing** to download the JSON. The VM can continue running. Replacing a live
session requires the existing confirmation; cold analysis requires a clean base.
A restored overlay is allowed. Recording starts before the first execution from
the chosen origin, observes logical guest reads (including cache hits), and never
records speculative downloads. Saving or replacing the source is blocked while
recording. A new recording replaces the old profile; merging journeys is separate.

Publish with an existing seedbox signing key:

```sh
my98-seedbox --key KEY publish-profile disk-load-profile.json
my98-seedbox --key KEY clear-profiles
```

`publish-profile` accepts one or two v2 profiles and preserves the other compatible
origin. Publishing profiles changes the directory root, not the disk/state CIDs.
`publish-state` preserves the boot profile and preserves a state profile only for
the exact same state file. `clear-state` drops its profile and keeps boot's profile.
Publishing a disk replaces the publication as before, clearing states and profiles.
Retries, locks, pinning, IPNS confirmation and replication use the normal seedbox
publication lifecycle. Updating the client before publishing the new directory
format is required for older clients that only recognize a disk/state pair.

The JSON is a list, at most 64 KiB and one profile per origin. Each profile has
`version:2`, canonical `cid` of the base disk, `unitBytes:65536`, 32 `ranges` slots
(inclusive unit pairs or `null`), and `origin:{kind:"boot"}` or
`origin:{kind:"state",sha256:"…"}`. The hash covers the complete encrypted state
file. Exported metrics are `minUtilization`, `observedUnits`, `coveredUnits` and
`downloadUnits`; the generator retains a 50% utilization floor. Files contain
public access-pattern hints, not decrypted disk contents, RAM, or credentials.

The disk API adds `startLoadAnalysis({origin:"boot"|"restored"})`,
`finishLoadAnalysis()` and `cancelLoadAnalysis()`. For states, start immediately
after successful `commitState`, before ordinary reads or writes. Identity comes
from authenticated state decoding. Legacy boot analysis APIs still export v1;
explicit legacy `bootProfile` injection remains supported for boot only.

`setLoadPrefetch({origin:"boot"|"restored",scope:"none"|"profile"|"disk"})`
returns after scheduling, without waiting for metadata or disk downloads. `profile`
stops after selected ranges; `disk` continues through the remaining base. Raising
the scope retains cached blocks and in-flight work. Demand reads take priority.
`readStats().remote.loadProfile` reports selection/status/errors;
`rangeProfile` reports range coverage, distinct from whole-disk completion.
Missing, mismatching or invalid profiles fall back to normal demand/full behavior
for the selected scope; required disk read errors still stop the VM for retry.

my98 selects the origin before starting background full download. jlxip.net shows
its restored homepage immediately, requests only its state profile, and extends
to the complete disk on **Exit The Matrix**. Early interactions may still wait
for data. Persistence is opt-in for read-only consumers; see `persistent-cache.md`. No new loading bar is provided.
