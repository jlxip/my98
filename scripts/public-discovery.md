# Public discovery and infohash startup

This is the new protocol. Public deployment follows isolated acceptance; the
previous backend remains running and unchanged after publication as well.
The legacy deployment history is recorded in `transport-migration.md`.

## Records

Both records use the identity Ed25519 key and BEP44 signing bytes. The publication
salt is `my98/publication/v1` (unchanged BEP46 value `d2:ih20:<infohash>e`). The
independent locations salt is `my98/locations/v1`. Its bencoded value is
`d7:originsl<sorted unique HTTPS origins>e7:versioni1ee`, at most 1000 bytes.
Origins have no path, credentials, query or fragment. HTTP is restricted to
loopback test fixtures. Sequence numbers are positive JavaScript safe integers;
clients preserve separate high water marks for publication and locations.
An equal sequence with different signed contents is a conflict.

`locations` signs the origins from the publisher configuration without changing
its publication. Normal publishing copies all ciphertext to one directly observed
seedbox before committing locations and then the publication. Journals contain
signed records and ciphertext references, never private keys or credentials.
Followers persist and reannounce both signatures, and never need the signing key.

## HTTP and transfer

- `GET /v2/dht/{publicKey}/{saltHex}` resolves either supported mutable record for
  any identity. Follow membership is irrelevant. A miss returns 404; saturation
  returns 429. Concurrent identical requests share one lookup. The cache holds at
  most 128 results (30 seconds positive, 5 seconds negative), with 8 simultaneous
  native lookups and a 21-second overall deadline. For configured identities,
  the node serves its already-published signature-verified records immediately
  while refreshing DHT in the background. Polls share pending refreshes instead
  of dropping the reader cache. The highest observed sequence is retained;
  conflicting equal-sequence contents block the fast path until a completed
  lookup succeeds. Foreign identities still use public DHT without follow or
  content admission. Resolution never adds a torrent.
- `GET /v2/info/{infohash}` returns a raw bencoded `info` dictionary from the
  seedbox’s own validated metadata cache. A missing or foreign hash returns 404;
  this endpoint never starts a lookup or download. Clients verify SHA-1 and the
  supported single-file schema before selecting payload pieces.
- `POST /v2/candidates` accepts exactly `{record: <signed publication>}` for a
  followed identity. It returns admission (202), not proof of a complete copy.
  Metadata comes from native peers through BEP9. The publisher keeps its direct
  connection until the same configured seedbox advertises every piece.
- `/content/{infohash}/{filename}` serves verified ciphertext with HTTPS ranges.
  WebRTC obtains metadata by infohash through BEP9. Internal metadata caches are
  automatic and are not a user-supplied `.torrent` interface.
- Common Aquatic trackers use an empty deny list and admit unrelated swarms.
  This does not change the seedbox’s explicit follow/admission policy.

The browser resolves the signed publication and starts WebRTC through common
trackers without waiting for optional signed locations. Verified locations add
HTTPS metadata sources to pending lookups and webseeds to active torrents as soon
as they arrive. Missing, unavailable, invalid or conflicting locations do
not prevent opening through WebRTC. Only verified locations supply HTTPS sources
when opening by identity; resolver addresses are public infrastructure defaults,
not a fallback list of the user's seedboxes. Cancellation and publication errors
still stop opening. Node polling likewise applies publication and locations
results independently, without waiting for the other lookup or sharing errors.

Metadata discovery starts BEP9/WebRTC immediately and every available HTTPS
`/v2/info` source together. HTTPS requests have their own ten-second deadline;
they never shorten or cancel the independent WebRTC deadline.
The canonical signed origin order never sets a network priority. Only a
verified infohash and supported schema can win. The losing HTTP request is
aborted and the metadata-only peer is destroyed before creating the lazy payload
reader. WebRTC-only and HTTPS-only sources remain supported; discovery never
selects payload pieces.

Published state ranges are consumed in file order. The reader keeps at most four
range requests active and reserves at most sixteen 256 KiB ranges (4 MiB,
including in-flight requests). A completed range replenishes an active lane even
when an earlier range is still pending; completed unread ranges still occupy
reserved capacity. Once the reservation window fills, only consumption can
admit another range. Failure, short reads and cancellation abort all pending
requests without refilling the window. This bound applies to state read-ahead;
WebTorrent's piece cache and the state decoder have their own storage.

## Independent deployment

The new installation uses `/opt/my98-torrent-v2/runtime`,
`/var/lib/my98-torrent-v2`, account `my98torrentv2`, supervision prefix
`my98-torrent-v2` (`my98_torrent_v2` on OpenBSD), HTTPS/WSS 8445 and BitTorrent
TCP/UDP 51414. The administrative API defaults to loopback 17598; configure
separate unused loopback tracker ports. Preflight rejects occupied ports before
installing or starting the new services. Existing TLS issuance, renewal and relay
remain shared and untouched.

Build packages using `package-torrent-runtime.py`, or use
`repack-torrent-runtime.py --base VERIFIED_ARTIFACT --output NEW_DIRECTORY` to
reuse exactly the verified native binaries and offline wheels with current source.
Repacking verifies every base file and unchanged dependency locks. Its archives
normalize timestamps, ownership and gzip headers for byte-for-byte reproduction.
Install into a fresh runtime; the new installer accepts protocol 2 only. Oregon
receives the accepted Linux package without compiling.

Deployment order is NUC, Piensa, Oregon, followed by verified ciphertext copies
and new signed locations. Only then may the user publish my98 and subsequently
jlxip.net with its dependency pinned. Verify both public websites while retaining
the old backend unchanged: services, processes, ports, TLS, configuration and data.
Retiring the old backend is outside this publication.
The offline recovery snapshot is not a compatibility layer in the new runtime.
