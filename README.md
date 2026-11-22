# my98

**THIS README IS WIP, I'M IN THE PROCESS OF SIMPLIFYING EVERYTHING**

## What

Your Windows 98 computer, from anywhere in the world, without a server running a VM.

Powered by [v86](https://github.com/copy/v86) ([my fork](https://github.com/jlxip/slop86), actually), the VM runs inside the browser via a JIT compiler that translates x86 to WebAssembly. It's surprisingly fast for simple (old) operating systems. Windows 98 is the sweet spot: few background tasks and minimal animations.

The website is static. For best performance, serve it over HTTPS (or localhost) with cross-origin isolation enabled through the `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` headers. These enable the browser's high-resolution timers. Or just use [my98.lol](https://my98.lol), hosted on GitHub Pages. On static hosts that cannot set these headers, my98 tries to enable isolation with a service worker.

[FeedTorrent](https://github.com/jlxip/FeedTorrent) keeps encrypted disks and states available while the browser is closed. A signed BEP46 pointer selects a standard BEP49 catalog containing `disk.torrent` and optional `state.torrent` and `profile.torrent` items. The browser verifies the signed pointer, catalog pieces and child metadata, then downloads encrypted data over WebRTC. HTTPS is used only for the public DHT read gateway; WSS provides signaling. There are no HTTP content sources or my98-specific seedbox services.

Each open session uses one immutable snapshot. Later gateway observations preserve the highest signed sequence for the next opening; conflicting signed records invalidate subsequent reads. Sequences remain exact throughout, including values beyond JavaScript's safe integer range.

The username, password and machine fields are cryptographically combined to produce a master key. Encryption keys and the publishing keypair are derived from it. There is no account registration: the same three fields reproduce the same identity. Keep them safe, because there is no password reset. Seedboxes store encrypted disks and states; they do not need your password or private keys.

Published disk data is downloaded as needed and cached in the browser. Changes remain local until you save and publish them. Closing the tab discards unsaved changes.

## Quickstart

### Create a VM

1. Open [my98.lol](https://my98.lol).
2. Fill in the username, password and machine fields. Please use a strong password.
3. Select **Disk → Create empty disk...**. 512 MiB or 1 GiB is more than enough. You can discard the downloaded empty disk if you are going to install Windows now.
4. **Boot**.
5. Use **Insert CD** to select your [Windows 98 installation ISO](https://winworldpc.com/product/windows-98/98-second-edition) (a bootable OEM edition is recommended), reboot, and install.
6. Once installed, shut down Windows from its Start menu, then select **Disk → Save full disk after Windows shutdown...**. Keep the new `.my98` file: it contains your installed system. Use **Disk → Open encrypted disk...** to reopen it with the same credentials.

### Configure distribution

Run FeedTorrent on a machine that will remain online. Configure its WebRTC signaling and, for browser discovery, enable its DHT read gateway behind an HTTPS proxy. Keep its administrative API private. This repository does not deploy or administer remote FeedTorrent instances.

The website reads `torrent-sources.json` from its own origin. The repository configures Piensa’s public DHT gateway and the WSS trackers shared with its FeedTorrent instance:

```json
{
  "gateways": [
    "https://piensa.jlxip.net:8445"
  ],
  "trackers": [
    "wss://tracker.btorrent.xyz",
    "wss://tracker.openwebtorrent.com",
    "wss://tracker.webtorrent.dev"
  ]
}
```

`make site` includes this file in the static site. The provisional CLI reads the same file by default. Replace these URLs for another deployment. A missing configuration still allows local disk use in the browser; publication lookup requires a gateway and WebRTC access requires working signaling.

Opening uses the highest authenticated pointer already preserved in browser storage
while checking for updates in the background. Other open tabs re-read authenticated
replay protection after an observation, so a proven conflict also stops affected
cached and in-flight reads in those sessions. The publication notice shows the
selected version and the check outcome; a newer version applies to the next
opening, never to the disk, state or profile of an active session. Fresh readers
request progressive DHT observations when the gateway supports them and remain
compatible with terminal JSON gateways. These are observed signed versions, not
a guarantee of the globally latest publication.

A pair of different signed values at one sequence blocks that version and is
preserved with replay protection even when ciphertext caches are cleared. A valid
higher signed sequence supersedes the blocked version. An unsigned gateway error
does not create durable conflict evidence. Damaged replay protection requires
explicit recovery; it is not silently discarded. API consumers can set
`waitForFinal:true` to wait for the lookup outcome before selecting a snapshot.
Network failures remain visible even when a verified cached snapshot is usable.

### Publish a snapshot

The provisional CLI uses the existing my98 username, password and machine identity. Build it with `make torrent-native`. This prepares the exact FeedTorrent source revision and its native libraries in `build/`; the upstream sources are kept intact. Native Cargo commands run from that pinned source to use FeedTorrent’s toolchain (Rust 1.95 on macOS/Linux; system Rust on OpenBSD), independently from the existing browser/WASM build.

```sh
build/torrent-target/release/my98-torrent --config torrent-sources.json --machine main publish disk.my98
```

The CLI is covered by my98’s GPL-3.0 license. FeedTorrent’s pinned sources retain their native dependency licenses in `build/feedtorrent`; its existing `licenses` target collects their notices for native distribution.

Enter the original credentials when prompted. Password input is hidden on a terminal; credentials and private keys are never saved. The CLI snapshots the input, publishes the signed pointer and stays running to seed its data. It does not contact remote administrative APIs or open SSH tunnels.

Once, add the printed BEP46 magnet to FeedTorrent, select **Mirror all**, and set its automatic download limit to admit your disk and state sizes. Subsequent publications are followed automatically on FeedTorrent’s normal polling schedule (currently every 15 minutes). **The pointer is published before the remote copy is complete.** Check the replica's verified progress in FeedTorrent before stopping the publisher.

After an interruption, resume the saved snapshot without making a new version or entering credentials:

```sh
build/torrent-target/release/my98-torrent --config torrent-sources.json resume
```

The default publisher directory is `~/.local/share/my98/feedtorrent-publisher`. Use `--root` to select another private directory; each root belongs to one identity. Keep its journal and object files together. `resume` rechecks its saved payloads before sharing them.

### States and load profiles

Use **State → Save state...** to export the running session. A `.my98state` file requires its exact original base disk. Publish both together:

```sh
build/torrent-target/release/my98-torrent --config torrent-sources.json publish disk.my98 --state session.my98state --profile load-profile.json
```

Every publication is a complete snapshot. Omitting `--state` or `--profile` removes that component from the new publication; old components are not implicitly retained. Profiles must match the disk's infohash and, for a state profile, the state's SHA256. The CLI checks those relationships before announcing the pointer. Choose **Resume state** after logging in to restore a published session.

Publication from the browser is not implemented yet. The old JSON descriptor, Python daemon, webseeds and migration tools are not supported.

## Validation

`make site-test` checks the website, local VM flows, browser piece store and publication protocol. `make torrent-test` checks the provisional CLI and its focused regressions. `make torrent-integration-test` exercises a private DHT, WSS tracker, gateway, native publisher, FeedTorrent replica and the shipped reader in Chromium, Firefox and WebKit, with no production publications.

The browser transport sends an early SDP after obtaining a public UDP candidate, while ICE gathering continues. If that connection stalls, a bounded independent attempt uses ordinary gathering. Reviewed source forks and upstream fingerprints live in `vendor/webrtc-ice`; dependency upgrades require reviewing those sources. `tests/torrent-ice.mjs` covers signaling, fallback and peer cleanup in the three browser engines.
