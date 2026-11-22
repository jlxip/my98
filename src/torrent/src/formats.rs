use anyhow::{bail, ensure, Context, Result};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs::File,
    io::{Read, Seek},
    path::Path,
};

pub fn disk(path: &Path, key: &[u8]) -> Result<[u8; 198]> {
    let mut file = File::open(path)?;
    ensure!(file.metadata()?.is_file(), "Disk must be a regular file");
    let mut header = [0; 198];
    file.read_exact(&mut header)?;
    let version = u32::from_le_bytes(header[8..12].try_into()?);
    let chunk = u32::from_le_bytes(header[12..16].try_into()?);
    let size = u64::from_le_bytes(header[16..24].try_into()?);
    ensure!(
        &header[..8] == b"SLOPDSK\0"
            && version == 1
            && chunk == 65536
            && (1..=1 << 40).contains(&size),
        "Unsupported .my98 header"
    );
    ensure!(
        file.metadata()?.len() == 198 + size + size.div_ceil(65536) * 62,
        "Invalid .my98 size"
    );
    let mut message = b"slop86/linear-disk/v1\0".to_vec();
    message.extend_from_slice(&header[..134]);
    ensure!(
        slop86_crypto::verify(key, &message, &header[134..]),
        "Disk belongs to a different identity or has an invalid signature"
    );
    Ok(header)
}
pub fn state(path: &Path, base: &[u8; 198]) -> Result<String> {
    let mut file = File::open(path)?;
    ensure!(file.metadata()?.is_file(), "State must be a regular file");
    let mut prefix = [0; 12];
    file.read_exact(&mut prefix)?;
    let length = u32::from_le_bytes(prefix[8..12].try_into()?) as usize;
    ensure!(
        &prefix[..8] == b"MY98STAT" && (1..=4096).contains(&length),
        "Invalid state header"
    );
    let mut bytes = vec![0; length];
    file.read_exact(&mut bytes)?;
    let header: Value = serde_json::from_slice(&bytes)?;
    ensure!(
        header["version"].as_u64() == Some(1),
        "Unsupported state version"
    );
    let raw = header["raw"].as_u64().context("Invalid state raw size")?;
    let packed = header["packed"]
        .as_u64()
        .context("Invalid state packed size")?;
    ensure!(
        (4..=1 << 30).contains(&raw) && (1..=1 << 30).contains(&packed),
        "Invalid state size"
    );
    let disk = header["base"].as_array().context("Missing state base")?;
    ensure!(
        disk.len() == base.len()
            && disk
                .iter()
                .zip(base)
                .all(|(v, b)| v.as_u64() == Some(u64::from(*b))),
        "State belongs to another disk"
    );
    let nonce = header["nonce"].as_array().context("Invalid state nonce")?;
    ensure!(
        nonce.len() == 16 && nonce.iter().all(|v| v.as_u64().is_some_and(|n| n < 256)),
        "Invalid state nonce"
    );
    let total = file.metadata()?.len();
    ensure!(
        total == 12 + length as u64 + packed + packed.div_ceil(1048576) * 62
            && total <= (1 << 30) + 65536,
        "Invalid state length"
    );
    file.rewind()?;
    let mut digest = Sha256::new();
    let mut buffer = [0; 65536];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        digest.update(&buffer[..n]);
    }
    Ok(crate::hex(&digest.finalize()))
}
pub fn profile(path: &Path, disk: &str, header: &[u8; 198], state: Option<&str>) -> Result<()> {
    let file = File::open(path)?;
    ensure!(
        file.metadata()?.is_file() && file.metadata()?.len() <= 65536,
        "Invalid profile file"
    );
    let profiles: Value = serde_json::from_reader(file)?;
    let profiles = profiles.as_array().context("Profiles must be an array")?;
    ensure!(profiles.len() <= 2, "Too many profiles");
    let mut origins = BTreeSet::new();
    let units = u64::from_le_bytes(header[16..24].try_into()?).div_ceil(65536);
    for p in profiles {
        ensure!(
            p["version"].as_u64() == Some(2)
                && p["infoHash"].as_str() == Some(disk)
                && p["unitBytes"].as_u64() == Some(65536),
            "Profile does not match disk"
        );
        let origin = &p["origin"];
        let kind = origin["kind"].as_str().context("Missing profile origin")?;
        ensure!(origins.insert(kind), "Duplicate profile origin");
        match kind {
            "boot" => ensure!(origin.get("sha256").is_none(), "Boot profile names a state"),
            "state" => ensure!(
                state.is_some() && origin["sha256"].as_str() == state,
                "Profile does not match state"
            ),
            _ => bail!("Invalid profile origin"),
        }
        let ranges = p["ranges"].as_array().context("Missing profile ranges")?;
        ensure!(ranges.len() == 32, "Expected 32 profile range slots");
        let mut sorted = vec![];
        for r in ranges.iter().filter(|r| !r.is_null()) {
            let r = r.as_array().context("Invalid range")?;
            ensure!(r.len() == 2, "Invalid range");
            let a = r[0].as_u64().context("Invalid range start")?;
            let b = r[1].as_u64().context("Invalid range end")?;
            ensure!(a <= b && b < units, "Profile range outside disk");
            sorted.push((a, b));
        }
        sorted.sort_unstable();
        ensure!(
            sorted.windows(2).all(|w| w[0].1 < w[1].0),
            "Overlapping profile ranges"
        );
        for key in ["observedUnits", "coveredUnits", "downloadUnits"] {
            if let Some(v) = p.get(key) {
                ensure!(
                    v.as_u64().is_some_and(|n| n <= units),
                    "Invalid profile metric"
                );
            }
        }
        if let Some(v) = p.get("minUtilization") {
            ensure!(
                v.as_f64().is_some_and(|n| n > 0.0 && n <= 1.0),
                "Invalid profile utilization"
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{
        fs,
        path::PathBuf,
        sync::atomic::{AtomicUsize, Ordering},
    };
    static SERIAL: AtomicUsize = AtomicUsize::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "my98-formats-{}-{}",
                std::process::id(),
                SERIAL.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn write(&self, name: &str, bytes: &[u8]) -> PathBuf {
            let path = self.0.join(name);
            fs::write(&path, bytes).unwrap();
            path
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn base() -> [u8; 198] {
        let mut header = [0; 198];
        header[..8].copy_from_slice(b"SLOPDSK\0");
        header[8..12].copy_from_slice(&1u32.to_le_bytes());
        header[12..16].copy_from_slice(&65536u32.to_le_bytes());
        header[16..24].copy_from_slice(&131072u64.to_le_bytes());
        header
    }
    #[test]
    fn disk_rejects_wrong_owner_tampering_and_truncation() {
        let f = Fixture::new();
        let identity = slop86_crypto::derive_identity(
            "format fixture",
            b"public test password".to_vec(),
            "main",
        )
        .unwrap();
        let key = identity.public_key().unwrap();
        let mut header = base();
        let mut message = b"slop86/linear-disk/v1\0".to_vec();
        message.extend_from_slice(&header[..134]);
        header[134..].copy_from_slice(&identity.sign(&message).unwrap());
        let mut bytes = header.to_vec();
        bytes.resize(198 + 131072 + 124, 0);
        let path = f.write("disk", &bytes);
        assert!(disk(&path, &key).is_ok());
        assert!(disk(&path, &[0; 32]).is_err());
        bytes[40] ^= 1;
        f.write("disk", &bytes);
        assert!(disk(&path, &key).is_err());
        bytes[40] ^= 1;
        bytes.pop();
        f.write("disk", &bytes);
        assert!(disk(&path, &key).is_err());
    }
    #[test]
    fn state_rejects_different_base_and_truncated_ciphertext() {
        let f = Fixture::new();
        let header = base();
        let json = serde_json::to_vec(
            &json!({"version":1,"raw":512,"packed":4,"base":header.to_vec(),"nonce":vec![0;16]}),
        )
        .unwrap();
        let mut bytes = b"MY98STAT".to_vec();
        bytes.extend_from_slice(&(json.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&json);
        bytes.resize(bytes.len() + 4 + 62, 0);
        let path = f.write("state", &bytes);
        let hash = state(&path, &header).unwrap();
        assert_eq!(hash.len(), 64);
        let mut other = header;
        other[24] ^= 1;
        assert!(state(&path, &other).is_err());
        bytes.pop();
        f.write("state", &bytes);
        assert!(state(&path, &header).is_err());
    }
    #[test]
    fn profiles_require_matching_snapshot_and_nonoverlapping_ranges() {
        let f = Fixture::new();
        let disk = "a".repeat(40);
        let state = "b".repeat(64);
        let mut ranges = vec![Value::Null; 32];
        ranges[0] = json!([0, 1]);
        let mut value = json!([{"version":2,"infoHash":disk,"unitBytes":65536,"origin":{"kind":"state","sha256":state},"ranges":ranges}]);
        let path = f.write("profile", &serde_json::to_vec(&value).unwrap());
        assert!(profile(&path, &disk, &base(), Some(&state)).is_ok());
        assert!(profile(&path, &disk, &base(), None).is_err());
        assert!(profile(&path, &"c".repeat(40), &base(), Some(&state)).is_err());
        assert!(profile(&path, &disk, &base(), Some(&"d".repeat(64))).is_err());
        value[0]["ranges"][1] = json!([1, 1]);
        f.write("profile", &serde_json::to_vec(&value).unwrap());
        assert!(profile(&path, &disk, &base(), Some(&state)).is_err());
        value[0]["ranges"][1] = json!([2, 2]);
        f.write("profile", &serde_json::to_vec(&value).unwrap());
        assert!(profile(&path, &disk, &base(), Some(&state)).is_err());
    }
}
