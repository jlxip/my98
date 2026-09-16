use serde_json::{json, Value};
use slop86_crypto::*;
fn hx(value: &Value) -> Vec<u8> {
    hex::decode(value.as_str().unwrap()).unwrap()
}
fn main() {
    let username = "cafe\u{301}";
    let password = "public compatibility test password ";
    let identity = derive_identity(username, password.as_bytes().to_vec(), "main").unwrap();
    if let Some(path) = std::env::args().nth(1) {
        let value: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        for item in value.as_array().unwrap() {
            assert_eq!(
                identity.ipns_name().unwrap(),
                item["ipns"].as_str().unwrap()
            );
            let disk = identity.open_disk(&hx(&item["descriptor"])).unwrap();
            assert_eq!(
                disk.open_unit(&[0; 12], &hx(&item["unit"])).unwrap(),
                hx(&item["plain"])
            );
            assert_eq!(
                disk.open_metadata(&hx(&item["metadata"])).unwrap(),
                b"browser metadata"
            );
            assert!(verify(
                &identity.public_key().unwrap(),
                b"browser signed",
                &hx(&item["signature"])
            ));
        }
        println!("Native verified browser descriptors, ciphertext, metadata and signatures");
        return;
    }
    let disk = identity.create_disk().unwrap();
    let plain: Vec<u8> = (0..16_417)
        .map(|i| if i % 1024 < 128 { 0 } else { (i * 37) as u8 })
        .collect();
    let unit = disk.seal_unit(&[0; 12], plain.clone()).unwrap();
    println!(
        "{}",
        json!({"username":username,"password":password,"ipns":identity.ipns_name().unwrap(),
        "publicKey":hex::encode(identity.public_key().unwrap()),"descriptor":hex::encode(identity.seal_descriptor(&disk).unwrap()),
        "plain":hex::encode(plain),"unit":hex::encode(&unit),"cid":object_cid(&unit),
        "metadata":hex::encode(disk.seal_metadata(b"native metadata".to_vec()).unwrap()),
        "signature":hex::encode(identity.sign(b"native signed").unwrap())})
    );
}
