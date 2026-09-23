//! Linear, independently authenticated disk records. No network or persistent storage.
use serde::Serialize;
use sha2::{Digest, Sha256};
use slop86_crypto::{derive_identity, verify, Disk, Identity, ReadCapability};
use std::collections::{BTreeMap, HashMap};
use zeroize::Zeroizing;

pub const CHUNK: usize = 65536;
pub const HEADER: usize = 198;
pub const OVERHEAD: usize = 62;
pub const MAX_SIZE: u64 = 1 << 40;
pub const CACHE_LIMIT: usize = 32 * 1024 * 1024 - 512;
const MAGIC: &[u8; 8] = b"SLOPDSK\0";
const DOMAIN: &[u8] = b"slop86/linear-disk/v1\0";
#[derive(Debug, Serialize)]
pub struct Error {
    pub code: &'static str,
    pub message: String,
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for Error {}
pub type Result<T> = std::result::Result<T, Error>;
pub fn error(code: &'static str, message: impl Into<String>) -> Error {
    Error {
        code,
        message: message.into(),
    }
}
fn operation(e: String) -> Error {
    error("OPERATION_FAILED", e)
}
fn corrupt(e: impl Into<String>) -> Error {
    error("CORRUPTION", e)
}
#[async_trait::async_trait(?Send)]
pub trait Io {
    async fn read(&self, source: &str, offset: u64, length: usize) -> Result<Vec<u8>>;
    fn cancelled(&self) -> bool {
        false
    }
}
fn check(io: &dyn Io) -> Result<()> {
    if io.cancelled() {
        Err(error("CANCELLED", "Operation cancelled"))
    } else {
        Ok(())
    }
}
async fn exact(io: &dyn Io, source: &str, offset: u64, length: usize) -> Result<Vec<u8>> {
    check(io)?;
    let b = io.read(source, offset, length).await?;
    check(io)?;
    if b.len() != length {
        return Err(error("IO_ERROR", "Short source read"));
    }
    Ok(b)
}
pub fn file_size(size: u64) -> Result<u64> {
    if size == 0 || size > MAX_SIZE {
        return Err(corrupt("Image length must be between 1 byte and 1 TiB"));
    }
    Ok(HEADER as u64 + size + size.div_ceil(CHUNK as u64) * OVERHEAD as u64)
}
fn unit(index: u64) -> [u8; 12] {
    let mut n = [0; 12];
    n[..8].copy_from_slice(&index.to_le_bytes());
    n
}
fn signed(bytes: &[u8]) -> Vec<u8> {
    let mut b = DOMAIN.to_vec();
    b.extend_from_slice(bytes);
    b
}
fn make_header(id: &Identity, disk: &Disk, size: u64) -> Result<Vec<u8>> {
    file_size(size)?;
    let mut b = MAGIC.to_vec();
    b.extend_from_slice(&1u32.to_le_bytes());
    b.extend_from_slice(&(CHUNK as u32).to_le_bytes());
    b.extend_from_slice(&size.to_le_bytes());
    b.extend(id.seal_descriptor(disk).map_err(operation)?);
    if b.len() != 134 {
        return Err(corrupt("Descriptor length mismatch"));
    }
    b.extend(id.sign(&signed(&b)).map_err(operation)?);
    Ok(b)
}
fn header_size(b: &[u8], total: u64) -> Result<u64> {
    if b.len() < 8 {
        return Err(corrupt("Truncated disk header"));
    }
    if &b[..8] != MAGIC {
        return Err(error("UNSUPPORTED_FORMAT","Unsupported disk format. CAR histories v1/v2/v3 are not supported; create a new disk from an image."));
    }
    if b.len() != HEADER {
        return Err(corrupt("Truncated disk header"));
    }
    if u32::from_le_bytes(b[8..12].try_into().unwrap()) != 1
        || u32::from_le_bytes(b[12..16].try_into().unwrap()) != CHUNK as u32
    {
        return Err(error(
            "UNSUPPORTED_FORMAT",
            "Unsupported linear disk format",
        ));
    }
    let size = u64::from_le_bytes(b[16..24].try_into().unwrap());
    if file_size(size)? != total {
        return Err(corrupt("Encrypted file length mismatch"));
    }
    Ok(size)
}
fn parse_header(id: &Identity, b: &[u8], total: u64) -> Result<(Disk, u64)> {
    let size = header_size(b, total)?;
    let disk = id.open_disk(&b[24..134]).map_err(|_| {
        error(
            "AUTHENTICATION_FAILED",
            "Credentials are incorrect or the encrypted descriptor is damaged",
        )
    })?;
    verify_header(&id.public_key().map_err(operation)?, b)?;
    Ok((disk, size))
}
fn verify_header(public_key: &[u8], b: &[u8]) -> Result<()> {
    if !verify(public_key, &signed(&b[..134]), &b[134..]) {
        return Err(corrupt("Invalid disk header signature"));
    }
    Ok(())
}
struct Cache {
    values: HashMap<u64, (Zeroizing<Vec<u8>>, u64)>,
    bytes: usize,
    tick: u64,
}
impl Cache {
    fn new() -> Self {
        Self {
            values: HashMap::new(),
            bytes: 0,
            tick: 0,
        }
    }
    fn get(&mut self, key: u64) -> Option<Zeroizing<Vec<u8>>> {
        self.tick += 1;
        self.values.get_mut(&key).map(|(v, t)| {
            *t = self.tick;
            v.clone()
        })
    }
    fn put(&mut self, key: u64, b: Zeroizing<Vec<u8>>) {
        if let Some((v, _)) = self.values.remove(&key) {
            self.bytes -= v.len();
        }
        while self.bytes + b.len() > CACHE_LIMIT {
            let k = *self.values.iter().min_by_key(|(_, (_, t))| t).unwrap().0;
            self.bytes -= self.values.remove(&k).unwrap().0.len();
        }
        self.tick += 1;
        self.bytes += b.len();
        self.values.insert(key, (b, self.tick));
    }
}
struct Image {
    source: String,
    size: u64,
    disk: Disk,
    dirty: BTreeMap<u64, Zeroizing<Vec<u8>>>,
    cache: Cache,
}
impl Image {
    fn bounds(&self, offset: u64, len: usize) -> Result<()> {
        if offset > self.size || len as u64 > self.size - offset {
            Err(error("IO_ERROR", "Disk range out of bounds"))
        } else {
            Ok(())
        }
    }
    async fn original(&mut self, io: &dyn Io, index: u64) -> Result<Zeroizing<Vec<u8>>> {
        check(io)?;
        if let Some(b) = self.cache.get(index) {
            return Ok(b);
        }
        let start = index
            .checked_mul(CHUNK as u64)
            .ok_or_else(|| corrupt("Offset overflow"))?;
        if start >= self.size {
            return Err(error("IO_ERROR", "Chunk out of bounds"));
        }
        let len = (self.size - start).min(CHUNK as u64) as usize;
        let enc = exact(
            io,
            &self.source,
            HEADER as u64 + index * (CHUNK + OVERHEAD) as u64,
            len + OVERHEAD,
        )
        .await?;
        let b = Zeroizing::new(
            self.disk
                .open_unit(&unit(index), &enc)
                .map_err(|_| corrupt("Chunk authentication failed"))?,
        );
        if b.len() != len {
            return Err(corrupt("Chunk plaintext length mismatch"));
        }
        self.cache.put(index, b.clone());
        Ok(b)
    }
    async fn read(&mut self, io: &dyn Io, offset: u64, len: usize) -> Result<Zeroizing<Vec<u8>>> {
        self.bounds(offset, len)?;
        let mut out = Zeroizing::new(vec![0; len]);
        let mut done = 0;
        while done < len {
            check(io)?;
            let pos = offset + done as u64;
            let sector = pos / 512;
            let inside = (pos % 512) as usize;
            let n = (512 - inside).min(len - done);
            if let Some(b) = self.dirty.get(&sector) {
                out[done..done + n].copy_from_slice(&b[inside..inside + n]);
                done += n;
                continue;
            }
            let index = pos / CHUNK as u64;
            let b = self.original(io, index).await?;
            let inner = (pos % CHUNK as u64) as usize;
            let end = (CHUNK - inner).min(len - done);
            out[done..done + end].copy_from_slice(&b[inner..inner + end]);
            // Overlay all pending sectors in this span, including partial image tails.
            let last = (pos + end as u64 - 1) / 512;
            for (&s, bytes) in self.dirty.range(sector..=last) {
                let a = (s * 512).max(pos);
                let z = (s * 512 + bytes.len() as u64).min(pos + end as u64);
                if z > a {
                    out[done + (a - pos) as usize..done + (z - pos) as usize]
                        .copy_from_slice(&bytes[(a - s * 512) as usize..(z - s * 512) as usize]);
                }
            }
            done += end;
        }
        Ok(out)
    }
}
struct Build {
    disk: Disk,
    size: u64,
    header: Vec<u8>,
    raw: Option<String>,
    index: u64,
    revision: u64,
}
#[derive(Serialize)]
pub struct Description {
    #[serde(rename = "readOnly")]
    pub read_only: bool,
    pub size: u64,
    pub disk_id: Vec<u8>,
    pub dirty_bytes: usize,
    pub dirty_sectors: usize,
    pub cache_bytes: usize,
    pub revision: u64,
}
pub struct Engine {
    identity: Option<Identity>,
    image: Option<Image>,
    build: Option<Build>,
    revision: u64,
    hash: Option<(Sha256, u64, u64)>,
    unchanged: Option<u64>,
}
mod snapshot;

impl Engine {
    pub fn new(username: &str, password: Vec<u8>, machine: &str) -> Result<Self> {
        Ok(Self {
            identity: Some(derive_identity(username, password, machine).map_err(operation)?),
            image: None,
            build: None,
            revision: 0,
            hash: None,
            unchanged: None,
        })
    }
    pub fn identity(&self) -> Result<&Identity> {
        self.identity
            .as_ref()
            .ok_or_else(|| error("READ_ONLY", "Read-only disk has no owner identity"))
    }
    pub fn export_read_key(&self) -> Result<Zeroizing<Vec<u8>>> {
        self.identity()?.export_read_key().map_err(operation)
    }
    /// The caller must authenticate the entire source's content-addressed path.
    /// The identity-wide capability authenticates the header signature and descriptor.
    /// The candidate is committed only after its first data record authenticates.
    pub async fn open_read_only(
        io: &dyn Io,
        source: String,
        total: u64,
        read_key: Vec<u8>,
    ) -> Result<Self> {
        let capability = ReadCapability::from_bytes(read_key)
            .map_err(|_| error("INVALID_READ_KEY", "Invalid read key"))?;
        let b = exact(io, &source, 0, total.min(HEADER as u64) as usize).await?;
        let size = header_size(&b, total)?;
        verify_header(capability.public_key(), &b)?;
        let disk = capability.open_disk(&b[24..134]).map_err(|_| {
            error(
                "AUTHENTICATION_FAILED",
                "Read key cannot authenticate the disk descriptor",
            )
        })?;
        drop(capability);
        let mut image = Image {
            source,
            size,
            disk,
            dirty: BTreeMap::new(),
            cache: Cache::new(),
        };
        image.original(io, 0).await?;
        check(io)?;
        Ok(Self {
            identity: None,
            image: Some(image),
            build: None,
            revision: 1,
            hash: None,
            unchanged: None,
        })
    }
    pub fn describe(&self) -> Result<Description> {
        let i = self
            .image
            .as_ref()
            .ok_or_else(|| operation("No disk open".into()))?;
        Ok(Description {
            read_only: self.identity.is_none(),
            size: i.size,
            disk_id: i.disk.id().map_err(operation)?,
            dirty_bytes: i.dirty.values().map(|b| b.len()).sum(),
            dirty_sectors: i.dirty.len(),
            cache_bytes: i.cache.bytes,
            revision: self.revision,
        })
    }
    pub fn source(&self) -> Result<&str> {
        Ok(&self
            .image
            .as_ref()
            .ok_or_else(|| operation("No disk open".into()))?
            .source)
    }
    pub async fn open(&mut self, io: &dyn Io, source: String, total: u64) -> Result<()> {
        self.identity()?;
        if self.image.is_some() || self.build.is_some() {
            return Err(operation(
                "Close the current disk before opening another".into(),
            ));
        }
        let b = exact(io, &source, 0, total.min(HEADER as u64) as usize).await?;
        let (disk, size) = parse_header(self.identity()?, &b, total)?;
        check(io)?;
        self.image = Some(Image {
            source,
            size,
            disk,
            dirty: BTreeMap::new(),
            cache: Cache::new(),
        });
        self.revision += 1;
        Ok(())
    }
    pub fn begin_create(&mut self, source: String, size: u64) -> Result<()> {
        self.identity()?;
        if self.image.is_some() || self.build.is_some() {
            return Err(operation(
                "Close the current disk before creating another".into(),
            ));
        }
        file_size(size)?;
        self.begin(Some(source), size)
    }
    fn begin(&mut self, raw: Option<String>, size: u64) -> Result<()> {
        if self.build.is_some() {
            return Err(operation("A save is already being prepared".into()));
        }
        let disk = self.identity()?.create_disk().map_err(operation)?;
        let header = make_header(self.identity()?, &disk, size)?;
        self.build = Some(Build {
            disk,
            size,
            header,
            raw,
            index: 0,
            revision: self.revision,
        });
        Ok(())
    }
    /// Returns false for unchanged; checked marks are cleared only after every comparison succeeds.
    pub async fn begin_save(&mut self, io: &dyn Io) -> Result<bool> {
        self.identity()?;
        if self.build.is_some() {
            return Err(operation("A save is already being prepared".into()));
        }
        let image = self
            .image
            .as_mut()
            .ok_or_else(|| operation("No disk open".into()))?;
        let sectors: Vec<u64> = image.dirty.keys().copied().collect();
        let mut changed = false;
        let mut group = None;
        let mut original = Zeroizing::new(Vec::new());
        for sector in sectors {
            check(io)?;
            let index = sector / 128;
            if group != Some(index) {
                original = image.original(io, index).await?;
                group = Some(index);
            }
            let inside = (sector % 128) as usize * 512;
            let bytes = &image.dirty[&sector];
            if original[inside..inside + bytes.len()] != bytes[..] {
                changed = true;
            }
        }
        check(io)?;
        if !changed {
            self.unchanged = Some(self.revision);
            return Ok(false);
        }
        let size = image.size;
        self.begin(None, size)?;
        Ok(true)
    }
    pub fn accept_unchanged(&mut self, io: &dyn Io) -> Result<()> {
        self.identity()?;
        check(io)?;
        if self.unchanged != Some(self.revision) {
            return Err(operation("Stale unchanged result".into()));
        }
        self.image.as_mut().unwrap().dirty.clear();
        self.unchanged = None;
        Ok(())
    }
    pub fn header(&self) -> Result<Vec<u8>> {
        self.identity()?;
        Ok(self
            .build
            .as_ref()
            .ok_or_else(|| operation("No prepared save".into()))?
            .header
            .clone())
    }
    pub async fn next(&mut self, io: &dyn Io) -> Result<Option<Vec<u8>>> {
        self.identity()?;
        check(io)?;
        let b = self
            .build
            .as_ref()
            .ok_or_else(|| operation("No prepared save".into()))?;
        if b.revision != self.revision {
            return Err(operation("Stale prepared save".into()));
        }
        let index = b.index;
        let offset = index * CHUNK as u64;
        if offset >= b.size {
            return Ok(None);
        }
        let len = (b.size - offset).min(CHUNK as u64) as usize;
        let bytes = if let Some(source) = &b.raw {
            Zeroizing::new(exact(io, source, offset, len).await?)
        } else {
            self.image.as_mut().unwrap().read(io, offset, len).await?
        };
        let result = self
            .build
            .as_ref()
            .unwrap()
            .disk
            .seal_unit(&unit(index), bytes.to_vec())
            .map_err(operation)?;
        check(io)?;
        self.build.as_mut().unwrap().index += 1;
        Ok(Some(result))
    }
    pub fn accept(&mut self, io: &dyn Io, source: String, total: u64) -> Result<()> {
        self.identity()?;
        check(io)?;
        let b = self
            .build
            .as_ref()
            .ok_or_else(|| operation("No prepared save".into()))?;
        if b.revision != self.revision || b.index != b.size.div_ceil(CHUNK as u64) {
            return Err(operation("Stale or incomplete prepared save".into()));
        }
        if total != file_size(b.size)? {
            return Err(corrupt("Assembled file length mismatch"));
        }
        let b = self.build.take().unwrap();
        self.image = Some(Image {
            source,
            size: b.size,
            disk: b.disk,
            dirty: BTreeMap::new(),
            cache: Cache::new(),
        });
        self.revision += 1;
        self.hash = None;
        Ok(())
    }
    pub fn cancel(&mut self) {
        self.unchanged = None;
        self.build = None;
        self.hash = None;
    }
    pub async fn read(&mut self, io: &dyn Io, offset: u64, len: usize) -> Result<Vec<u8>> {
        Ok(self
            .image
            .as_mut()
            .ok_or_else(|| operation("No disk open".into()))?
            .read(io, offset, len)
            .await?
            .to_vec())
    }
    pub async fn write(&mut self, io: &dyn Io, offset: u64, bytes: &[u8]) -> Result<()> {
        let image = self
            .image
            .as_mut()
            .ok_or_else(|| operation("No disk open".into()))?;
        image.bounds(offset, bytes.len())?;
        check(io)?;
        if bytes.is_empty() {
            return Ok(());
        }
        let mut staged = BTreeMap::new();
        let mut done = 0;
        while done < bytes.len() {
            check(io)?;
            let pos = offset + done as u64;
            let sector = pos / 512;
            let start = sector * 512;
            let actual = (image.size - start).min(512) as usize;
            let inside = (pos - start) as usize;
            let n = (actual - inside).min(bytes.len() - done);
            let mut value = if inside == 0 && n == actual {
                Zeroizing::new(vec![0; actual])
            } else {
                image.read(io, start, actual).await?
            };
            value[inside..inside + n].copy_from_slice(&bytes[done..done + n]);
            staged.insert(sector, value);
            done += n;
        }
        check(io)?;
        image.dirty.extend(staged);
        self.revision += 1;
        Ok(())
    }
    pub fn discard(&mut self) -> Result<()> {
        let image = self
            .image
            .as_mut()
            .ok_or_else(|| operation("No disk open".into()))?;
        image.dirty.clear();
        self.revision += 1;
        self.cancel();
        Ok(())
    }
    pub fn clear_cache(&mut self) {
        if let Some(i) = &mut self.image {
            i.cache = Cache::new();
        }
    }
    pub fn verify_start(&mut self) -> Result<()> {
        self.describe()?;
        self.hash = Some((Sha256::new(), 0, self.revision));
        Ok(())
    }
    pub async fn verify_step(&mut self, io: &dyn Io) -> Result<Option<Vec<u8>>> {
        check(io)?;
        let (_, index, revision) = self
            .hash
            .as_ref()
            .ok_or_else(|| operation("No verification in progress".into()))?;
        if *revision != self.revision {
            return Err(operation("Stale verification".into()));
        }
        let offset = *index * CHUNK as u64;
        let size = self.describe()?.size;
        if offset < size {
            let b = self
                .image
                .as_mut()
                .unwrap()
                .read(io, offset, (size - offset).min(CHUNK as u64) as usize)
                .await?;
            let (h, index, _) = self.hash.as_mut().unwrap();
            h.update(&b);
            *index += 1;
        }
        if offset + CHUNK as u64 >= size {
            check(io)?;
            return Ok(Some(self.hash.take().unwrap().0.finalize().to_vec()));
        }
        Ok(None)
    }
    pub async fn verify_image(&mut self, io: &dyn Io) -> Result<Vec<u8>> {
        self.verify_start()?;
        loop {
            if let Some(hash) = self.verify_step(io).await? {
                return Ok(hash);
            }
        }
    }
}
#[cfg(target_arch = "wasm32")]
mod wasm;
