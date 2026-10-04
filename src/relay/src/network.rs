use std::{ffi::c_void, sync::mpsc as std_mpsc};
use tokio::sync::{mpsc, oneshot};

extern "C" {
    fn my98_slirp_new(
        send: extern "C" fn(*const u8, usize, *mut c_void) -> isize,
        opaque: *mut c_void,
    ) -> *mut c_void;
    fn my98_slirp_input(stack: *mut c_void, data: *const u8, len: i32);
    fn my98_slirp_poll(stack: *mut c_void);
    fn my98_slirp_free(stack: *mut c_void);
}
extern "C" fn output(data: *const u8, len: usize, opaque: *mut c_void) -> isize {
    if len > 1514 {
        return -1;
    }
    // Opaque sender outlives slirp and is only used on this stack's thread.
    let tx = unsafe { &*(opaque as *const mpsc::Sender<Vec<u8>>) };
    let bytes = unsafe { std::slice::from_raw_parts(data, len) };
    let _ = tx.try_send(bytes.to_vec()); // bounded; TCP retransmits dropped frames
    len as isize
}
pub struct Network {
    pub input: std_mpsc::SyncSender<Vec<u8>>,
    pub output: mpsc::Receiver<Vec<u8>>,
}
impl Network {
    pub async fn new() -> Result<Self, ()> {
        let (input, rx) = std_mpsc::sync_channel::<Vec<u8>>(256);
        let (tx, output_rx) = mpsc::channel(256);
        let (ready, wait) = oneshot::channel();
        std::thread::Builder::new()
            .name("relay-network".into())
            .spawn(move || {
                let stack = unsafe {
                    my98_slirp_new(
                        output,
                        (&tx as *const mpsc::Sender<Vec<u8>>).cast_mut().cast(),
                    )
                };
                if stack.is_null() {
                    let _ = ready.send(false);
                    return;
                }
                let _ = ready.send(true);
                'running: loop {
                    // Bound work per iteration so host I/O and shutdown are serviced.
                    for _ in 0..64 {
                        match rx.try_recv() {
                            Ok(bytes) => unsafe {
                                my98_slirp_input(stack, bytes.as_ptr(), bytes.len() as i32)
                            },
                            Err(std_mpsc::TryRecvError::Empty) => break,
                            Err(std_mpsc::TryRecvError::Disconnected) => break 'running,
                        }
                    }
                    unsafe { my98_slirp_poll(stack) };
                }
                unsafe { my98_slirp_free(stack) };
            })
            .map_err(|_| ())?;
        if wait.await.map_err(|_| ())? {
            Ok(Self {
                input,
                output: output_rx,
            })
        } else {
            Err(())
        }
    }
}

pub fn public_ipv4(ip: [u8; 4]) -> bool {
    let [a, b, c, _] = ip;
    !(a == 0
        || a == 10
        || a == 127
        || a >= 224
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && (b == 168 || (b == 0 && (c == 0 || c == 2)) || (b == 88 && c == 99)))
        || (a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
        || (a == 203 && b == 0 && c == 113))
}
/// Gate before libslirp can interpret the frame or open a host socket.
pub fn frame_allowed(frame: &[u8], host_ips: &[[u8; 4]]) -> bool {
    if !(14..=1514).contains(&frame.len()) {
        return false;
    }
    let ether_type = u16::from_be_bytes([frame[12], frame[13]]);
    if ether_type == 0x0806 {
        // only Ethernet/IPv4 ARP
        return frame.len() >= 42
            && frame[14..20] == [0, 1, 8, 0, 6, 4]
            && matches!(frame[21], 1 | 2)
            && frame[20] == 0;
    }
    if ether_type != 0x0800 || frame.len() < 34 {
        return false;
    }
    let p = &frame[14..];
    // Reject IP options (including source-routing) and unsupported protocols.
    if p[0] != 0x45 || !matches!(p[9], 6 | 17) {
        return false;
    }
    let total = u16::from_be_bytes([p[2], p[3]]) as usize;
    if total < 20 || total > p.len() || total > 1500 {
        return false;
    }
    let dest: [u8; 4] = p[16..20].try_into().unwrap();
    let source: [u8; 4] = p[12..16].try_into().unwrap();
    if source != [0, 0, 0, 0] && (source[0..2] != [10, 5] || source == [10, 5, 0, 1]) {
        return false;
    }
    let fragment = u16::from_be_bytes([p[6], p[7]]) & 0x3fff;
    if total >= 28
        && fragment == 0
        && p[9] == 17
        && p[20..24] == [0, 68, 0, 67]
        && (dest == [255, 255, 255, 255] || dest == [10, 5, 255, 255] || dest == [10, 5, 0, 1])
    {
        return true;
    }
    if dest == [10, 5, 0, 1] {
        // virtual DNS only; no fragment/port ambiguity
        return fragment == 0 && total >= 28 && p[22..24] == [0, 53];
    }
    source != [0, 0, 0, 0] && public_ipv4(dest) && !host_ips.contains(&dest)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn packet(ip: [u8; 4], port: u16) -> Vec<u8> {
        let mut p = vec![0; 42];
        p[12..14].copy_from_slice(&[8, 0]);
        p[14] = 0x45;
        p[16..18].copy_from_slice(&28u16.to_be_bytes());
        p[23] = 17;
        p[26..30].copy_from_slice(&[10, 5, 0, 100]);
        p[30..34].copy_from_slice(&ip);
        p[36..38].copy_from_slice(&port.to_be_bytes());
        p
    }
    #[test]
    fn firewall() {
        for ip in [
            [0, 0, 0, 0],
            [10, 0, 0, 1],
            [127, 0, 0, 1],
            [169, 254, 169, 254],
            [172, 16, 0, 1],
            [192, 168, 1, 1],
            [100, 64, 0, 1],
            [198, 18, 0, 1],
            [224, 0, 0, 1],
            [255, 255, 255, 255],
            [10, 5, 0, 100],
        ] {
            assert!(!frame_allowed(&packet(ip, 443), &[]), "{ip:?}");
        }
        assert!(frame_allowed(&packet([1, 1, 1, 1], 443), &[]));
        assert!(!frame_allowed(&packet([1, 1, 1, 1], 443), &[[1, 1, 1, 1]]));
        assert!(frame_allowed(&packet([10, 5, 0, 1], 53), &[]));
        assert!(!frame_allowed(&packet([10, 5, 0, 1], 80), &[]));
        let mut p = packet([10, 5, 0, 1], 53);
        p[20] = 0x20;
        assert!(!frame_allowed(&p, &[]));
        p = packet([1, 1, 1, 1], 80);
        p[14] = 0x46;
        assert!(!frame_allowed(&p, &[]));
    }
}
