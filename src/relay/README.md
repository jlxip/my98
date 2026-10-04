# Private seeder relay

The optional relay grants Internet egress only to explicitly authorized relay
public keys. Following an IPNS name never authorizes network access. Each
authenticated WebSocket owns one isolated libslirp stack. The browser keeps the
signing seed inside its identity Worker; saved machine states carry no signer.

Build on Debian 13 with `apt-get install cargo rustc gcc pkg-config libslirp-dev libglib2.0-dev`,
or on macOS with `brew install libslirp pkg-config` and Rust. Run
`cargo build --manifest-path src/relay/Cargo.toml --locked --release`.
The committed Cargo.lock pins transitive dependencies. The C bridge targets
libslirp >=4.8; Debian/macOS libraries are supplied by platform security updates.
Use `cargo test --manifest-path src/relay/Cargo.toml --locked` for protocol and
firewall tests; `node --test tests/relay-network.test.mjs` tests the adapter.
On small seeders, build with one Cargo job and a supervised memory limit;
run tests in the debug profile. Release-test linking can exhaust a 2 GiB
host while Kubo is running. Build artifacts must live outside `/tmp` so a
reboot does not discard them.

The daemon takes a JSON configuration path (see `ops/config.example.json`).
`enabled` defaults to false, including when absent. A disabled configuration
exits successfully before binding sockets or reading the authorization file.
It binds only 127.0.0.1:8090. Its root-owned configuration defines its exact
public WSS URL, allowed browser origins, local administration socket and
authorization file. Initialize the authorization file with `[]`, mode 0600.
Configure `host_ips` with any public NAT addresses of the host; interface
addresses are additionally denied by the C bridge. Only proxy
`/my98-relay/v1` and `/.well-known/my98-relay.json` through the existing TLS server. Administration/health use
the Unix socket, mode 0600, and must never be proxied.

The packaged systemd unit uses a separate `my98-relay` system user, resource
limits, automatic restart, and protected filesystem. Install the executable
under `/usr/local/lib/my98-relay`, config under `/etc/my98-relay`, authorization
file under `/var/lib/my98-relay`. Run administration as that service user:

```sh
sudo -u my98-relay my98-seedbox relay-status
sudo -u my98-relay my98-seedbox relay-allow PUBLIC_KEY_HEX
sudo -u my98-relay my98-seedbox relay-revoke PUBLIC_KEY_HEX
```

These commands do not require Kubo, modify subscriptions or export disk keys.
Revocation closes active sessions and persists before success is returned.
Back up the previous executable, configuration, authorization file and TLS
proxy configuration before upgrades. Roll back by stopping `my98-relay` and
restoring the TLS proxy configuration without its relay route; validate before
reloading the proxy. Existing IPFS routes remain independent of this service.

## Discovery and deployment

The client queries `/.well-known/my98-relay.json` on its existing Resolution /
Discovery servers marked as seeders and verified disk-provider origins. Public
query-only services are not queried for relay capabilities. There is no relay
URL in the compiled inventory. The first valid announcement wins; the round
is limited to 16 origins, four seconds, and 4 KiB per response, without
redirects, cookies or caching. Only same-origin WSS at `/my98-relay/v1` with
protocol `my98-relay.v1` and `ed25519-allowlist` authorization is accepted.
No announcement, a disabled service or an invalid response leaves the guest
offline. Transient retries repeat discovery; authorization rejection waits
for explicit retry. Announcements never confer authorization.

The enabled daemon serves only this anonymous descriptor on the local listener:

```json
{"version":1,"relay":{"url":"wss://relay.example/my98-relay/v1","protocol":"my98-relay.v1","authorization":"ed25519-allowlist"}}
```

For Debian, install runtime libslirp and Python, and use a native binary built
on Debian 13 (or build locally with the tools above). From the source checkout:

```sh
sudo python3 scripts/deploy-relay.py install \
  --binary build/relay-target/release/my98-relay \
  --url wss://relay.example/my98-relay/v1 --host-ip PUBLIC_IPV4 \
  --nginx-config /etc/nginx/sites-available/my98-gateway
```

This installs the separate user, config, binary and supervised unit, creates
an empty allowlist, backs up existing files and installs/validates the nginx
routes when requested. **A new install stays disabled.** Upgrades preserve a
previous explicit opt-in and its allowlist. Omitting `--nginx-config` leaves
the TLS server untouched; add both exact routes using its native configuration
(Caddy can `reverse_proxy 127.0.0.1:8090` for each path).

Activation and deactivation are separate root commands:

```sh
sudo python3 scripts/deploy-relay.py enable
sudo -u my98-relay python3 scripts/seedbox.py relay-allow PUBLIC_KEY_HEX
sudo python3 scripts/deploy-relay.py disable
```

On OpenBSD the installer selects rc.d (`my98_relay`), a foreground restart
supervisor, a restricted login class, and `/var/run/my98-relay/admin.sock`.
Use `doas /usr/local/bin/python3` instead of sudo; seedbox selects this socket
automatically on OpenBSD. Its explicit soft/hard descriptor limits request
8192; the effective value may be clamped by `kern.maxfiles`. Validate against
that kernel ceiling without changing the global limit. The rc.d files are prepared; native build,
resource limits and restart acceptance must be verified before activating an
OpenBSD deployment. OpenBSD 7.9's packaged libslirp 4.7 is too old: supply a
maintained libslirp >=4.8 and native Rust toolchain. Do not lower the version
check or load a Linux binary on OpenBSD. Installing a disabled daemon does not
imply a working public relay.

For an unprivileged native build, install `rust meson ninja glib2` with
`doas pkg_add`, then run `sh scripts/build-relay-openbsd.sh`. This builds the
pinned upstream libslirp 4.9.5 source (SHA256 checked) into a private build
prefix, with one compiler job and a 1 GiB data limit. Install with
`--binary build/relay-openbsd/target/release/my98-relay` and
`--slirp-libraries build/relay-openbsd/slirp-native/lib`; the binary's rpath
points at the dedicated installed library directory. The platform package's
glib remains in use. Keep the source build and runtime library maintained
independently of the older OpenBSD libslirp package.

## Reverse proxy requirements

Forward only `/my98-relay/v1` and `/.well-known/my98-relay.json` to the
local daemon at `127.0.0.1:8090`. The WebSocket route must preserve the
Origin and `my98-relay.v1` subprotocol, support duplex traffic and apply
bounded buffering when either side stops reading. Preserve a first frame
sent with the upgrade request and leave ordinary HTTP keep-alive working.

The reverse proxy's source, build and maintenance belong to its own
repository. Installing this daemon does not replace the gateway executable
or its supervisor. A stopped relay must expose no capability announcement.

## Authentication protocol v1

Require `Sec-WebSocket-Protocol: my98-relay.v1` and an allowed Origin. The client
sends `{"type":"hello","publicKey":"64 lowercase hexadecimal characters"}`.
Unknown keys receive close code 1008 without a challenge or network allocation.
An authorized key receives a JSON challenge containing `url`, `origin`, a
32-byte hex `nonce`, and Unix-seconds `expires` (ten seconds).

The signature covers `my98/relay-challenge/v1\0`, then public key, exact public
URL, Origin, nonce, expiry. Every field has a big-endian u32 byte length; expiry
is a big-endian u64. The key is Ed25519, derived from the existing Argon2 master
with HKDF-SHA256, salt `slop86/keys/v1`, info `my98/relay-signing/v1`.
The identity and metadata key derivations/formats are unchanged. A read-only
capability cannot derive this key. The client sends
`{"type":"authenticate","signature":"128 lowercase hexadecimal characters"}`.
The daemon checks the single challenge held by this exact socket, its expiry,
strict Ed25519 verification and authorization. After `{"type":"ready"}` each
binary message is one Ethernet frame, 14..1514 bytes. Other messages terminate
the session. No guest frames are buffered before readiness.

IPv4 network 10.5.0.0/16, gateway/DNS 10.5.0.1, DHCP starts at 10.5.0.100,
MTU 1500. TCP/UDP egress to public IPv4 only; virtual DHCP/DNS are the sole
private exceptions. Deny host interfaces/NAT addresses, private, loopback,
link-local, shared, reserved, multicast and benchmarking/documentation ranges.
Reject IPv6, IP options/source routing and unsupported IP protocols. DNS/DHCP
exceptions reject fragmentation to prevent port ambiguity; ordinary public
TCP/UDP fragments still pass the destination gate. TFTP, host/guest forwarding
and protocol helpers are disabled. ARP remains inside its stack.

At most four authenticated sessions, 32 pending handshakes and eight local
administrators. Authentication/WebSocket reads, writes and heartbeat waits
have deadlines. Guest input/output queues hold at most 256 frames each;
overflow drops frames, allowing TCP to retransmit. Logs contain only fixed
state/error names. Local status exposes counts, never passwords, signatures,
network destinations or payloads.

The browser connects automatically, boots offline on failure, and retries
transient disconnects with 1..30-second backoff. Policy rejection requires
explicit retry. Reconnecting does not recreate the VM or discard RAM/writes;
old TCP connections can fail. No fallback to a public relay.

The WSS connection starts in parallel with the machine. Normal cold boots
obtained DHCP automatically in the Chromium/WebKit acceptance tests, but the
machine does not wait for authentication before starting. If Windows already
booted without a working relay, or a restored state carries stale network
configuration, connecting the relay does not force Windows to renew DHCP.
If the relay is connected but the guest still has no Internet, run inside
Windows 98:

```bat
ipconfig /release_all
ipconfig /renew_all
```

This renews the guest configuration without rebooting or replacing the VM.

## Acceptance

`make relay-test` covers authentication, replay, expiry, revocation, limits,
destination filtering and local CLI/adapter behavior. `make relay-test-browser`
uses the real identity Worker in Chromium and WebKit, including read-only
rejection, reconnecting without replacing the VM, and identity closure.

Install `tests/relay-requirements.txt` into a Python virtual environment, then
run `tests/relay-acceptance.py --help`. That harness drives Ethernet against
the real WSS service, authorizes a random temporary key through a configurable
local administration command, and revokes it in `finally`. It tests DHCP,
DNS over UDP/TCP, HTTP, HTTPS with certificate verification, private/host
destination blocking, revocation and isolation with identical guest MAC/IP.
A restricted public HTTP/UDP fixture enables echo and 512 KiB transfer checks.
Its external mode leaves administration on the operator's machine: it prints
only the ephemeral public key and waits for authorization.

`tests/pages/relay-win98.mjs` additionally boots and restores a real encrypted
Windows 98 fixture in both browser engines, checks RAM/writes across network
reconnection, and verifies that closing the identity disconnects only its
network. Set `MY98_RELAY_WIN98_FIXTURE` to a fixture JSON, and
`MY98_RELAY_ADMIN_JSON` to the JSON array of the administration command prefix.
Run it through `scripts/run-browser-test.mjs`; the server must use port 8686.
This uses the public test identity, never a personal password. Revoke test
keys and remove temporary network infrastructure after the pilot. Personal
acceptance requires a key copied from the actual user's login; passing with
temporary keys alone does not authorize that identity.
For the original Spanish Windows fixture, `MY98_RELAY_HTTP_PROBE` can point to
a restricted HTTP fixture returning `my98 Internet works`. The test completes
its first-run LAN wizard, checks that payload on the actual NE2K receive bus,
and saves the Internet Explorer screenshot. Both test VMs disable their audio
adapter before initialization; no sound is emitted, including in WebKit.
To test an actual service interruption, set `MY98_RELAY_RESTART_JSON` to the
JSON array of a trusted restart command. With the guest paused, the harness
restarts the daemon and waits for automatic authentication on a new WebSocket,
then checks the same VM, RAM and pending writes. Use a dedicated test service
or a pilot with no other active sessions.
