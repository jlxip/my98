mod network;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    net::Ipv4Addr,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream, UnixListener},
    sync::{watch, Semaphore},
    time::{timeout, Duration},
};
use tokio_tungstenite::{
    accept_hdr_async_with_config,
    tungstenite::{
        handshake::server::{ErrorResponse, Request, Response},
        protocol::{frame::coding::CloseCode, CloseFrame, Message, WebSocketConfig},
    },
};

type Error = Box<dyn std::error::Error + Send + Sync>;
const PROTOCOL: &str = "my98-relay.v1";
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    #[serde(default)]
    enabled: bool,
    public_url: String,
    origins: HashSet<String>,
    allow_file: PathBuf,
    admin_socket: PathBuf,
    #[serde(default)]
    host_ips: Vec<Ipv4Addr>,
}
#[derive(Default, Serialize)]
struct Counters {
    accepted: AtomicU64,
    rejected: AtomicU64,
    frames: AtomicU64,
    blocked: AtomicU64,
}
struct State {
    config: Config,
    allow: Mutex<HashSet<String>>,
    active: Mutex<HashMap<u64, (String, watch::Sender<bool>)>>,
    sessions: Arc<Semaphore>,
    handshakes: Arc<Semaphore>,
    next: AtomicU64,
    counters: Counters,
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}
fn key(value: &str) -> Result<Vec<u8>, Error> {
    if value.len() != 64
        || value
            .bytes()
            .any(|v| !v.is_ascii_digit() && !(b'a'..=b'f').contains(&v))
    {
        return Err("Invalid public key".into());
    }
    Ok(hex::decode(value)?)
}
fn save_allow(state: &State, keys: &HashSet<String>) -> Result<(), Error> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let target = &state.config.allow_file;
    let temp = target.with_extension("tmp");
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&temp)?;
    let mut sorted: Vec<_> = keys.iter().collect();
    sorted.sort();
    file.write_all(&serde_json::to_vec(&sorted)?)?;
    file.sync_all()?;
    fs::rename(temp, target)?;
    if let Some(parent) = target.parent() {
        fs::File::open(parent)?.sync_all()?;
    }
    Ok(())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Admin {
    command: String,
    #[serde(default)]
    public_key: String,
}
async fn admin(stream: tokio::net::UnixStream, state: Arc<State>) -> Result<(), Error> {
    let (read, mut write) = stream.into_split();
    let mut reader = BufReader::new(read.take(4097));
    let mut line = String::new();
    timeout(Duration::from_secs(3), reader.read_line(&mut line)).await??;
    if line.len() > 4096 {
        return Err("Admin message too large".into());
    }
    let a: Admin = serde_json::from_str(&line)?;
    let result = match a.command.as_str() {
        "status" => {
            serde_json::json!({"ok":true,"authorized_keys":state.allow.lock().unwrap().len(),"active_sessions":state.active.lock().unwrap().len(),"pending_handshakes":32-state.handshakes.available_permits(),"counters":state.counters})
        }
        "allow" | "revoke" => {
            key(&a.public_key)?;
            let mut allow = state.allow.lock().unwrap();
            let mut next = allow.clone();
            if a.command == "allow" {
                next.insert(a.public_key.clone());
            } else {
                next.remove(&a.public_key);
            }
            save_allow(&state, &next)?;
            *allow = next;
            if a.command == "revoke" {
                for (public, cancel) in state.active.lock().unwrap().values() {
                    if *public == a.public_key {
                        let _ = cancel.send(true);
                    }
                }
            }
            serde_json::json!({"ok":true})
        }
        _ => return Err("Unknown admin command".into()),
    };
    timeout(
        Duration::from_secs(3),
        write.write_all(format!("{result}\n").as_bytes()),
    )
    .await??;
    Ok(())
}
struct Registration {
    state: Arc<State>,
    id: u64,
}
impl Drop for Registration {
    fn drop(&mut self) {
        self.state.active.lock().unwrap().remove(&self.id);
        eprintln!("event=session_closed");
    }
}
async fn send(
    ws: &mut tokio_tungstenite::WebSocketStream<TcpStream>,
    value: serde_json::Value,
) -> Result<(), Error> {
    timeout(
        Duration::from_secs(5),
        ws.send(Message::Text(value.to_string().into())),
    )
    .await??;
    Ok(())
}
async fn text(
    ws: &mut tokio_tungstenite::WebSocketStream<TcpStream>,
) -> Result<serde_json::Value, Error> {
    match ws.next().await {
        Some(Ok(Message::Text(s))) => Ok(serde_json::from_str(&s)?),
        _ => Err("Expected authentication message".into()),
    }
}
async fn connection(
    mut stream: TcpStream,
    state: Arc<State>,
    pending: tokio::sync::OwnedSemaphorePermit,
) -> Result<(), Error> {
    // Anonymous, bounded capability announcement. No admin data or network stack.
    let mut header = [0; 4096];
    let size = timeout(Duration::from_secs(3), async {
        loop {
            stream.readable().await?;
            let size = stream.peek(&mut header).await?;
            if size == 0
                || size == header.len()
                || header[..size].windows(4).any(|v| v == b"\r\n\r\n")
            {
                return Ok::<_, std::io::Error>(size);
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await??;
    if header[..size].starts_with(b"GET /.well-known/my98-relay.json HTTP/1.1\r\n") {
        if size == header.len() || !header[..size].ends_with(b"\r\n\r\n") {
            return Err("Invalid capability request".into());
        }
        // Consume the peeked request before closing; unread TCP data causes a reset.
        timeout(
            Duration::from_secs(3),
            stream.read_exact(&mut header[..size]),
        )
        .await??;
        let body = serde_json::json!({"version":1,"relay":{"url":state.config.public_url,"protocol":PROTOCOL,"authorization":"ed25519-allowlist"}}).to_string();
        let response = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{}",body.len(),body);
        timeout(
            Duration::from_secs(3),
            stream.write_all(response.as_bytes()),
        )
        .await??;
        return Ok(());
    }
    let mut origin = String::new();
    let cfg = WebSocketConfig::default()
        .max_message_size(Some(4096))
        .max_frame_size(Some(4096))
        .write_buffer_size(0)
        .max_write_buffer_size(65536);
    let callback = |req: &Request, mut response: Response| -> Result<Response, ErrorResponse> {
        let requested = req
            .headers()
            .get("sec-websocket-protocol")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        origin = req
            .headers()
            .get("origin")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_owned();
        if req.uri().path() != "/my98-relay/v1"
            || !state.config.origins.contains(&origin)
            || !requested.split(',').any(|v| v.trim() == PROTOCOL)
        {
            let mut error = ErrorResponse::new(Some("Relay request rejected".into()));
            *error.status_mut() = tokio_tungstenite::tungstenite::http::StatusCode::FORBIDDEN;
            return Err(error);
        }
        response
            .headers_mut()
            .insert("sec-websocket-protocol", PROTOCOL.parse().unwrap());
        Ok(response)
    };
    let mut ws = timeout(
        Duration::from_secs(5),
        accept_hdr_async_with_config(stream, callback, Some(cfg)),
    )
    .await??;
    let authentication = async {
        let hello = text(&mut ws).await?;
        if hello["type"] != "hello" {
            return Err("Expected hello".into());
        }
        let public = hello["publicKey"]
            .as_str()
            .ok_or("Missing public key")?
            .to_owned();
        let bytes = key(&public)?;
        if !state.allow.lock().unwrap().contains(&public) {
            return Err("Not authorized".into());
        }
        let mut nonce = [0; 32];
        getrandom::getrandom(&mut nonce).map_err(|_| "Randomness failed")?;
        let expires = now() + 10;
        send(&mut ws,serde_json::json!({"type":"challenge","url":state.config.public_url,"origin":origin,"nonce":hex::encode(nonce),"expires":expires})).await?;
        let response = timeout(Duration::from_secs(10), text(&mut ws)).await??;
        if response["type"] != "authenticate" || now() >= expires {
            return Err("Challenge expired or invalid".into());
        }
        let signature = hex::decode(response["signature"].as_str().ok_or("Missing signature")?)?;
        let message = slop86_crypto::relay_challenge(
            &bytes,
            &state.config.public_url,
            &origin,
            &nonce,
            expires,
        )?;
        if !slop86_crypto::verify(&bytes, &message, &signature) {
            return Err("Signature rejected".into());
        }
        Ok::<_, Error>(public)
    };
    let public = match timeout(Duration::from_secs(12), authentication).await {
        Ok(Ok(key)) => key,
        _ => {
            state.counters.rejected.fetch_add(1, Ordering::Relaxed);
            let _ = timeout(
                Duration::from_secs(2),
                ws.close(Some(CloseFrame {
                    code: CloseCode::Policy,
                    reason: "Authorization rejected".into(),
                })),
            )
            .await;
            eprintln!("event=authentication_rejected");
            return Ok(());
        }
    };
    let _session = match state.sessions.clone().try_acquire_owned() {
        Ok(permit) => permit,
        Err(_) => {
            ws.close(Some(CloseFrame {
                code: CloseCode::Again,
                reason: "Relay busy".into(),
            }))
            .await?;
            return Ok(());
        }
    };
    let (cancel, mut cancelled) = watch::channel(false);
    let id = state.next.fetch_add(1, Ordering::Relaxed);
    {
        let allow = state.allow.lock().unwrap();
        if !allow.contains(&public) {
            return Err("Revoked during authentication".into());
        }
        state
            .active
            .lock()
            .unwrap()
            .insert(id, (public.clone(), cancel));
    }
    let _registration = Registration {
        state: state.clone(),
        id,
    };
    // Network allocation happens only after authorization and registration.
    let mut network = network::Network::new()
        .await
        .map_err(|_| "Network initialization failed")?;
    if *cancelled.borrow() {
        return Ok(());
    }
    send(&mut ws, serde_json::json!({"type":"ready"})).await?;
    drop(pending);
    state.counters.accepted.fetch_add(1, Ordering::Relaxed);
    eprintln!("event=session_ready");
    let host_ips: Vec<[u8; 4]> = state.config.host_ips.iter().map(|v| v.octets()).collect();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(20));
    let mut last_seen = tokio::time::Instant::now();
    loop {
        tokio::select! { biased;
            _=cancelled.changed()=>{
                let _=timeout(Duration::from_secs(2),ws.close(Some(CloseFrame{code:CloseCode::Policy,reason:"Authorization revoked".into()}))).await;break;
            }
            incoming=ws.next()=>match incoming {
                Some(Ok(Message::Binary(bytes)))=>{
                    last_seen=tokio::time::Instant::now();
                    if !state.allow.lock().unwrap().contains(&public) { break; }
                    if network::frame_allowed(&bytes,&host_ips) {
                        state.counters.frames.fetch_add(1,Ordering::Relaxed);
                        let _=network.input.try_send(bytes.to_vec());
                    } else { state.counters.blocked.fetch_add(1,Ordering::Relaxed); }
                }
                Some(Ok(Message::Pong(_)))=>last_seen=tokio::time::Instant::now(),
                Some(Ok(Message::Ping(_)))=>{},
                _=>break,
            },
            frame=network.output.recv()=>{
                let Some(frame)=frame else {break};
                if !state.allow.lock().unwrap().contains(&public) {break;}
                timeout(Duration::from_secs(5),ws.send(Message::Binary(frame.into()))).await??;
            }
            _=heartbeat.tick()=>{
                if last_seen.elapsed()>Duration::from_secs(60) {break;}
                timeout(Duration::from_secs(5),ws.send(Message::Ping(Vec::new().into()))).await??;
            }
        }
    }
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    use std::os::unix::fs::PermissionsExt;
    let path = std::env::args()
        .nth(1)
        .ok_or("Usage: my98-relay CONFIG.json")?;
    std::env::remove_var("SLIRP_DEBUG");
    let config: Config = serde_json::from_slice(&fs::read(path)?)?;
    if !config.enabled {
        eprintln!("event=service_disabled");
        return Ok(());
    }
    if !config.public_url.starts_with("wss://")
        || !config.public_url.ends_with("/my98-relay/v1")
        || config.origins.is_empty()
    {
        return Err("Invalid config".into());
    }
    let allow: HashSet<String> = serde_json::from_slice(&fs::read(&config.allow_file)?)?;
    for public in &allow {
        key(public)?;
    }
    // Refuse an existing socket instead of unlinking another live daemon.
    let listener = TcpListener::bind("127.0.0.1:8090").await?;
    if config.admin_socket.exists() {
        fs::remove_file(&config.admin_socket)?;
    }
    let admin_listener = UnixListener::bind(&config.admin_socket)?;
    fs::set_permissions(&config.admin_socket, fs::Permissions::from_mode(0o600))?;
    let state = Arc::new(State {
        config,
        allow: Mutex::new(allow),
        active: Mutex::new(HashMap::new()),
        sessions: Arc::new(Semaphore::new(4)),
        handshakes: Arc::new(Semaphore::new(32)),
        next: AtomicU64::new(1),
        counters: Counters::default(),
    });
    let admin_state = state.clone();
    tokio::spawn(async move {
        let permits = Arc::new(Semaphore::new(8));
        while let Ok((stream, _)) = admin_listener.accept().await {
            if let Ok(permit) = permits.clone().try_acquire_owned() {
                let state = admin_state.clone();
                tokio::spawn(async move {
                    let _permit = permit;
                    if admin(stream, state).await.is_err() {
                        eprintln!("event=admin_error");
                    }
                });
            }
        }
    });
    eprintln!("event=service_ready");
    loop {
        tokio::select! {
            _=tokio::signal::ctrl_c()=>break,
            accepted=listener.accept()=>{
                let (stream,_)=accepted?;
                if let Ok(permit)=state.handshakes.clone().try_acquire_owned() {
                    let state=state.clone();
                    tokio::spawn(async move {if connection(stream,state,permit).await.is_err(){eprintln!("event=connection_error");}});
                }
            }
        }
    }
    fs::remove_file(&state.config.admin_socket)?;
    Ok(())
}

#[cfg(test)]
mod tests;
