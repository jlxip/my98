# Load profiles

Profiles are public hints for an immutable disk torrent. A version 2 profile contains
`infoHash` (40 lowercase hexadecimal digits), `origin` (`boot` or `state` with the
state SHA-256), `unitBytes:65536`, and 32 bounded non-overlapping `ranges` slots.
The encrypted disk and state authentication remain authoritative.

`generate-boot-ranges.mjs` accepts a trace with `infoHash` and `firstTouchUnits`.
The range selection and validation utilities remain available during the transport
replacement. Remote collection and publication are integrated with the new client
and CLI in the subsequent implementation phases.
