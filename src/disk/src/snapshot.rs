use super::*;

impl Engine {
    pub async fn state_base(&self, io: &dyn Io) -> Result<Vec<u8>> {
        exact(io, self.source()?, 0, HEADER).await
    }
    pub fn state_overlay(&self) -> Result<Vec<u8>> {
        self.identity()?;
        let image = self
            .image
            .as_ref()
            .ok_or_else(|| operation("No disk open".into()))?;
        let mut out = Vec::new();
        for (&sector, bytes) in &image.dirty {
            out.extend_from_slice(&sector.to_le_bytes());
            out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
            out.extend_from_slice(bytes);
        }
        Ok(out)
    }
    /// Validate completely before creating an independent candidate. No write to
    /// the original engine occurs, even on a malformed final record.
    pub fn fork_state(&self, bytes: &[u8]) -> Result<Self> {
        if self.build.is_some() {
            return Err(operation("Disk save in progress".into()));
        }
        let image = self
            .image
            .as_ref()
            .ok_or_else(|| operation("No disk open".into()))?;
        let mut dirty = BTreeMap::new();
        let mut pos = 0;
        let mut previous = None;
        while pos < bytes.len() {
            if bytes.len() - pos < 12 {
                return Err(corrupt("Truncated state sector"));
            }
            let sector = u64::from_le_bytes(bytes[pos..pos + 8].try_into().unwrap());
            let len = u32::from_le_bytes(bytes[pos + 8..pos + 12].try_into().unwrap()) as usize;
            pos += 12;
            let offset = sector
                .checked_mul(512)
                .ok_or_else(|| corrupt("State sector overflow"))?;
            if offset >= image.size
                || previous.is_some_and(|p| sector <= p)
                || len != (image.size - offset).min(512) as usize
                || len > bytes.len() - pos
            {
                return Err(corrupt("Invalid state sector"));
            }
            dirty.insert(sector, Zeroizing::new(bytes[pos..pos + len].to_vec()));
            previous = Some(sector);
            pos += len;
        }
        Ok(Self {
            identity: self.identity.clone(),
            image: Some(Image {
                source: image.source.clone(),
                size: image.size,
                disk: Disk::from_read_key(
                    image.disk.export_read_key().map_err(operation)?.to_vec(),
                )
                .map_err(operation)?,
                dirty,
                cache: Cache::new(),
            }),
            build: None,
            revision: self.revision + 1,
            hash: None,
            unchanged: None,
        })
    }
    pub fn seal_state(&self, context: &[u8], bytes: Vec<u8>) -> Result<Vec<u8>> {
        self.identity()?;
        self.image
            .as_ref()
            .ok_or_else(|| operation("No disk open".into()))?
            .disk
            .seal_snapshot(context, bytes)
            .map_err(operation)
    }
    pub fn open_state(&self, context: &[u8], bytes: &[u8]) -> Result<Vec<u8>> {
        self.image
            .as_ref()
            .ok_or_else(|| operation("No disk open".into()))?
            .disk
            .open_snapshot(context, bytes)
            .map_err(|_| corrupt("State authentication failed"))
    }
}
