use sha2::{Digest, Sha256};
use slop86_disk::*;
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
mod support;
#[derive(Default)]
struct Memory {
    files: RefCell<HashMap<String, Vec<u8>>>,
    reads: RefCell<Vec<(String, u64, usize)>>,
    stop: Cell<bool>,
    fail: Cell<Option<u64>>,
}
impl Memory {
    fn put(&self, id: &str, b: Vec<u8>) {
        self.files.borrow_mut().insert(id.into(), b);
    }
    fn bytes(&self, id: &str) -> Vec<u8> {
        self.files.borrow()[id].clone()
    }
    fn reset(&self) {
        self.reads.borrow_mut().clear();
    }
    fn count(&self) -> usize {
        self.reads.borrow().iter().map(|r| r.2).sum()
    }
}
impl Io for Memory {
    fn cancelled(&self) -> bool {
        self.stop.get()
    }
    fn read(&self, id: &str, o: u64, n: usize) -> Result<Vec<u8>> {
        self.reads.borrow_mut().push((id.into(), o, n));
        if self.fail.get().is_some_and(|v| o >= v) {
            return Err(error("IO_ERROR", "Injected failure"));
        }
        self.files
            .borrow()
            .get(id)
            .and_then(|b| b.get(o as usize..o as usize + n))
            .map(|b| b.to_vec())
            .ok_or_else(|| error("IO_ERROR", "Unavailable range"))
    }
}
fn engine() -> Engine {
    Engine::new("disk tests", b"public test password".to_vec(), "main").unwrap()
}
fn assemble(e: &mut Engine, io: &Memory) -> Vec<u8> {
    let mut b = e.header().unwrap();
    while let Some(v) = e.next(io).unwrap() {
        b.extend(v);
    }
    b
}
fn create(e: &mut Engine, io: &Memory, bytes: Vec<u8>) {
    let size = bytes.len();
    io.put("raw", bytes);
    e.begin_create("raw".into(), size as u64).unwrap();
    let enc = assemble(e, io);
    let n = enc.len();
    io.put("base", enc);
    e.accept(io, "base".into(), n as u64).unwrap();
}
fn save(e: &mut Engine, io: &Memory, id: &str) -> Vec<u8> {
    assert!(e.begin_save(io).unwrap());
    let b = assemble(e, io);
    io.put(id, b.clone());
    e.accept(io, id.into(), b.len() as u64).unwrap();
    b
}
#[test]
fn exact_lazy_ranges_and_header_only_authentication() {
    let io = Memory::default();
    let mut e = engine();
    let plain = support::bytes(CHUNK * 5 + 37);
    create(&mut e, &io, plain.clone());
    let base = io.bytes("base");
    assert_eq!(&base[..8], b"SLOPDSK\0");
    assert_eq!(&base[8..12], &1u32.to_le_bytes());
    assert_eq!(&base[12..16], &65536u32.to_le_bytes());
    assert_eq!(&base[16..24], &(plain.len() as u64).to_le_bytes());
    let mut signed = b"slop86/linear-disk/v1\0".to_vec();
    signed.extend_from_slice(&base[..134]);
    assert!(slop86_crypto::verify(
        &e.identity.public_key().unwrap(),
        &signed,
        &base[134..198]
    ));

    assert_eq!(base.len(), HEADER + plain.len() + 6 * OVERHEAD);
    let mut reader = engine();
    io.reset();
    reader.open(&io, "base".into(), base.len() as u64).unwrap();
    assert_eq!(io.count(), HEADER);
    assert_eq!(reader.read(&io, 0, 512).unwrap(), plain[..512]);
    assert_eq!(io.count(), HEADER + CHUNK + OVERHEAD);
    io.reset();
    assert_eq!(
        reader.read(&io, (CHUNK * 4 + 30) as u64, 18).unwrap(),
        plain[CHUNK * 4 + 30..CHUNK * 4 + 48]
    );
    assert_eq!(io.count(), CHUNK + OVERHEAD);
    assert_eq!(
        reader.read(&io, (CHUNK - 3) as u64, 10).unwrap(),
        plain[CHUNK - 3..CHUNK + 7]
    );
    assert_eq!(
        reader.verify_image(&io).unwrap(),
        Sha256::digest(&plain).to_vec()
    );
    for (user, pw, machine) in [
        ("disk tests", "wrong", "main"),
        ("disk tests", "public test password", "Main"),
        ("other", "public test password", "main"),
    ] {
        io.reset();
        let mut wrong = Engine::new(user, pw.as_bytes().to_vec(), machine).unwrap();
        assert_eq!(
            wrong
                .open(&io, "base".into(), base.len() as u64)
                .unwrap_err()
                .code,
            "AUTHENTICATION_FAILED"
        );
        assert_eq!(io.count(), HEADER);
        assert!(wrong.describe().is_err());
    }
}
#[test]
fn atomic_writes_noop_save_and_rekey() {
    let io = Memory::default();
    let mut e = engine();
    let mut plain = support::bytes(CHUNK * 2 + 7);
    create(&mut e, &io, plain.clone());
    e.write(&io, 511, &[9, 8, 7]).unwrap();
    e.write(&io, 511, &plain[511..514]).unwrap();
    assert!(!e.begin_save(&io).unwrap());
    e.accept_unchanged(&io).unwrap();
    assert_eq!(e.describe().unwrap().dirty_bytes, 0);
    let old = io.bytes("base");
    let old_id = e.describe().unwrap().disk_id;
    e.write(&io, (CHUNK - 1) as u64, &[42, 43, 44]).unwrap();
    plain[CHUNK - 1..CHUNK + 2].copy_from_slice(&[42, 43, 44]);
    e.write(&io, (plain.len() - 1) as u64, &[99]).unwrap();
    *plain.last_mut().unwrap() = 99;
    assert_eq!(
        e.verify_image(&io).unwrap(),
        Sha256::digest(&plain).to_vec()
    );
    let new = save(&mut e, &io, "saved");
    assert_ne!(old_id, e.describe().unwrap().disk_id);
    assert_ne!(
        &old[HEADER..HEADER + CHUNK + OVERHEAD],
        &new[HEADER..HEADER + CHUNK + OVERHEAD]
    );
    assert_eq!(e.describe().unwrap().dirty_bytes, 0);
    assert_eq!(
        e.verify_image(&io).unwrap(),
        Sha256::digest(&plain).to_vec()
    );
    assert!(!e.begin_save(&io).unwrap());
    e.accept_unchanged(&io).unwrap();
}
#[test]
fn failures_and_cancellation_never_publish_or_clear_pending() {
    let io = Memory::default();
    let mut e = engine();
    create(&mut e, &io, support::bytes(CHUNK * 3));
    e.write(&io, 10, &[31]).unwrap();
    let before = e.describe().unwrap().disk_id;
    assert!(e.begin_save(&io).unwrap());
    e.next(&io).unwrap();
    io.stop.set(true);
    assert_eq!(e.next(&io).unwrap_err().code, "CANCELLED");
    assert_eq!(
        e.accept(&io, "bad".into(), 0).unwrap_err().code,
        "CANCELLED"
    );
    e.cancel();
    io.stop.set(false);
    assert_eq!(e.describe().unwrap().dirty_bytes, 512);
    assert_eq!(e.describe().unwrap().disk_id, before);
    e.clear_cache();
    assert!(e.begin_save(&io).unwrap());
    io.fail.set(Some((HEADER + CHUNK + OVERHEAD) as u64));
    e.next(&io).unwrap();
    assert_eq!(e.next(&io).unwrap_err().code, "IO_ERROR");
    e.cancel();
    io.fail.set(None);
    assert!(e.begin_save(&io).unwrap());
    let enc = assemble(&mut e, &io);
    assert!(e.accept(&io, "bad".into(), enc.len() as u64 - 1).is_err());
    e.cancel();
    assert_eq!(e.describe().unwrap().dirty_bytes, 512);
    assert!(e.begin_save(&io).unwrap());
    e.write(&io, 20, &[7]).unwrap();
    assert!(e.next(&io).is_err());
    e.cancel();
    assert_eq!(e.read(&io, 20, 1).unwrap(), [7]);
    save(&mut e, &io, "retry");
}
#[test]
fn partial_write_failure_is_atomic_and_full_sectors_need_no_old_reads() {
    let io = Memory::default();
    let mut e = engine();
    let plain = support::bytes(CHUNK * 3 + 1);
    create(&mut e, &io, plain.clone());
    e.clear_cache();
    io.fail.set(Some(0));
    e.write(&io, 512, &vec![7; 512]).unwrap();
    assert_eq!(e.read(&io, 512, 512).unwrap(), vec![7; 512]);
    assert!(e
        .write(&io, (CHUNK - 1) as u64, &vec![4; CHUNK + 2])
        .is_err());
    assert_eq!(e.describe().unwrap().dirty_sectors, 1);
    io.fail.set(None);
    assert_eq!(
        e.read(&io, (CHUNK - 1) as u64, 3).unwrap(),
        plain[CHUNK - 1..CHUNK + 2]
    );
}
#[test]
fn corruption_substitution_and_legacy_rejected() {
    let io = Memory::default();
    let mut e = engine();
    create(&mut e, &io, support::bytes(CHUNK * 2 + 17));
    let base = io.bytes("base");
    for offset in [16, 134, 197] {
        let mut b = base.clone();
        b[offset] ^= 1;
        io.put("bad", b);
        let mut r = engine();
        assert_eq!(
            r.open(&io, "bad".into(), base.len() as u64)
                .unwrap_err()
                .code,
            "CORRUPTION"
        );
    }
    for total in [base.len() - 1, base.len() + 1] {
        let mut b = base.clone();
        b.resize(total, 0);
        io.put("bad", b);
        assert!(engine().open(&io, "bad".into(), total as u64).is_err());
    }
    for pos in [HEADER, HEADER + 46, HEADER + CHUNK + OVERHEAD - 1] {
        let mut b = base.clone();
        b[pos] ^= 1;
        io.put("bad", b);
        let mut r = engine();
        r.open(&io, "bad".into(), base.len() as u64).unwrap();
        assert_eq!(r.read(&io, 0, 1).unwrap_err().code, "CORRUPTION");
    }
    let mut b = base.clone();
    let record = b[HEADER..HEADER + CHUNK + OVERHEAD].to_vec();
    b[HEADER + CHUNK + OVERHEAD..HEADER + 2 * (CHUNK + OVERHEAD)].copy_from_slice(&record);
    io.put("swap", b);
    let mut r = engine();
    r.open(&io, "swap".into(), base.len() as u64).unwrap();
    assert!(r.read(&io, CHUNK as u64, 1).is_err());
    e.write(&io, 0, &[7]).unwrap();
    let mut new = save(&mut e, &io, "new");
    new[HEADER..HEADER + CHUNK + OVERHEAD].copy_from_slice(&record);
    io.put("mixed", new);
    let mut r = engine();
    r.open(&io, "mixed".into(), base.len() as u64).unwrap();
    assert!(r.read(&io, 0, 1).is_err());
    io.put("car", vec![0; 300]);
    assert_eq!(
        engine().open(&io, "car".into(), 300).unwrap_err().code,
        "UNSUPPORTED_FORMAT"
    );
}
#[test]
fn cache_bound_and_noop_comparisons_grouped() {
    let io = Memory::default();
    let mut e = engine();
    create(&mut e, &io, support::bytes(34 * 1024 * 1024));
    for i in 0..544 {
        e.read(&io, (i * CHUNK) as u64, 1).unwrap();
        assert!(e.describe().unwrap().cache_bytes <= CACHE_LIMIT);
    }
    io.reset();
    e.read(&io, 0, 1).unwrap();
    assert_eq!(io.count(), CHUNK + OVERHEAD);
    e.write(&io, 0, &vec![0; 512]).unwrap();
    e.write(&io, 512, &vec![0; 512]).unwrap();
    e.clear_cache();
    io.reset();
    assert!(e.begin_save(&io).unwrap());
    assert_eq!(io.count(), CHUNK + OVERHEAD);
    e.cancel();
}
#[test]
fn fat32_free_space_slack_and_partial_tail_exact() {
    let io = Memory::default();
    let mut e = engine();
    let (image, _, _) = support::fat_image();
    let hash = Sha256::digest(&image).to_vec();
    create(&mut e, &io, image);
    assert_eq!(e.verify_image(&io).unwrap(), hash);
}
#[test]
fn length_bounds_and_cancelled_noop() {
    assert!(file_size(0).is_err());
    assert!(file_size(MAX_SIZE + 1).is_err());
    assert!(file_size(MAX_SIZE).is_ok());
    let io = Memory::default();
    let mut e = engine();
    create(&mut e, &io, vec![42]);
    e.write(&io, 0, &[42]).unwrap();
    assert!(!e.begin_save(&io).unwrap());
    io.stop.set(true);
    assert!(e.accept_unchanged(&io).is_err());
    assert_eq!(e.describe().unwrap().dirty_bytes, 1);
    io.stop.set(false);
    e.cancel();
    assert!(!e.begin_save(&io).unwrap());
    e.accept_unchanged(&io).unwrap();
    assert_eq!(e.read(&io, 0, 1).unwrap(), [42]);
}
