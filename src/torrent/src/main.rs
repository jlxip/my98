//! Temporary CLI: publish a complete snapshot, then seed until interrupted.
use anyhow::{bail, ensure, Context, Result};
use bendy::value::Value as BValue;
use clap::{Parser, Subcommand};
use feedtorrent_bep::{
    bep44::*,
    bep46::{self, TorrentPointer},
    bep49::{BuildEntry, FeedBuilder, OuterValue},
    AddTransfer, TorrentBackend, TorrentSource,
};
use feedtorrent_libtorrent::LibtorrentBackend;
use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};
use std::{
    borrow::Cow,
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    os::unix::{
        fs::{OpenOptionsExt, PermissionsExt},
        io::AsRawFd,
    },
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use zeroize::Zeroizing;
mod formats;
const SALT: &[u8] = b"my98/publication/v1";
static STOP: AtomicBool = AtomicBool::new(false);
extern "C" fn stop(_: libc::c_int) {
    STOP.store(true, Ordering::Relaxed);
}
#[derive(Parser)]
#[command(about = "Publish a my98 BEP49 snapshot; keep it seeded until a replica is complete")]
struct Args {
    #[arg(long, global = true)]
    root: Option<PathBuf>,
    #[arg(long, default_value = "torrent-sources.json", global = true)]
    config: PathBuf,
    #[arg(long, default_value = "main", global = true)]
    machine: String,
    #[arg(long, global = true)]
    isolated: bool,
    #[arg(long, default_value = "", global = true)]
    dht_bootstrap: String,
    #[arg(long, default_value_t = 0, global = true)]
    port: u16,
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    Publish {
        disk: PathBuf,
        #[arg(long)]
        state: Option<PathBuf>,
        #[arg(long)]
        profile: Option<PathBuf>,
    },
    Resume,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    #[serde(default)]
    gateways: Vec<String>,
    trackers: Vec<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    key: String,
    salt: String,
    sequence: String,
    signature: String,
    value: String,
}
impl Record {
    fn from(r: &MutableRecord) -> Self {
        Self {
            key: hex(&r.key().public_key()),
            salt: hex(r.key().salt()),
            sequence: r.sequence().to_string(),
            signature: hex(&r.signature()),
            value: hex(r.value().as_bytes()),
        }
    }
    fn verify(&self) -> Result<MutableRecord> {
        Ok(MutableRecord::verify(
            MutableKey::new(
                unhex(&self.key)?
                    .try_into()
                    .map_err(|_| anyhow::anyhow!("Invalid key"))?,
                unhex(&self.salt)?,
            )?,
            self.sequence.parse()?,
            BencodedValue::parse(&unhex(&self.value)?)?,
            unhex(&self.signature)?
                .try_into()
                .map_err(|_| anyhow::anyhow!("Invalid signature"))?,
        )?)
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Seed {
    id: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    version: u32,
    record: Record,
    torrents: Vec<Seed>,
}
fn hex(b: &[u8]) -> String {
    b.iter().map(|b| format!("{b:02x}")).collect()
}
fn unhex(s: &str) -> Result<Vec<u8>> {
    ensure!(
        s.len().is_multiple_of(2)
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "Invalid hex"
    );
    Ok((0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16))
        .collect::<std::result::Result<_, _>>()?)
}
fn atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let temp = path.with_extension("tmp");
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temp)
        .context("Pending temporary file; preserve it and inspect interrupted write")?;
    file.write_all(bytes)?;
    file.sync_all()?;
    fs::rename(&temp, path)?;
    File::open(path.parent().context("Missing directory")?)?.sync_all()?;
    Ok(())
}
fn file_hash(path: &Path) -> Result<Vec<u8>> {
    let mut file = File::open(path)?;
    let mut hash = Sha1::new();
    let mut buffer = [0; 65536];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
    }
    Ok(hash.finalize().to_vec())
}
fn snapshot(source: &Path, target: &Path) -> Result<()> {
    let mut input = File::open(source)?;
    let before = input.metadata()?;
    ensure!(before.is_file(), "Source must be a regular file");
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(target)?;
    let mut buffer = vec![0; 1024 * 1024];
    loop {
        ensure!(!STOP.load(Ordering::Relaxed), "Interrupted");
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        output.write_all(&buffer[..count])?;
    }
    output.sync_all()?;
    let after = input.metadata()?;
    ensure!(
        before.len() == after.len() && before.modified()? == after.modified()?,
        "Source changed during snapshot"
    );
    Ok(())
}
fn component(path: &Path, name: &str, trackers: &[String]) -> Result<Vec<u8>> {
    let mut file = File::open(path)?;
    let size = file.metadata()?.len();
    let piece = 256 * 1024;
    let mut buffer = vec![0; piece];
    let mut hashes = vec![];
    loop {
        let mut n = 0;
        while n < piece {
            let count = file.read(&mut buffer[n..])?;
            if count == 0 {
                break;
            }
            n += count;
        }
        if n == 0 {
            break;
        }
        hashes.extend_from_slice(&Sha1::digest(&buffer[..n]));
    }
    let blob = |bytes: Vec<u8>| BValue::Bytes(Cow::Owned(bytes));
    let mut info = BTreeMap::new();
    info.insert(
        Cow::Borrowed(b"name".as_slice()),
        blob(name.as_bytes().to_vec()),
    );
    info.insert(
        Cow::Borrowed(b"length".as_slice()),
        BValue::Integer(i64::try_from(size)?),
    );
    info.insert(
        Cow::Borrowed(b"piece length".as_slice()),
        BValue::Integer(piece as i64),
    );
    info.insert(Cow::Borrowed(b"pieces".as_slice()), blob(hashes));
    let mut outer = BTreeMap::new();
    outer.insert(Cow::Borrowed(b"info".as_slice()), BValue::Dict(info));
    outer.insert(
        Cow::Borrowed(b"announce-list".as_slice()),
        BValue::List(
            trackers
                .iter()
                .map(|t| BValue::List(vec![blob(t.as_bytes().to_vec())]))
                .collect(),
        ),
    );
    let mut encoder = bendy::encoding::Encoder::new().with_max_depth(64);
    encoder.emit(BValue::Dict(outer))?;
    let bytes = encoder.get_output()?;
    ensure!(
        bytes.len() <= 8 * 1024 * 1024,
        "Component metadata exceeds FeedTorrent's limit"
    );
    Ok(bytes)
}
fn metadata_id(bytes: &[u8]) -> Result<String> {
    match feedtorrent_bep::bep49::inspect_item(bytes) {
        feedtorrent_bep::bep49::ItemContent::Torrent(t) => Ok(hex(&t.infohash())),
        _ => bail!("Invalid component torrent"),
    }
}
fn input_line(prompt: &str, secret: bool) -> Result<String> {
    struct Echo(Option<libc::termios>);
    impl Drop for Echo {
        fn drop(&mut self) {
            if let Some(old) = self.0 {
                unsafe {
                    libc::tcsetattr(0, libc::TCSANOW, &old);
                }
            }
        }
    }
    let mut echo = Echo(None);
    if secret && unsafe { libc::isatty(0) } == 1 {
        let mut old = unsafe { std::mem::zeroed::<libc::termios>() };
        ensure!(
            unsafe { libc::tcgetattr(0, &mut old) } == 0,
            "Cannot read terminal settings"
        );
        let mut new = old;
        new.c_lflag &= !libc::ECHO;
        ensure!(
            unsafe { libc::tcsetattr(0, libc::TCSANOW, &new) } == 0,
            "Cannot hide password"
        );
        echo.0 = Some(old);
    }
    eprint!("{prompt}");
    io::stderr().flush()?;
    let mut bytes = Zeroizing::new(Vec::new());
    loop {
        ensure!(!STOP.load(Ordering::Relaxed), "Interrupted");
        let mut poll = libc::pollfd {
            fd: 0,
            events: libc::POLLIN,
            revents: 0,
        };
        let ready = unsafe { libc::poll(&mut poll, 1, 100) };
        if ready < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error.into());
        }
        if ready == 0 {
            continue;
        }
        let mut byte = 0u8;
        let count = unsafe { libc::read(0, (&mut byte as *mut u8).cast(), 1) };
        if count == 0 {
            break;
        }
        if count < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error.into());
        }
        if byte == b'\n' {
            break;
        }
        bytes.push(byte);
        ensure!(bytes.len() <= 4096, "Credential exceeds 4096 UTF-8 bytes");
    }
    let mut line = std::str::from_utf8(&bytes)?.to_owned();
    drop(echo);
    if secret {
        eprintln!();
    }
    if line.ends_with('\r') {
        line.pop();
    }
    Ok(line)
}
fn dht(backend: &mut LibtorrentBackend, request: DhtRequest) -> Result<DhtOutcome> {
    let id = backend.start_dht(
        request,
        DhtOptions {
            timeout: Duration::from_secs(30),
        },
    )?;
    loop {
        for event in backend.poll_dht() {
            if event.id == id {
                return Ok(event.result?);
            }
        }
        ensure!(!STOP.load(Ordering::Relaxed), "Interrupted; use resume");
        thread::sleep(Duration::from_millis(50));
    }
}
fn read_current(
    backend: &mut LibtorrentBackend,
    key: &MutableKey,
) -> Result<Option<MutableRecord>> {
    match dht(backend, DhtRequest::GetMutable(key.clone()))? {
        DhtOutcome::Mutable(record) => Ok(record),
        _ => bail!("Unexpected DHT response"),
    }
}
fn latest(
    previous: Option<MutableRecord>,
    current: Option<MutableRecord>,
) -> Result<Option<MutableRecord>> {
    Ok(match (previous, current) {
        (Some(previous), Some(current)) if current.sequence() < previous.sequence() => {
            Some(previous)
        }
        (previous, Some(current)) => Some(select_mutable(previous.as_ref(), current)?),
        (previous, None) => previous,
    })
}
fn load(root: &Path) -> Result<Option<Journal>> {
    let path = root.join("publication.json");
    if !path.exists() {
        return Ok(None);
    }
    let file = File::open(path)?;
    ensure!(file.metadata()?.len() < 65536, "Journal exceeds limit");
    let j: Journal = serde_json::from_reader(file)?;
    ensure!(
        j.version == 1 && (2..=4).contains(&j.torrents.len()),
        "Invalid journal"
    );
    j.record.verify()?;
    Ok(Some(j))
}
fn run(args: Args) -> Result<()> {
    let config: Config = serde_json::from_reader(File::open(&args.config)?)?;
    ensure!(
        !config.trackers.is_empty() && config.trackers.len() <= 16 && config.gateways.len() <= 16,
        "Configure WSS signaling in --config"
    );
    for url in &config.trackers {
        ensure!(
            url.starts_with("wss://") && !url.contains(['\n', '\r', '@']),
            "Use WSS signaling"
        );
    }
    if args.isolated {
        ensure!(
            config
                .trackers
                .iter()
                .all(|s| s.starts_with("wss://127.0.0.1:")
                    || s.starts_with("wss://localhost:")
                    || s.starts_with("wss://[::1]:")),
            "Isolated signaling must use loopback"
        );
        ensure!(
            args.dht_bootstrap
                .split(',')
                .all(|s| s.starts_with("127.0.0.1:") || s.starts_with("[::1]:")),
            "Set loopback DHT bootstrap for isolated tests"
        );
    }
    let root = args.root.unwrap_or_else(|| {
        PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
            .join(".local/share/my98/feedtorrent-publisher")
    });
    fs::create_dir_all(&root)?;
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(root.join("publisher.lock"))?;
    ensure!(
        unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0,
        "Another publisher is using this root"
    );
    unsafe {
        libc::signal(libc::SIGINT, stop as *const () as libc::sighandler_t);
        libc::signal(libc::SIGTERM, stop as *const () as libc::sighandler_t);
    }
    let state = root.join("native");
    fs::create_dir_all(&state)?;
    let mut backend = LibtorrentBackend::new(
        state.to_str().context("Non UTF-8 path")?,
        args.port,
        &args.dht_bootstrap,
        args.isolated,
    )?;
    backend.configure_webtorrent(
        &config.trackers,
        if args.isolated {
            ""
        } else {
            "stun.l.google.com:19302"
        },
    )?;
    let work = (|| -> Result<()> {
        let journal = match args.command {
            Command::Resume => load(&root)?.context("No publication to resume")?,
            Command::Publish {
                disk,
                state,
                profile,
            } => {
                let username = input_line("Username: ", false)?;
                let password = Zeroizing::new(input_line("Password: ", true)?);
                let identity = slop86_crypto::derive_identity(
                    &username,
                    password.as_bytes().to_vec(),
                    &args.machine,
                )
                .map_err(anyhow::Error::msg)?;
                let key = MutableKey::new(
                    identity
                        .public_key()
                        .map_err(anyhow::Error::msg)?
                        .try_into()
                        .map_err(|_| anyhow::anyhow!("Invalid identity"))?,
                    SALT.to_vec(),
                )?;
                let previous = load(&root)?;
                let previous_record = previous.as_ref().map(|j| j.record.verify()).transpose()?;
                if let Some(r) = &previous_record {
                    ensure!(r.key() == &key, "Use a separate root for each identity");
                }
                let current = read_current(&mut backend, &key)?;
                let best = latest(previous_record, current)?;
                let now = i64::try_from(SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis())?;
                let seq = now.max(
                    best.as_ref()
                        .map(|r| r.sequence().checked_add(1).context("Sequence exhausted"))
                        .transpose()?
                        .unwrap_or(0),
                );
                let revision = root.join(format!("revision-{seq}"));
                fs::create_dir(&revision)?;
                let disk_copy = revision.join("disk.my98");
                snapshot(&disk, &disk_copy)?;
                let header = formats::disk(&disk_copy, &key.public_key())?;
                let mut inputs = vec![("disk", disk_copy)];
                let mut state_hash = None;
                if let Some(state) = state {
                    let copy = revision.join("state.my98state");
                    snapshot(&state, &copy)?;
                    state_hash = Some(formats::state(&copy, &header)?);
                    inputs.push(("state", copy));
                }
                let disk_meta = component(&inputs[0].1, "disk.my98", &config.trackers)?;
                let disk_id = metadata_id(&disk_meta)?;
                if let Some(profile) = profile {
                    let copy = revision.join("profile.json");
                    snapshot(&profile, &copy)?;
                    formats::profile(&copy, &disk_id, &header, state_hash.as_deref())?;
                    inputs.push(("profile", copy));
                }
                let mut builder = FeedBuilder::new("my98");
                builder.fields.source = Some(key.clone());
                builder.outer.insert(
                    Cow::Borrowed(b"announce-list"),
                    OuterValue::List(
                        config
                            .trackers
                            .iter()
                            .map(|t| {
                                OuterValue::List(vec![OuterValue::Bytes(Cow::Owned(
                                    t.as_bytes().to_vec(),
                                ))])
                            })
                            .collect(),
                    ),
                );
                let mut entries = vec![];
                let mut data = vec![];
                for (kind, path) in &inputs {
                    let filename = path
                        .file_name()
                        .context("Missing filename")?
                        .to_str()
                        .context("Invalid filename")?;
                    let meta = if *kind == "disk" {
                        disk_meta.clone()
                    } else {
                        component(path, filename, &config.trackers)?
                    };
                    let id = metadata_id(&meta)?;
                    let directory = root.join("objects").join(&id);
                    fs::create_dir_all(&directory)?;
                    let payload = directory.join(filename);
                    if !payload.exists() {
                        fs::hard_link(path, &payload)?;
                    } else {
                        ensure!(
                            file_hash(&payload)? == file_hash(path)?,
                            "Existing object changed"
                        );
                    }
                    let torrent = directory.join("metainfo.torrent");
                    if !torrent.exists() {
                        atomic(&torrent, &meta)?;
                    }
                    builder.entries.push(BuildEntry::file(
                        vec![format!("{kind}.torrent")],
                        meta.len() as u64,
                    ));
                    data.push(meta);
                    entries.push(Seed { id });
                }
                let built = builder.build(|i| Ok(io::Cursor::new(&data[i])))?;
                let id = hex(&built.feed.infohash());
                let directory = root.join("objects").join(&id);
                let payload = directory.join("my98");
                fs::create_dir_all(&payload)?;
                for (entry, bytes) in built.feed.items().zip(&data) {
                    atomic(&payload.join(&entry.path()[0]), bytes)?;
                }
                for entry in built
                    .feed
                    .entries()
                    .iter()
                    .filter(|e| e.kind() == feedtorrent_bep::bep49::EntryKind::Padding)
                {
                    let padding = payload.join(entry.path().join("/"));
                    fs::create_dir_all(padding.parent().context("Missing padding parent")?)?;
                    File::create(padding)?.set_len(entry.length())?;
                }
                atomic(&directory.join("metainfo.torrent"), &built.metainfo)?;
                entries.push(Seed { id });
                let value = bep46::encode_payload(built.feed.infohash());
                let message = signing_bytes(&value, seq, SALT)?;
                let signature = identity.sign(&message).map_err(anyhow::Error::msg)?;
                let record = MutableRecord::verify(
                    key,
                    seq,
                    value,
                    signature
                        .try_into()
                        .map_err(|_| anyhow::anyhow!("Invalid signature"))?,
                )?;
                let journal = Journal {
                    version: 1,
                    record: Record::from(&record),
                    torrents: entries,
                };
                atomic(
                    &root.join("publication.json"),
                    &serde_json::to_vec_pretty(&journal)?,
                )?;
                fs::remove_dir_all(&revision).context(
                    "Snapshot saved; could not remove preparation directory. Use resume",
                )?;
                journal
            }
        };
        let record = journal.record.verify()?;
        ensure!(record.key().salt() == SALT, "Invalid publication domain");
        let pointer = TorrentPointer::from_record(record.key(), record.clone())?;
        ensure!(
            journal
                .torrents
                .iter()
                .any(|t| t.id == hex(&pointer.infohash())),
            "Journal has no root catalog"
        );
        for transfer in &journal.torrents {
            ensure!(transfer.id.len() == 40, "Invalid object id");
            unhex(&transfer.id)?;
            let directory = root.join("objects").join(&transfer.id);
            let meta = fs::read(directory.join("metainfo.torrent"))?;
            ensure!(
                metadata_id(&meta)? == transfer.id,
                "Object metadata changed"
            );
            backend.add(AddTransfer {
                id: &transfer.id,
                source: TorrentSource::Torrent(&meta),
                save_path: directory.to_str().context("Invalid path")?,
                active: true,
                restore: true,
            })?;
        }
        let ready = Instant::now();
        loop {
            let snap = backend.snapshot()?;
            ensure!(
                snap.transfers.iter().all(|t| t.error.is_empty()),
                "Cannot seed damaged payload"
            );
            if snap.transfers.len() == journal.torrents.len()
                && snap
                    .transfers
                    .iter()
                    .all(|t| t.total > 0 && t.verified == t.total)
            {
                break;
            }
            ensure!(
                ready.elapsed() < Duration::from_secs(300),
                "Local verification timed out; use resume"
            );
            ensure!(!STOP.load(Ordering::Relaxed), "Interrupted; use resume");
            thread::sleep(Duration::from_millis(100));
        }
        if let Some(current) = read_current(&mut backend, record.key())? {
            select_mutable(Some(&current), record.clone())?;
            ensure!(
                current.sequence() <= record.sequence(),
                "A newer publication exists; do not republish this snapshot"
            );
        }
        println!("Catalog: magnet:?xt=urn:btih:{}", hex(&pointer.infohash()));
        println!(
            "Follow in FeedTorrent (Mirror all): {}",
            bep46::format_magnet(record.key())
        );
        io::stdout().flush()?;
        let mut next = Instant::now();
        while !STOP.load(Ordering::Relaxed) {
            if Instant::now() >= next {
                match dht(&mut backend, DhtRequest::PutMutable(record.clone())) {
                    Ok(DhtOutcome::Stored {
                        acknowledged_nodes, ..
                    }) => {
                        println!("Published sequence {} ({acknowledged_nodes} DHT acknowledgements). Seeding until interrupted.",record.sequence());
                        io::stdout().flush()?;
                        next = Instant::now() + Duration::from_secs(20 * 60);
                    }
                    Ok(_) => bail!("Unexpected DHT publication result"),
                    Err(error) => {
                        if STOP.load(Ordering::Relaxed) {
                            break;
                        }
                        eprintln!("Publication unconfirmed: {error:#}; retaining signed snapshot for retry");
                        next = Instant::now() + Duration::from_secs(15);
                    }
                }
            }
            for event in backend.poll_dht() {
                if let Err(error) = event.result {
                    eprintln!("DHT: {error}");
                }
            }
            thread::sleep(Duration::from_millis(100));
        }
        Ok(())
    })();
    let saved = backend.checkpoint();
    let stopped = backend.shutdown();
    work?;
    saved?;
    stopped?;
    Ok(())
}
fn main() {
    if let Err(error) = run(Args::parse()) {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn pointer(seq: i64, hash: u8) -> MutableRecord {
        Bep44Signer::from_seed(&[31; 32])
            .sign(bep46::encode_payload([hash; 20]), seq, SALT.to_vec())
            .unwrap()
    }
    #[test]
    fn stale_dht_after_a_prepared_snapshot_keeps_the_local_high_water() {
        let high = pointer(10, 2);
        assert_eq!(
            latest(Some(high.clone()), Some(pointer(9, 1))).unwrap(),
            Some(high)
        );
    }
    #[test]
    fn newer_record_advances_and_equal_sequence_conflicts_are_fatal() {
        let high = pointer(10, 2);
        assert_eq!(
            latest(Some(pointer(9, 1)), Some(high.clone())).unwrap(),
            Some(high.clone())
        );
        assert!(latest(Some(high.clone()), Some(pointer(10, 3))).is_err());
        assert_eq!(
            latest(Some(high.clone()), Some(high.clone())).unwrap(),
            Some(high)
        );
    }
    #[test]
    fn resume_cannot_overwrite_a_newer_pointer_or_equal_sequence_fork() {
        assert!(select_mutable(Some(&pointer(11, 1)), pointer(10, 2)).is_err());
        assert!(select_mutable(Some(&pointer(11, 1)), pointer(11, 2)).is_err());
    }
    #[test]
    fn gateway_compatible_journal_preserves_i64_sequence_and_exact_signature() {
        let r = pointer(i64::MAX, 42);
        let wire = serde_json::to_vec(&Record::from(&r)).unwrap();
        let decoded: Record = serde_json::from_slice(&wire).unwrap();
        assert_eq!(decoded.sequence, i64::MAX.to_string());
        assert_eq!(decoded.verify().unwrap(), r);
        let mut changed = decoded;
        changed.value = "00".into();
        assert!(changed.verify().is_err());
    }
}
