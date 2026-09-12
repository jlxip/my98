use slop86_disk::*;
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    time::Instant,
};
#[derive(Default)]
struct Memory {
    files: RefCell<HashMap<String, Vec<u8>>>,
    read: Cell<u64>,
}
#[async_trait::async_trait(?Send)]
impl Io for Memory {
    async fn read(&self, id: &str, offset: u64, n: usize) -> Result<Vec<u8>> {
        self.read.set(self.read.get() + n as u64);
        if id == "raw" {
            return Ok((offset..offset + n as u64)
                .map(|i| i.wrapping_mul(179).wrapping_add(i >> 9) as u8)
                .collect());
        }
        self.files
            .borrow()
            .get(id)
            .and_then(|b| b.get(offset as usize..offset as usize + n))
            .map(|b| b.to_vec())
            .ok_or_else(|| error("IO_ERROR", "Missing range"))
    }
}
fn engine() -> Engine {
    Engine::new("metrics", b"public metric password".to_vec(), "main").unwrap()
}
fn finish(e: &mut Engine, io: &Memory, id: &str) -> u64 {
    let mut b = e.header().unwrap();
    while let Some(chunk) = futures::executor::block_on(e.next(io)).unwrap() {
        b.extend(chunk);
        if let Ok(state) = e.describe() {
            assert!(state.cache_bytes <= CACHE_LIMIT);
        }
    }
    let n = b.len() as u64;
    io.files.borrow_mut().insert(id.into(), b);
    e.accept(io, id.into(), n).unwrap();
    n
}
#[test]
fn scaling_full_save_and_constant_cold_reads() {
    let mut metrics = vec![];
    for mib in [1, 8, 64] {
        let io = Memory::default();
        let mut e = engine();
        let size = mib * 1048576;
        let start = Instant::now();
        e.begin_create("raw".into(), size).unwrap();
        let total = finish(&mut e, &io, "base");
        let create_ms = start.elapsed().as_secs_f64() * 1000.;
        let mut reader = engine();
        io.read.set(0);
        let start = Instant::now();
        futures::executor::block_on(reader.open(&io, "base".into(), total)).unwrap();
        futures::executor::block_on(reader.read(&io, 0, 512)).unwrap();
        let cold_ms = start.elapsed().as_secs_f64() * 1000.;
        assert_eq!(io.read.get(), 65796);
        futures::executor::block_on(reader.write(&io, 7, &[99])).unwrap();
        reader.clear_cache();
        io.read.set(0);
        let start = Instant::now();
        assert!(futures::executor::block_on(reader.begin_save(&io)).unwrap());
        finish(&mut reader, &io, "saved");
        let save_ms = start.elapsed().as_secs_f64() * 1000.;
        assert_eq!(io.read.get(), total - HEADER as u64);
        metrics.push(serde_json::json!({"imageMiB":mib,"fullBytes":total,"createMs":create_ms,"coldMs":cold_ms,"coldBytes":65796,"saveMs":save_ms,"saveReadBytes":io.read.get(),"cacheLimit":CACHE_LIMIT}));
    }
    println!("{}", serde_json::to_string_pretty(&metrics).unwrap());
}
