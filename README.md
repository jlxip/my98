# my98

**THIS README IS WIP, I'M IN THE PROCESS OF SIMPLIFYING EVERYTHING**

## What

Your Windows 98 computer, from anywhere in the world, without a server running a VM.

Powered by [v86](https://github.com/copy/v86) ([my fork](https://github.com/jlxip/slop86), actually), the VM runs inside the browser via a JIT compiler that translates x86 to WebAssembly. It's surprisingly fast for simple (old) operating systems. Windows 98 is the sweet spot: few background tasks and minimal animations.

The website is static. For best performance, serve it over HTTPS (or localhost) with cross-origin isolation enabled through the `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` headers. These enable the browser's high-resolution timers. Or just use [my98.lol](https://my98.lol), hosted on GitHub Pages. On static hosts that cannot set these headers, my98 tries to enable isolation with a service worker.

A server is only needed to keep the virtual disk image available while your browser is closed. This is done using BitTorrent, with WebTorrent and HTTPS webseeds for browser access. To point to the latest image without changing the machine's identity, [BEP 46](https://www.bittorrent.org/beps/bep_0046.html) is used: a signed record in the BitTorrent DHT points to a descriptor torrent, which references separate disk, state and load-profile torrents.

The DHT also lets native BitTorrent peers discover one another without a fixed list of peer IP addresses. Public resolvers look up signed publication and seedbox-location records for any identity, without hosting its data. The browser verifies the publication and discovers WebRTC peers through common trackers. Optional signed seedbox locations add HTTPS sources; missing or unusable locations do not prevent WebRTC access. You can use my98.lol with your credentials alone; you do not need to configure your servers on the website.

Browser startup proceeds with the first authenticated publication at or above
the durable version already observed. Other replicas continue in the background:
newer versions are preserved for the next opening, without replacing the active
immutable disk; a later signed publication conflict fails subsequent reads.
Signed location hints can enable HTTPS before every replica answers. Conflicting
location hints are revoked without disabling WebRTC and are not persisted.
The first reachable HTTPS source starts payload work immediately. Other sources
remain backups; one second without verified piece progress during active work
promotes the next available backup and releases the stalled source's requests.
No particular server is preferred by name. Healthy HTTPS metadata gets a 250 ms
head start before speculative WebRTC offers; unavailable HTTPS starts the peer
backup immediately. Payload trackers remain connected without requesting offers
while HTTPS progresses, and request peers if payload stalls. HTTP connections use
WebTorrent's connection extension point so removal aborts the actual fetch too.
Metadata and piece hashes are still verified, and cancellation stops source probes.

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

### Set up a seedbox

A seedbox keeps your encrypted disk online and follows signed updates. It only accepts identities listed in its `follow` configuration. The default servers will not host your disk.

#### On your computer

Clone this repository and build the publisher. You need Python 3.13 with development headers and venv support, a C++ compiler, CMake, Make and OpenSSL development files:

```sh
git clone https://github.com/jlxip/my98.git
cd my98
python3.13 scripts/build-torrent.py --root build/torrent-native/local --webrtc off
python3.13 scripts/install-torrent-python.py --python build/torrent-native/local/venv/bin/python
```

To get your publishing public key, run the command below and enter the same username and password you used in the browser. Set `--machine` to the same machine name:

```sh
build/torrent-native/local/venv/bin/python scripts/my98-torrent.py --machine main identity
```

Keep the returned `publicKey` for the seedbox configuration. This is a public key, not a password.

#### On the server

The commands below target Debian 13 on x86_64 with systemd. You need a domain pointing to the server, sudo access and storage for the complete encrypted disk plus replacements. Replace `seedbox.example.com` throughout with your hostname.

Install the build dependencies, then build and package the services as your regular user:

```sh
sudo apt-get update
sudo apt-get install -y git build-essential cmake pkg-config libssl-dev libffi-dev python3.13-dev python3.13-venv ca-certificates openssl certbot

git clone https://github.com/jlxip/my98.git
cd my98
python3.13 scripts/build-torrent.py --root build/torrent-native/seedbox --webrtc on
python3.13 scripts/install-torrent-python.py --python build/torrent-native/seedbox/venv/bin/python
python3.13 scripts/build-aquatic.py --root build/torrent-aquatic
python3.13 scripts/build-torrent-nginx.py --root build/torrent-nginx
python3.13 scripts/package-torrent-runtime.py --native build/torrent-native/seedbox --aquatic build/torrent-aquatic --nginx build/torrent-nginx --output build/torrent-release
```

Obtain a TLS certificate. This standalone command needs TCP port 80 to be reachable and free; if you already manage certificates for this hostname, use their existing paths in the configuration instead:

```sh
sudo certbot certonly --standalone -d seedbox.example.com
```

Save the following as `seedbox.json` in the repository root. Replace `YOUR_PUBLIC_KEY` with the 64-character key returned on your computer, and adjust the hostname and certificate paths:

```json
{
  "hostname": "seedbox.example.com",
  "root": "/var/lib/my98-torrent-v2",
  "runtime": "/opt/my98-torrent-v2/runtime",
  "python": "/opt/my98-torrent-v2/runtime/venv/bin/python",
  "nginx": "/opt/my98-torrent-v2/runtime/release/bin/nginx",
  "certificateSource": "/etc/letsencrypt/live/seedbox.example.com/fullchain.pem",
  "keySource": "/etc/letsencrypt/live/seedbox.example.com/privkey.pem",
  "node": {
    "follow": ["YOUR_PUBLIC_KEY"],
    "listen": "0.0.0.0:51414,[::]:51414",
    "webrtcPort": 51415,
    "api": {"host": "127.0.0.1", "port": 17598},
    "aquatic": {
      "binary": "/opt/my98-torrent-v2/runtime/release/bin/aquatic_ws",
      "listen": [
        {"host": "127.0.0.1", "port": 17599},
        {"host": "::1", "port": 17600}
      ]
    }
  }
}
```

Allow inbound TCP 8445, TCP/UDP 51414 and UDP 51415 through the server firewall and any router or provider firewall. Linux seedboxes use UDP 51415 for WebRTC connections; OpenBSD seedboxes only need the first two ports. Each service checks that its requested ports are free and refuses to choose another port. Keep TCP 80 available for certificate renewal if you used standalone Certbot. The local ports 17598–17600 do not need to be exposed.

Install and start the services:

```sh
sudo python3.13 scripts/install-torrent-services.py --artifact build/torrent-release --config seedbox.json --activate
sudo systemctl status my98-torrent-v2 my98-torrent-v2-https
```

The installer enables startup at boot and hourly copying of renewed TLS certificates. Certificate issuance and renewal remain Certbot's job.

From your computer, check `https://seedbox.example.com:8445/health`. It should return `{"ready":true}` over valid TLS.

#### Connect the publisher

On your computer, save this as `publisher.json` in the repository root, replacing the hostname:

```json
{
  "nodes": [{
    "name": "seedbox",
    "api": "https://seedbox.example.com:8445",
    "peer": ["seedbox.example.com", 51414]
  }],
  "trackers": ["wss://nuc.jlxip.net:8445/tracker", "wss://oregon.jlxip.net:8445/tracker"],
  "webseeds": ["https://seedbox.example.com:8445/content/"]
}
```

The publisher signs your seedbox HTTPS origins and publishes them in the DHT alongside the publication. Common trackers connect browsers to native WebRTC seeders, including seedboxes outside our servers. OpenBSD seedboxes provide HTTPS access. No `.torrent` files are needed: peers exchange metadata automatically, and HTTPS clients verify the seedbox’s raw `info` dictionary against its infohash.

### Publish your VM

On your computer, from the repository root:

```sh
build/torrent-native/local/venv/bin/python scripts/my98-torrent.py --config publisher.json --machine main publish disk.my98
```

Use your saved disk's filename, machine name and original credentials. The CLI waits until one configured seedbox has a complete copy before publishing the signed DHT update. Once it finishes, you can close the publisher. Open [my98.lol](https://my98.lol) on another device, log in, then select **Boot**.

If a publication is interrupted, replace `publish disk.my98` with `resume` to continue with the same configuration and credentials.

After changing seedboxes in `publisher.json`, update their signed locations without republishing the disk:

```sh
build/torrent-native/local/venv/bin/python scripts/my98-torrent.py --config publisher.json --machine main locations
```

## Extras

### Save a running session

Use **State → Save state...** to save RAM, device state and pending disk writes without shutting down Windows. The `.my98state` file requires the exact base disk it was saved against, so keep both files together. Reopen that disk and use **State → Load state...** to restore it.

To publish a session, upload its original base disk and state together:

```sh
build/torrent-native/local/venv/bin/python scripts/my98-torrent.py --config publisher.json --machine main publish disk.my98 --state session.my98state
```

Choose **Resume state** after logging in to continue that session. To replace only the state of an already published disk, use `state session.my98state` instead of `publish …`. Use `clear-state` to remove it from the publication.

### Load profiles

**Tools → Analyze loads** records which disk ranges are read during boot or state restoration and the actions you perform afterwards. Stop analyzing to download a JSON profile. Publishing it lets the browser prioritize those ranges on future loads:

```sh
build/torrent-native/local/venv/bin/python scripts/my98-torrent.py --config publisher.json --machine main profile load-profile.json
```

Profiles are tied to a particular disk and, for a resumed session, its state. If a state update rejects an incompatible profile, add `--clear-profile` to that update. Use `clear-profile` to remove a published profile separately.
