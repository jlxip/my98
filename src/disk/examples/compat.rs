use sha2::{Digest, Sha256};
use slop86_disk::*;
use std::{
    cell::Cell,
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
    time::Instant,
};
#[path = "../tests/support.rs"]
mod support;
#[derive(Default)]
struct Files {
    bytes: Cell<u64>,
    calls: Cell<u64>,
}
#[async_trait::async_trait(?Send)]
impl Io for Files {
    async fn read(&self, source: &str, offset: u64, len: usize) -> Result<Vec<u8>> {
        self.bytes.set(self.bytes.get() + len as u64);
        self.calls.set(self.calls.get() + 1);
        let mut f = File::open(source).map_err(|e| error("IO_ERROR", e.to_string()))?;
        f.seek(SeekFrom::Start(offset)).unwrap();
        let mut b = vec![0; len];
        f.read_exact(&mut b)
            .map_err(|e| error("IO_ERROR", e.to_string()))?;
        Ok(b)
    }
}
fn engine() -> Engine {
    Engine::new(
        "disk fixtures",
        b"public compatibility password".to_vec(),
        "main",
    )
    .unwrap()
}
fn file_hash(path: &str) -> String {
    let mut f = File::open(path).unwrap();
    let mut b = [0; 65536];
    let mut h = Sha256::new();
    loop {
        let n = f.read(&mut b).unwrap();
        if n == 0 {
            break;
        }
        h.update(&b[..n]);
    }
    hex::encode(h.finalize())
}
fn pack(source: &str, output: &str) -> serde_json::Value {
    let io = Files::default();
    let mut e = engine();
    let size = fs::metadata(source).unwrap().len();
    let hash = file_hash(source);
    let start = Instant::now();
    e.begin_create(source.into(), size).unwrap();
    let mut f = File::create(output).unwrap();
    f.write_all(&e.header().unwrap()).unwrap();
    while let Some(b) = futures::executor::block_on(e.next(&io)).unwrap() {
        f.write_all(&b).unwrap();
    }
    f.flush().unwrap();
    drop(f);
    let ms = start.elapsed().as_secs_f64() * 1000.;
    let total = fs::metadata(output).unwrap().len();
    e.accept(&io, output.into(), total).unwrap();
    assert_eq!(
        hex::encode(futures::executor::block_on(e.verify_image(&io)).unwrap()),
        hash
    );
    let mut cold = engine();
    io.bytes.set(0);
    io.calls.set(0);
    let start = Instant::now();
    futures::executor::block_on(cold.open(&io, output.into(), total)).unwrap();
    futures::executor::block_on(cold.read(&io, 0, size.min(512) as usize)).unwrap();
    serde_json::json!({"source":source,"file":output,"size":size,"encryptedSize":total,"sha256":hash,"packMs":ms,"coldMs":start.elapsed().as_secs_f64()*1000.,"coldBytes":io.bytes.get(),"coldCalls":io.calls.get()})
}
fn main() {
    let args: Vec<String> = std::env::args().collect();
    fs::create_dir_all("build/disk").unwrap();
    match args.get(1).map(String::as_str) {
        Some("identity") => {
            let e = engine();
            println!(
                "{}",
                serde_json::json!({"ipnsName":e.identity().unwrap().ipns_name().unwrap(),"publicKey":e.identity().unwrap().public_key().unwrap()})
            );
        }
        Some("sign") => {
            // Public fixture identity only; no caller-supplied credentials or secret export.
            println!(
                "{}",
                hex::encode(
                    engine()
                        .identity()
                        .unwrap()
                        .sign(&hex::decode(&args[2]).unwrap())
                        .unwrap()
                )
            );
        }
        Some("pack") => println!("{}", pack(&args[2], &args[3])),
        Some("verify") => {
            let io = Files::default();
            let mut e = engine();
            futures::executor::block_on(e.open(
                &io,
                args[2].clone(),
                fs::metadata(&args[2]).unwrap().len(),
            ))
            .unwrap();
            assert_eq!(
                hex::encode(futures::executor::block_on(e.verify_image(&io)).unwrap()),
                file_hash(&args[3])
            );
            println!("Exact native reconstruction: {}", args[2]);
        }
        _ => {
            let raw = "build/disk/raw.img";
            let fat = "build/disk/fat.img";
            fs::write(raw, support::bytes(3 * 1024 * 1024 + 31)).unwrap();
            fs::write(fat, support::fat_image().0).unwrap();
            let results = vec![
                pack(raw, "build/disk/native-raw.my98"),
                pack(fat, "build/disk/native-fat.my98"),
            ];
            let path = Path::new("build/disk/native.json");
            fs::write(path, serde_json::to_vec_pretty(&results).unwrap()).unwrap();
            println!("{}", serde_json::to_string_pretty(&results).unwrap());
        }
    }
}
