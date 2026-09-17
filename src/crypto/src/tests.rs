use super::*;
use std::sync::OnceLock;
fn hx(s: &str) -> Vec<u8> {
    hex::decode(s).unwrap()
}
fn identity() -> &'static Identity {
    static VALUE: OnceLock<Identity> = OnceLock::new();
    VALUE.get_or_init(|| {
        derive_identity(
            "slop86-test",
            b"public test password - never use".to_vec(),
            "main",
        )
        .unwrap()
    })
}
#[test]
fn official_sha256_hkdf_vectors() {
    assert_eq!(
        hex::encode(Sha256::digest(b"abc")),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    let mut out = [0; 42];
    Hkdf::<Sha256>::new(Some(&hx("000102030405060708090a0b0c")), &[0x0b; 22])
        .expand(&hx("f0f1f2f3f4f5f6f7f8f9"), &mut out)
        .unwrap();
    assert_eq!(
        hex::encode(out),
        "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865"
    );
}
#[test]
fn official_argon2id_rfc9106() {
    let mut params = argon2::ParamsBuilder::new();
    params
        .m_cost(32)
        .t_cost(3)
        .p_cost(4)
        .output_len(32)
        .data(argon2::AssociatedData::new(&[4; 12]).unwrap());
    let argon = Argon2::new_with_secret(
        &[3; 8],
        Algorithm::Argon2id,
        Version::V0x13,
        params.build().unwrap(),
    )
    .unwrap();
    let mut out = [0; 32];
    argon
        .hash_password_into(&[1; 32], &[2; 16], &mut out)
        .unwrap();
    assert_eq!(
        hex::encode(out),
        "0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659"
    );
}
#[test]
fn official_chacha20_poly1305_rfc8439() {
    let key: Vec<u8> = (0x80..=0x9f).collect();
    let nonce = hx("070000004041424344454647");
    let aad = hx("50515253c0c1c2c3c4c5c6c7");
    let plain = b"Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.";
    let expected = hx(concat!("d31a8d34648e60db7b86afbc53ef7ec2a4aded51296e08fea9e2b5a736ee62d63dbea45e8ca9671282fafb69da92728b1a",
        "71de0a9e060b2905d6a5b67ecd3b3692ddbd7f2d778b8c9803aee328091b58fab324e4fad675945585808b4831d7bc3ff4def08e4b7a9de576d26586cec64b6116",
        "1ae10b594f09e26a7e902ecbd0600691"));
    let cipher = ChaCha20Poly1305::new_from_slice(&key).unwrap();
    assert_eq!(
        cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: plain,
                    aad: &aad
                }
            )
            .unwrap(),
        expected
    );
    assert_eq!(
        cipher
            .decrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: &expected,
                    aad: &aad
                }
            )
            .unwrap(),
        plain
    );
}
#[test]
fn official_ed25519_rfc8032() {
    let key = SigningKey::from_bytes(
        &hx("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
            .try_into()
            .unwrap(),
    );
    assert_eq!(
        hex::encode(key.verifying_key().to_bytes()),
        "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"
    );
    let signature = key.sign(b"").to_bytes();
    assert_eq!(
        hex::encode(signature),
        concat!(
            "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155",
            "5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"
        )
    );
    assert!(verify(&key.verifying_key().to_bytes(), b"", &signature));
    assert!(!verify(
        &key.verifying_key().to_bytes(),
        b"changed",
        &signature
    ));
    assert!(!verify(&[0; 31], b"", &signature));
    assert!(!verify(&[0; 32], b"", &[0; 64]));
}
#[test]
fn identity_normalization_and_literal_password() {
    let a = derive_identity("café", b" literal ".to_vec(), "main").unwrap();
    let b = derive_identity("cafe\u{301}", b" literal ".to_vec(), "main").unwrap();
    assert_eq!(a.ipns_name().unwrap(), b.ipns_name().unwrap());
    let c = derive_identity("café", b"literal".to_vec(), "main").unwrap();
    let d = derive_identity("Café", b" literal ".to_vec(), "main").unwrap();
    let e = derive_identity(" café", b" literal ".to_vec(), "main").unwrap();
    assert_ne!(a.ipns_name().unwrap(), c.ipns_name().unwrap());
    assert_ne!(a.ipns_name().unwrap(), d.ipns_name().unwrap());
    assert_ne!(a.ipns_name().unwrap(), e.ipns_name().unwrap());
    let cid: Cid = a.ipns_name().unwrap().parse().unwrap();
    assert_eq!(cid.codec(), 0x72);
    assert_eq!(&cid.hash().digest()[..4], &[8, 1, 18, 32]);
    assert_eq!(&cid.hash().digest()[4..], a.public_key().unwrap());
}
#[test]
fn descriptor_recovery_wrong_identity_and_closing() {
    let identity = identity();
    let disk = identity.create_disk().unwrap();
    let descriptor = identity.seal_descriptor(&disk).unwrap();
    let recovered = identity.open_disk(&descriptor).unwrap();
    let data = disk.seal_unit(&ZERO_NONCE, b"secret".to_vec()).unwrap();
    assert_eq!(recovered.open_unit(&ZERO_NONCE, &data).unwrap(), b"secret");
    let mut wrong = derive_identity("slop86-test", b"wrong password".to_vec(), "main").unwrap();
    assert!(wrong.open_disk(&descriptor).is_err());
    wrong.close();
    assert!(wrong.sign(b"x").is_err());
    assert!(wrong.create_disk().is_err());
    assert!(wrong.signing_seed.iter().all(|b| *b == 0));
    assert!(wrong.metadata_key.iter().all(|b| *b == 0));
    let mut recovered = recovered;
    recovered.close();
    assert!(recovered.key.iter().all(|b| *b == 0));
    assert!(recovered.open_unit(&ZERO_NONCE, &data).is_err());
}
#[test]
fn authenticates_every_byte_and_context() {
    let disk = identity().create_disk().unwrap();
    let original = disk
        .seal_unit(&ZERO_NONCE, b"test content with slack\0\0".to_vec())
        .unwrap();
    for i in 0..original.len() {
        let mut tampered = original.clone();
        tampered[i] ^= 1;
        assert!(disk.open_unit(&ZERO_NONCE, &tampered).is_err(), "byte {i}");
    }
    for end in 0..original.len() {
        assert!(disk.open_unit(&ZERO_NONCE, &original[..end]).is_err());
    }
    let mut extended = original.clone();
    extended.push(0);
    assert!(disk.open_unit(&ZERO_NONCE, &extended).is_err());
    assert!(disk.open_unit(&[1; 12], &original).is_err());
    assert!(identity()
        .create_disk()
        .unwrap()
        .open_unit(&ZERO_NONCE, &original)
        .is_err());
    assert!(disk.open_metadata(&original).is_err());
    let meta = disk.seal_metadata(b"encrypted metadata".to_vec()).unwrap();
    assert_eq!(disk.open_metadata(&meta).unwrap(), b"encrypted metadata");
    assert!(disk.open_unit(&ZERO_NONCE, &meta).is_err());
}
#[test]
fn unit_roundtrip_preserves_all_bytes() {
    let disk = identity().create_disk().unwrap();
    let image: Vec<u8> = (0..16_417)
        .map(|i| if i % 1024 < 128 { 0 } else { (i * 37) as u8 })
        .collect();
    let mut objects = Vec::new();
    for (i, bytes) in image.chunks(512).enumerate() {
        let mut unit = [0; 12];
        unit[..8].copy_from_slice(&(i as u64).to_le_bytes());
        objects.push((unit, disk.seal_unit(&unit, bytes.to_vec()).unwrap()));
    }
    let restored: Vec<u8> = objects
        .iter()
        .flat_map(|(unit, blob)| disk.open_unit(unit, blob).unwrap())
        .collect();
    assert_eq!(restored, image);
    let before: Vec<String> = objects.iter().map(|(_, blob)| object_cid(blob)).collect();
    let changed = disk
        .seal_unit(&objects[2].0, image[1024..1536].to_vec())
        .unwrap();
    assert_ne!(object_cid(&changed), before[2]);
    objects[2].1 = changed;
    for i in [0, 1, 3] {
        assert_eq!(object_cid(&objects[i].1), before[i]);
    }
    assert_eq!(
        objects
            .iter()
            .flat_map(|(unit, blob)| disk.open_unit(unit, blob).unwrap())
            .collect::<Vec<_>>(),
        image
    );
}
#[test]
fn boundaries_and_domain_separation() {
    assert!(derive_identity("", b"x".to_vec(), "main").is_err());
    assert!(derive_identity("x", vec![], "main").is_err());
    assert!(derive_identity("x", vec![0; 4097], "main").is_err());
    let disk = identity().create_disk().unwrap();
    assert!(disk.seal_unit(&[0; 11], vec![]).is_err());
    assert!(disk
        .seal_unit(&ZERO_NONCE, vec![0; MAX_UNIT_BYTES + 1])
        .is_err());
    let empty = disk.seal_unit(&[255; 12], vec![]).unwrap();
    assert_eq!(
        disk.open_unit(&[255; 12], &empty).unwrap(),
        Vec::<u8>::new()
    );
    let salt = [42; 32];
    let a = seal_with_salt(&disk.key, DATA, &ZERO_NONCE, &disk.id, b"same", &salt).unwrap();
    let b = seal_with_salt(&disk.key, METADATA, &ZERO_NONCE, &disk.id, b"same", &salt).unwrap();
    assert_ne!(&a[HEADER..], &b[HEADER..]);
}
#[test]
fn identity_v2_frozen_compatibility_vector() {
    let id = derive_identity(
        "cafe\u{301}",
        b"public compatibility test password ".to_vec(),
        "main",
    )
    .unwrap();
    assert_eq!(
        id.ipns_name().unwrap(),
        "k51qzi5uqu5dgdlw0tx7xd43vjs8hndfm8dychj8jvmigb8g8x7or3a1ax94yc"
    );
    assert_eq!(
        hex::encode(id.public_key().unwrap()),
        "07d2860c1066244fa0d7973545b4dd822466d8b2c9fd83fb84331716949b3a54"
    );
    assert_eq!(hex::encode(id.sign(b"native signed").unwrap()), "fa15c61c3d6a0a42eaa3a013826e71cfa2cde4b879bb9e9ef19ff11a18f2f475d8f928701d3288a2166f3ea384f9f4aa8fa0bbf6e43effb9f34f4432a97b3102");
}

#[test]
fn machine_namespace_is_unambiguous_and_literal() {
    let derive = |u: &str, m: &str| {
        derive_identity(u, b"password".to_vec(), m)
            .unwrap()
            .public_key()
            .unwrap()
    };
    assert_eq!(
        derive("café", "máquina"),
        derive("cafe\u{301}", "ma\u{301}quina")
    );
    assert_ne!(derive("u", "main"), derive("u", "Main"));
    assert_ne!(derive("u", "main"), derive("u", " main"));
    assert_ne!(derive("ab", "c"), derive("a", "bc"));
    assert!(derive_identity("u", b"p".to_vec(), "").is_err());
    assert!(derive_identity("u", b"p".to_vec(), &"a".repeat(4097)).is_err());
}

#[test]
fn read_capability_roundtrip_and_validation() {
    let owner = identity();
    let disk = owner.create_disk().unwrap();
    let key = disk.export_read_key().unwrap();
    assert_eq!(key.len(), 48);
    assert_eq!(&key[..16], disk.id().unwrap());
    let encrypted = disk.seal_unit(&[0; 12], vec![1, 2, 3]).unwrap();
    let mut reader = Disk::from_read_key(key.to_vec()).unwrap();
    assert_eq!(reader.open_unit(&[0; 12], &encrypted).unwrap(), [1, 2, 3]);
    for pos in [0, 16, 47] {
        let mut bad = key.to_vec();
        bad[pos] ^= 1;
        assert!(Disk::from_read_key(bad)
            .unwrap()
            .open_unit(&[0; 12], &encrypted)
            .is_err());
    }
    for size in [0, 16, 32, 47, 49] {
        assert!(Disk::from_read_key(vec![0; size]).is_err());
    }
    reader.close();
    assert!(reader.export_read_key().is_err());
    assert!(reader.open_unit(&[0; 12], &encrypted).is_err());
}
