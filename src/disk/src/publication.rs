use super::*;
use bendy::value::Value as BValue;
use feedtorrent_bep::{
    bep44::{signing_bytes, BencodedValue, MutableKey},
    bep46,
    bep49::{BuildEntry, FeedBuilder},
};
use sha1::{Digest, Sha1};
use std::{borrow::Cow, collections::BTreeMap, io::Cursor};

pub(crate) const PUBLICATION_SALT: &[u8] = b"my98/publication/v1";
fn hex(b: &[u8]) -> String {
    b.iter().map(|b| format!("{b:02x}")).collect()
}
fn key(bytes: &[u8]) -> Result<MutableKey> {
    MutableKey::new(
        bytes
            .try_into()
            .map_err(|_| operation("Invalid publication key".into()))?,
        PUBLICATION_SALT.to_vec(),
    )
    .map_err(|e| operation(e.to_string()))
}
pub(crate) fn trackers(value: &str) -> Result<BValue<'static>> {
    let values: Vec<String> = serde_json::from_str(value).map_err(|e| operation(e.to_string()))?;
    if values.is_empty() || values.len() > 16 {
        return Err(operation("Configure WebRTC trackers".into()));
    }
    Ok(BValue::List(
        values
            .iter()
            .map(|s| BValue::List(vec![BValue::Bytes(Cow::Owned(s.as_bytes().to_vec()))]))
            .collect(),
    ))
}
pub(crate) fn piece_hash(bytes: &[u8]) -> Result<Vec<u8>> {
    if bytes.is_empty() || bytes.len() > 262144 {
        return Err(operation("Invalid publication piece".into()));
    }
    Ok(Sha1::digest(bytes).to_vec())
}
pub(crate) fn publication_metadata(
    size: u64,
    hashes: &[u8],
    public: &[u8],
    tracker_json: &str,
) -> Result<String> {
    if size == 0
        || size > 2u64.pow(40) + 2u64.pow(30) + 198
        || hashes.len() != size.div_ceil(262144) as usize * 20
        || hashes.len() > 8 * 1024 * 1024 - 4096
    {
        return Err(operation(
            "Publication exceeds supported metadata size".into(),
        ));
    }
    let blob = |b: Vec<u8>| BValue::Bytes(Cow::Owned(b));
    let mut info = BTreeMap::new();
    info.insert(
        Cow::Borrowed(b"name".as_slice()),
        blob(b"disk.my98".to_vec()),
    );
    info.insert(
        Cow::Borrowed(b"length".as_slice()),
        BValue::Integer(size as i64),
    );
    info.insert(
        Cow::Borrowed(b"piece length".as_slice()),
        BValue::Integer(262144),
    );
    info.insert(Cow::Borrowed(b"pieces".as_slice()), blob(hashes.to_vec()));
    let mut outer = BTreeMap::new();
    outer.insert(Cow::Borrowed(b"info".as_slice()), BValue::Dict(info));
    outer.insert(
        Cow::Borrowed(b"announce-list".as_slice()),
        trackers(tracker_json)?,
    );
    let mut encoder = bendy::encoding::Encoder::new().with_max_depth(64);
    encoder
        .emit(BValue::Dict(outer))
        .map_err(|e| operation(e.to_string()))?;
    let disk = encoder.get_output().map_err(|e| operation(e.to_string()))?;
    let mut builder = FeedBuilder::new("my98");
    builder.fields.source = Some(key(public)?);
    builder
        .outer
        .insert(Cow::Borrowed(b"announce-list"), trackers(tracker_json)?);
    builder.entries.push(BuildEntry::file(
        vec!["disk.torrent".into()],
        disk.len() as u64,
    ));
    let built = builder
        .build(|_| Ok(Cursor::new(&disk)))
        .map_err(|e| operation(e.to_string()))?;
    let mut payload = disk.clone();
    let padding: u64 = built
        .feed
        .entries()
        .iter()
        .filter(|e| e.kind() == feedtorrent_bep::bep49::EntryKind::Padding)
        .map(|e| e.length())
        .sum();
    payload.resize(payload.len() + padding as usize, 0);
    serde_json::to_string(&serde_json::json!({"diskMetadata":disk,"catalogMetadata":built.metainfo,"catalogPayload":payload,"infoHash":hex(&built.feed.infohash())})).map_err(|e|operation(e.to_string()))
}
impl Engine {
    pub(crate) fn snapshot(&self, original: bool) -> Result<Self> {
        let image = self
            .image
            .as_ref()
            .ok_or_else(|| operation("No disk open".into()))?;
        Ok(Self {
            identity: self.identity.clone(),
            image: Some(Image {
                source: image.source.clone(),
                size: image.size,
                disk: Disk::from_read_key(
                    image.disk.export_read_key().map_err(operation)?.to_vec(),
                )
                .map_err(operation)?,
                dirty: if original {
                    BTreeMap::new()
                } else {
                    image.dirty.clone()
                },
                cache: Cache::new(),
            }),
            build: None,
            revision: self.revision,
            hash: None,
            unchanged: None,
        })
    }
    pub(crate) fn fresh(&self) -> Result<Self> {
        self.identity()?;
        Ok(Self {
            identity: self.identity.clone(),
            image: None,
            build: None,
            revision: 0,
            hash: None,
            unchanged: None,
        })
    }
    pub(crate) fn sign_publication(&self, infohash: &[u8], sequence: &str) -> Result<String> {
        let hash: [u8; 20] = infohash
            .try_into()
            .map_err(|_| operation("Invalid publication hash".into()))?;
        let seq: i64 = sequence
            .parse()
            .map_err(|_| operation("Invalid publication sequence".into()))?;
        if seq < 0 || seq.to_string() != sequence {
            return Err(operation("Invalid publication sequence".into()));
        }
        let identity = self.identity()?;
        let public = identity.public_key().map_err(operation)?;
        let value: BencodedValue = bep46::encode_payload(hash);
        let signed =
            signing_bytes(&value, seq, PUBLICATION_SALT).map_err(|e| operation(e.to_string()))?;
        let signature = identity.sign(&signed).map_err(operation)?;
        serde_json::to_string(&serde_json::json!({"key":hex(&public),"salt":hex(PUBLICATION_SALT),"sequence":sequence,"signature":hex(&signature),"value":hex(value.as_bytes())})).map_err(|e|operation(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::executor::block_on;
    use std::cell::RefCell;
    #[derive(Default)]
    struct Memory(RefCell<HashMap<String, Vec<u8>>>);
    #[async_trait::async_trait(?Send)]
    impl Io for Memory {
        async fn read(&self, id: &str, offset: u64, length: usize) -> Result<Vec<u8>> {
            self.0
                .borrow()
                .get(id)
                .and_then(|b| b.get(offset as usize..offset as usize + length))
                .map(|b| b.to_vec())
                .ok_or_else(|| error("IO_ERROR", "Missing test range"))
        }
    }
    fn engine() -> Engine {
        Engine::new("publication test", b"public password".to_vec(), "main").unwrap()
    }
    fn unhex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }
    #[test]
    fn catalog_has_only_disk_and_authenticates_exact_metainfo() {
        let e = engine();
        let public = e.identity().unwrap().public_key().unwrap();
        let payload = vec![19; 262145];
        let hashes: Vec<u8> = payload
            .chunks(262144)
            .flat_map(|b| piece_hash(b).unwrap())
            .collect();
        let json = publication_metadata(
            payload.len() as u64,
            &hashes,
            &public,
            "[\"wss://tracker.test\"]",
        )
        .unwrap();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        let disk: Vec<u8> = serde_json::from_value(v["diskMetadata"].clone()).unwrap();
        let meta: Vec<u8> = serde_json::from_value(v["catalogMetadata"].clone()).unwrap();
        let data: Vec<u8> = serde_json::from_value(v["catalogPayload"].clone()).unwrap();
        let feed = feedtorrent_bep::bep49::Feed::from_metainfo(&meta).unwrap();
        assert_eq!(hex(&feed.infohash()), v["infoHash"]);
        assert_eq!(feed.fields().source, Some(key(&public).unwrap()));
        let entries: Vec<_> = feed.items().collect();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].path(), ["disk.torrent"]);
        assert_eq!(entries[0].sha1(), Some(Sha1::digest(&disk).into()));
        assert!(data.starts_with(&disk));
        assert!(data[disk.len()..].iter().all(|b| *b == 0));
        let pieces: Vec<u8> = data
            .chunks(feed.piece_length() as usize)
            .flat_map(|b| Sha1::digest(b).to_vec())
            .collect();
        assert_eq!(pieces, feed.pieces());
        assert!(
            publication_metadata(262145, &hashes[..20], &public, "[\"wss://tracker.test\"]")
                .is_err()
        );
    }
    #[test]
    fn signed_sequence_is_exact_and_fresh_identity_has_no_disk() {
        let e = engine();
        let fresh = e.fresh().unwrap();
        assert!(fresh.describe().is_err());
        let v: serde_json::Value = serde_json::from_str(
            &fresh
                .sign_publication(&[31; 20], "9223372036854775807")
                .unwrap(),
        )
        .unwrap();
        let record = feedtorrent_bep::bep44::MutableRecord::verify(
            key(&unhex(v["key"].as_str().unwrap())).unwrap(),
            i64::MAX,
            BencodedValue::parse(&unhex(v["value"].as_str().unwrap())).unwrap(),
            unhex(v["signature"].as_str().unwrap()).try_into().unwrap(),
        )
        .unwrap();
        assert_eq!(record.sequence(), i64::MAX);
        for seq in ["-1", "01", "9223372036854775808"] {
            assert!(e.sign_publication(&[31; 20], seq).is_err());
        }
    }
    #[test]
    fn snapshot_build_preserves_owner_overlay_and_read_only_original() {
        let io = Memory::default();
        io.0.borrow_mut().insert("raw".into(), vec![0; 65536 + 512]);
        let mut e = engine();
        e.begin_create("raw".into(), 65536 + 512).unwrap();
        let mut packed = e.header().unwrap();
        while let Some(b) = block_on(e.next(&io)).unwrap() {
            packed.extend(b);
        }
        let size = packed.len() as u64;
        io.0.borrow_mut().insert("base".into(), packed);
        e.accept(&io, "base".into(), size).unwrap();
        block_on(e.write(&io, 17, &[59])).unwrap();
        let before = e.describe().unwrap();
        let mut snap = e.snapshot(false).unwrap();
        assert!(block_on(snap.begin_save(&io)).unwrap());
        while block_on(snap.next(&io)).unwrap().is_some() {}
        assert_eq!(e.describe().unwrap().dirty_bytes, before.dirty_bytes);
        assert_eq!(block_on(e.read(&io, 17, 1)).unwrap(), [59]);
        let mut ro = block_on(Engine::open_read_only(
            &io,
            "base".into(),
            size,
            e.export_read_key().unwrap().to_vec(),
        ))
        .unwrap();
        block_on(ro.write(&io, 17, &[71])).unwrap();
        let mut original = ro.snapshot(true).unwrap();
        assert_eq!(block_on(original.read(&io, 17, 1)).unwrap(), [0]);
        assert_eq!(block_on(ro.read(&io, 17, 1)).unwrap(), [71]);
        assert_eq!(ro.fresh().err().unwrap().code, "READ_ONLY");
        assert!(ro.sign_publication(&[31; 20], "1").is_err());
    }
}
