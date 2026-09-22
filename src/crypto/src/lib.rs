//! Versioned browser-independent identity and disk encryption primitives.
//! Network access, persistence and disk layout intentionally belong to callers.
use argon2::{Algorithm, Argon2, Block, Params, Version};
use chacha20poly1305::{
    aead::{Aead, Payload},
    ChaCha20Poly1305, KeyInit, Nonce,
};
use cid::{multibase::Base, multihash::Multihash, Cid};
use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use hkdf::Hkdf;
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;
use wasm_bindgen::prelude::*;
use zeroize::{Zeroize, Zeroizing};

type Result<T> = std::result::Result<T, String>;
const PREFIX: &[u8] = b"SL86";
const HEADER: usize = 46; // magic(4), version(1), kind(1), use salt(32), length LE64(8)
const TAG: usize = 16;
pub const MAX_UNIT_BYTES: usize = 16 * 1024 * 1024;
const DESCRIPTOR: u8 = 1;
const DATA: u8 = 2;
const METADATA: u8 = 3;
const SNAPSHOT: u8 = 4;
const ZERO_NONCE: [u8; 12] = [0; 12];
const AUTH: &str = "Authentication failed";

fn random<const N: usize>() -> Result<[u8; N]> {
    let mut value = [0; N];
    getrandom::getrandom(&mut value).map_err(|_| "Secure randomness unavailable".to_owned())?;
    Ok(value)
}
fn expand(ikm: &[u8], salt: &[u8], label: &[u8]) -> Zeroizing<[u8; 32]> {
    let mut output = Zeroizing::new([0; 32]);
    Hkdf::<Sha256>::new(Some(salt), ikm)
        .expand(label, output.as_mut())
        .expect("fixed HKDF length");
    output
}
fn label(kind: u8) -> &'static [u8] {
    match kind {
        DESCRIPTOR => b"slop86/descriptor/v1",
        DATA => b"slop86/data/v1",
        METADATA => b"slop86/disk-metadata/v1",
        SNAPSHOT => b"my98/machine-state/v1",
        _ => unreachable!(),
    }
}
fn seal(
    key: &[u8; 32],
    kind: u8,
    nonce: &[u8; 12],
    context: &[u8],
    bytes: &[u8],
) -> Result<Vec<u8>> {
    let use_salt = random::<32>()?;
    seal_with_salt(key, kind, nonce, context, bytes, &use_salt)
}
// Explicit salt is private, only accessible to deterministic protocol tests.
fn seal_with_salt(
    key: &[u8; 32],
    kind: u8,
    nonce: &[u8; 12],
    context: &[u8],
    bytes: &[u8],
    use_salt: &[u8; 32],
) -> Result<Vec<u8>> {
    if bytes.len() > MAX_UNIT_BYTES {
        return Err("Unit exceeds 16 MiB".into());
    }
    let mut header = Vec::with_capacity(HEADER);
    header.extend_from_slice(PREFIX);
    header.extend_from_slice(&[1, kind]);
    header.extend_from_slice(use_salt);
    header.extend_from_slice(&(bytes.len() as u64).to_le_bytes());
    let mut aad = header.clone();
    aad.extend_from_slice(context);
    let subkey = expand(key, use_salt, label(kind));
    let cipher = ChaCha20Poly1305::new_from_slice(subkey.as_ref()).expect("32-byte key");
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: bytes,
                aad: &aad,
            },
        )
        .map_err(|_| AUTH.to_owned())?;
    header.extend_from_slice(&ciphertext);
    Ok(header)
}
fn unseal(
    key: &[u8; 32],
    kind: u8,
    nonce: &[u8; 12],
    context: &[u8],
    envelope: &[u8],
) -> Result<Vec<u8>> {
    if envelope.len() < HEADER + TAG || envelope.len() > HEADER + TAG + MAX_UNIT_BYTES {
        return Err(AUTH.into());
    }
    if &envelope[..4] != PREFIX || envelope[4] != 1 || envelope[5] != kind {
        return Err(AUTH.into());
    }
    let length = u64::from_le_bytes(envelope[38..46].try_into().unwrap());
    if length != (envelope.len() - HEADER - TAG) as u64 {
        return Err(AUTH.into());
    }
    let subkey = expand(key, &envelope[6..38], label(kind));
    let mut aad = envelope[..HEADER].to_vec();
    aad.extend_from_slice(context);
    let cipher = ChaCha20Poly1305::new_from_slice(subkey.as_ref()).expect("32-byte key");
    cipher
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: &envelope[HEADER..],
                aad: &aad,
            },
        )
        .map_err(|_| AUTH.into())
}
fn unit_nonce(unit: &[u8]) -> Result<[u8; 12]> {
    unit.try_into()
        .map_err(|_| "Unit ID must contain exactly 12 bytes (unsigned LE96)".into())
}

#[wasm_bindgen]
#[derive(Clone)]
pub struct Identity {
    signing_seed: Zeroizing<[u8; 32]>,
    metadata_key: Zeroizing<[u8; 32]>,
    public_key: [u8; 32],
    active: bool,
}

/// Password bytes are consumed and zeroized. Username is NFC, case-sensitive;
/// Machine is also NFC and case-sensitive; no credential has whitespace removed. Argon2 parameters never auto-tune.
#[wasm_bindgen]
pub fn derive_identity(username: &str, password: Vec<u8>, machine: &str) -> Result<Identity> {
    let password = Zeroizing::new(password);
    if username.is_empty() || password.is_empty() || machine.is_empty() {
        return Err("Credentials must not be empty".into());
    }
    if username.len() > 4096 || password.len() > 4096 || machine.len() > 4096 {
        return Err("Credential exceeds 4096 UTF-8 bytes".into());
    }
    let normalized: String = username.nfc().collect();
    let mut hash = Sha256::new();
    let normalized_machine: String = machine.nfc().collect();
    if normalized.len() > 4096 || normalized_machine.len() > 4096 {
        return Err("Credential exceeds 4096 UTF-8 bytes".into());
    }
    hash.update(b"slop86/identity/v2\0");
    for field in [&normalized, &normalized_machine] {
        hash.update((field.len() as u32).to_le_bytes());
        hash.update(field.as_bytes());
    }
    let salt = hash.finalize();
    let params = Params::new(65536, 3, 4, Some(32)).expect("fixed Argon2 parameters");
    let mut memory = Zeroizing::new(vec![Block::default(); params.block_count()]);
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut master = Zeroizing::new([0; 32]);
    argon
        .hash_password_into_with_memory(&password, &salt[..16], master.as_mut(), &mut memory)
        .map_err(|_| "Key derivation failed".to_owned())?;
    let signing_seed = expand(master.as_ref(), b"slop86/keys/v1", b"slop86/signing/v1");
    let metadata_key = expand(
        master.as_ref(),
        b"slop86/keys/v1",
        b"slop86/identity-metadata/v1",
    );
    let public_key = SigningKey::from_bytes(&signing_seed)
        .verifying_key()
        .to_bytes();
    Ok(Identity {
        signing_seed,
        metadata_key,
        public_key,
        active: true,
    })
}

#[wasm_bindgen]
impl Identity {
    fn check(&self) -> Result<()> {
        if self.active {
            Ok(())
        } else {
            Err("Identity is closed".into())
        }
    }
    pub fn public_key(&self) -> Result<Vec<u8>> {
        self.check()?;
        Ok(self.public_key.to_vec())
    }
    pub fn ipns_name(&self) -> Result<String> {
        self.check()?;
        // libp2p PublicKey protobuf: Type=Ed25519(1), Data=32-byte public key.
        let mut protobuf = vec![0x08, 0x01, 0x12, 0x20];
        protobuf.extend_from_slice(&self.public_key);
        let hash = Multihash::<64>::wrap(0, &protobuf).expect("36-byte identity multihash");
        Cid::new_v1(0x72, hash)
            .to_string_of_base(Base::Base36Lower)
            .map_err(|_| "CID encoding failed".into())
    }
    /// Signs exact bytes. IPNS callers must supply the standard IPNS signing payload.
    pub fn sign(&self, message: &[u8]) -> Result<Vec<u8>> {
        self.check()?;
        if message.len() > MAX_UNIT_BYTES {
            return Err("Message exceeds 16 MiB".into());
        }
        Ok(SigningKey::from_bytes(&self.signing_seed)
            .sign(message)
            .to_bytes()
            .to_vec())
    }
    pub fn create_disk(&self) -> Result<Disk> {
        self.check()?;
        Ok(Disk {
            id: random()?,
            key: Zeroizing::new(random()?),
            active: true,
        })
    }
    pub fn seal_descriptor(&self, disk: &Disk) -> Result<Vec<u8>> {
        self.check()?;
        disk.check()?;
        let mut bytes = Zeroizing::new(Vec::with_capacity(48));
        bytes.extend_from_slice(&disk.id);
        bytes.extend_from_slice(disk.key.as_ref());
        seal(
            &self.metadata_key,
            DESCRIPTOR,
            &ZERO_NONCE,
            &self.public_key,
            &bytes,
        )
    }
    pub fn open_disk(&self, envelope: &[u8]) -> Result<Disk> {
        self.check()?;
        let bytes = Zeroizing::new(unseal(
            &self.metadata_key,
            DESCRIPTOR,
            &ZERO_NONCE,
            &self.public_key,
            envelope,
        )?);
        if bytes.len() != 48 {
            return Err(AUTH.into());
        }
        Ok(Disk {
            id: bytes[..16].try_into().unwrap(),
            key: Zeroizing::new(bytes[16..].try_into().unwrap()),
            active: true,
        })
    }
    pub fn close(&mut self) {
        self.signing_seed.zeroize();
        self.metadata_key.zeroize();
        self.active = false;
    }
}
impl Drop for Identity {
    fn drop(&mut self) {
        self.close();
    }
}

#[wasm_bindgen]
pub struct Disk {
    id: [u8; 16],
    key: Zeroizing<[u8; 32]>,
    active: bool,
}
#[wasm_bindgen]
impl Disk {
    fn check(&self) -> Result<()> {
        if self.active {
            Ok(())
        } else {
            Err("Disk is closed".into())
        }
    }
    pub fn id(&self) -> Result<Vec<u8>> {
        self.check()?;
        Ok(self.id.to_vec())
    }
    pub fn seal_unit(&self, unit_id: &[u8], bytes: Vec<u8>) -> Result<Vec<u8>> {
        let bytes = Zeroizing::new(bytes);
        self.check()?;
        let nonce = unit_nonce(unit_id)?;
        let mut context = self.id.to_vec();
        context.extend_from_slice(&nonce);
        seal(&self.key, DATA, &nonce, &context, &bytes)
    }
    pub fn open_unit(&self, unit_id: &[u8], envelope: &[u8]) -> Result<Vec<u8>> {
        self.check()?;
        let nonce = unit_nonce(unit_id)?;
        let mut context = self.id.to_vec();
        context.extend_from_slice(&nonce);
        unseal(&self.key, DATA, &nonce, &context, envelope)
    }
    /// Caller supplies the serialized private metadata bytes; no layout is imposed.
    pub fn seal_metadata(&self, bytes: Vec<u8>) -> Result<Vec<u8>> {
        let bytes = Zeroizing::new(bytes);
        self.check()?;
        seal(&self.key, METADATA, &ZERO_NONCE, &self.id, &bytes)
    }
    pub fn open_metadata(&self, envelope: &[u8]) -> Result<Vec<u8>> {
        self.check()?;
        unseal(&self.key, METADATA, &ZERO_NONCE, &self.id, envelope)
    }
    /// Independent domain, random per-record salt; context binds the whole container
    /// header and record position, preventing reordering or cross-state splicing.
    pub fn seal_snapshot(&self, context: &[u8], bytes: Vec<u8>) -> Result<Vec<u8>> {
        self.check()?;
        let bytes = Zeroizing::new(bytes);
        let mut aad = self.id.to_vec();
        aad.extend_from_slice(context);
        seal(&self.key, SNAPSHOT, &ZERO_NONCE, &aad, &bytes)
    }
    pub fn open_snapshot(&self, context: &[u8], bytes: &[u8]) -> Result<Vec<u8>> {
        self.check()?;
        let mut aad = self.id.to_vec();
        aad.extend_from_slice(context);
        unseal(&self.key, SNAPSHOT, &ZERO_NONCE, &aad, bytes)
    }
    pub fn close(&mut self) {
        self.key.zeroize();
        self.active = false;
    }
}
// Raw disk capability only: contains no identity or publishing material.
impl Disk {
    pub fn from_read_key(bytes: Vec<u8>) -> Result<Self> {
        let bytes = Zeroizing::new(bytes);
        if bytes.len() != 48 {
            return Err("Read key must contain exactly 48 bytes".into());
        }
        Ok(Self {
            id: bytes[..16].try_into().unwrap(),
            key: Zeroizing::new(bytes[16..].try_into().unwrap()),
            active: true,
        })
    }
    pub fn export_read_key(&self) -> Result<Zeroizing<Vec<u8>>> {
        self.check()?;
        let mut bytes = Zeroizing::new(Vec::with_capacity(48));
        bytes.extend_from_slice(&self.id);
        bytes.extend_from_slice(self.key.as_ref());
        Ok(bytes)
    }
}
impl Drop for Disk {
    fn drop(&mut self) {
        self.close();
    }
}

#[wasm_bindgen]
pub fn verify(public_key: &[u8], message: &[u8], signature: &[u8]) -> bool {
    let Ok(bytes) = <&[u8; 32]>::try_from(public_key) else {
        return false;
    };
    let Ok(key) = VerifyingKey::from_bytes(bytes) else {
        return false;
    };
    let Ok(signature) = Signature::from_slice(signature) else {
        return false;
    };
    key.verify_strict(message, &signature).is_ok()
}

/// IPFS CIDv1/raw/SHA-256 of the exact immutable envelope bytes.
#[wasm_bindgen]
pub fn object_cid(bytes: &[u8]) -> String {
    let hash = Multihash::<64>::wrap(0x12, &Sha256::digest(bytes)).expect("32-byte SHA-256");
    Cid::new_v1(0x55, hash).to_string()
}

#[cfg(test)]
mod tests;
