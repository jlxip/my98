pub fn bytes(n: usize) -> Vec<u8> {
    let mut x = 12345u32;
    (0..n)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            x as u8
        })
        .collect()
}
pub fn put16(b: &mut [u8], o: usize, n: u16) {
    b[o..o + 2].copy_from_slice(&n.to_le_bytes());
}
pub fn put32(b: &mut [u8], o: usize, n: u32) {
    b[o..o + 4].copy_from_slice(&n.to_le_bytes());
}
pub fn fat_image() -> (Vec<u8>, usize, Vec<u8>) {
    let clusters = 65525;
    let reserved = 32;
    let fat_sectors = 512;
    let data = (reserved + 2 * fat_sectors) * 512;
    let mut image = vec![0xa7; (reserved + 2 * fat_sectors + clusters) * 512 + 31];
    image[..512].fill(0);
    image[0..3].copy_from_slice(&[0xeb, 0x58, 0x90]);
    put16(&mut image, 11, 512);
    image[13] = 1;
    put16(&mut image, 14, 32);
    image[16] = 2;
    put32(
        &mut image,
        32,
        (reserved + 2 * fat_sectors + clusters) as u32,
    );
    put32(&mut image, 36, fat_sectors as u32);
    put32(&mut image, 44, 2);
    image[510..512].copy_from_slice(&[0x55, 0xaa]);
    image[reserved * 512..data].fill(0);
    let content = bytes(170123);
    for f in 0..2 {
        let base = (reserved + f * fat_sectors) * 512;
        put32(&mut image, base, 0x0ffffff8);
        put32(&mut image, base + 4, 0xffffffff);
        put32(&mut image, base + 8, 0x0fffffff);
        let count = content.len().div_ceil(512);
        for i in 0..count {
            let cluster = 3 + i * 2;
            put32(
                &mut image,
                base + cluster * 4,
                if i + 1 == count {
                    0x0fffffff
                } else {
                    (cluster + 2) as u32
                },
            );
        }
    }
    image[data..data + 512].fill(0);
    image[data..data + 11].copy_from_slice(b"FILE    BIN");
    image[data + 11] = 0x20;
    put16(&mut image, data + 26, 3);
    put32(&mut image, data + 28, content.len() as u32);
    for (i, chunk) in content.chunks(512).enumerate() {
        let pos = data + (1 + i * 2) * 512;
        image[pos..pos + chunk.len()].copy_from_slice(chunk);
    }
    (image, data, content)
}
