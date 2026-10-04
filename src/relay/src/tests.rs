use super::*;
use slop86_crypto::{derive_identity, Identity};
use tokio_tungstenite::{connect_async, tungstenite::client::IntoClientRequest};
type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<TcpStream>>;
const ORIGIN: &str = "https://my98.lol";
const URL: &str = "wss://relay.example/my98-relay/v1";
#[test]
fn missing_activation_is_disabled() {
    let value = serde_json::json!({"public_url":URL,"origins":[ORIGIN],"allow_file":"unused","admin_socket":"unused"});
    let config: Config = serde_json::from_value(value.clone()).unwrap();
    assert!(!config.enabled);
    let mut wrong = value;
    wrong["enabled"] = serde_json::json!("true");
    assert!(serde_json::from_value::<Config>(wrong).is_err());
}
#[tokio::test]
async fn anonymous_announcement_allocates_no_guest_and_exposes_no_admin_state() {
    let owner = random_owner();
    let (state, address, task) = fixture(&owner).await;
    let mut stream = TcpStream::connect(
        address
            .strip_prefix("ws://")
            .unwrap()
            .split('/')
            .next()
            .unwrap(),
    )
    .await
    .unwrap();
    stream
        .write_all(b"GET /.well-known/my98-relay.json HTTP/1.1\r\nHost: relay.example\r\n\r\n")
        .await
        .unwrap();
    let mut response = String::new();
    timeout(Duration::from_secs(3), stream.read_to_string(&mut response))
        .await
        .unwrap()
        .unwrap();
    let body: serde_json::Value =
        serde_json::from_str(response.split("\r\n\r\n").nth(1).unwrap()).unwrap();
    assert_eq!(
        body,
        serde_json::json!({"version":1,"relay":{"url":URL,"protocol":PROTOCOL,"authorization":"ed25519-allowlist"}})
    );
    assert_eq!(state.counters.accepted.load(Ordering::Relaxed), 0);
    assert_eq!(state.counters.frames.load(Ordering::Relaxed), 0);
    assert!(state.active.lock().unwrap().is_empty());
    task.abort();
    fs::remove_dir_all(state.config.allow_file.parent().unwrap()).unwrap();
}
fn random_owner() -> Identity {
    let mut password = [0; 32];
    getrandom::getrandom(&mut password).unwrap();
    derive_identity("disposable relay test", password.to_vec(), "test").unwrap()
}
async fn fixture(owner: &Identity) -> (Arc<State>, String, tokio::task::JoinHandle<()>) {
    let directory = std::env::temp_dir().join(format!(
        "my98-relay-test-{}-{}",
        std::process::id(),
        hex::encode(owner.relay_public_key().unwrap())
    ));
    fs::create_dir_all(&directory).unwrap();
    let state = Arc::new(State {
        config: Config {
            enabled: true,
            public_url: URL.into(),
            origins: HashSet::from([ORIGIN.into()]),
            allow_file: directory.join("allow.json"),
            admin_socket: directory.join("admin.sock"),
            host_ips: vec![],
        },
        allow: Mutex::new(HashSet::from([hex::encode(
            owner.relay_public_key().unwrap(),
        )])),
        active: Mutex::new(HashMap::new()),
        sessions: Arc::new(Semaphore::new(4)),
        handshakes: Arc::new(Semaphore::new(32)),
        next: AtomicU64::new(0),
        counters: Counters::default(),
    });
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("ws://{}/my98-relay/v1", listener.local_addr().unwrap());
    let shared = state.clone();
    let task = tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            if let Ok(permit) = shared.handshakes.clone().try_acquire_owned() {
                let state = shared.clone();
                tokio::spawn(async move {
                    let _ = connection(stream, state, permit).await;
                });
            }
        }
    });
    (state, address, task)
}
async fn open(address: &str, origin: &str) -> Result<Ws, Error> {
    let mut req = address.into_client_request()?;
    req.headers_mut().insert("origin", origin.parse()?);
    req.headers_mut()
        .insert("sec-websocket-protocol", PROTOCOL.parse()?);
    Ok(connect_async(req).await?.0)
}
async fn json(ws: &mut Ws) -> serde_json::Value {
    loop {
        match timeout(Duration::from_secs(3), ws.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
        {
            Message::Text(t) => return serde_json::from_str(&t).unwrap(),
            Message::Ping(p) => ws.send(Message::Pong(p)).await.unwrap(),
            other => panic!("Unexpected {other:?}"),
        }
    }
}
async fn hello(ws: &mut Ws, owner: &Identity) -> serde_json::Value {
    ws.send(Message::Text(serde_json::json!({"type":"hello","publicKey":hex::encode(owner.relay_public_key().unwrap())}).to_string().into())).await.unwrap();
    json(ws).await
}
fn signature(owner: &Identity, c: &serde_json::Value) -> String {
    hex::encode(
        owner
            .sign_relay_challenge(
                c["url"].as_str().unwrap(),
                c["origin"].as_str().unwrap(),
                &hex::decode(c["nonce"].as_str().unwrap()).unwrap(),
                c["expires"].as_u64().unwrap(),
            )
            .unwrap(),
    )
}
async fn authenticate(ws: &mut Ws, signature: &str) {
    ws.send(Message::Text(
        serde_json::json!({"type":"authenticate","signature":signature})
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
}
async fn rejected(ws: &mut Ws) {
    loop {
        match timeout(Duration::from_secs(3), ws.next()).await.unwrap() {
            Some(Ok(Message::Close(Some(c)))) => {
                assert_eq!(c.code, CloseCode::Policy);
                break;
            }
            Some(Ok(Message::Ping(p))) => ws.send(Message::Pong(p)).await.unwrap(),
            other => panic!("Expected policy close, got {other:?}"),
        }
    }
}
#[tokio::test]
async fn authentication_replay_isolation_and_revoke() {
    let owner = random_owner();
    let (state, address, task) = fixture(&owner).await;
    assert!(open(&address, "https://untrusted.example").await.is_err());
    let mut unknown = open(&address, ORIGIN).await.unwrap();
    let another = random_owner();
    unknown.send(Message::Text(serde_json::json!({"type":"hello","publicKey":hex::encode(another.relay_public_key().unwrap())}).to_string().into())).await.unwrap();
    rejected(&mut unknown).await;
    let mut early = open(&address, ORIGIN).await.unwrap();
    early
        .send(Message::Binary(vec![0; 42].into()))
        .await
        .unwrap();
    rejected(&mut early).await;
    assert_eq!(state.counters.accepted.load(Ordering::Relaxed), 0);
    assert_eq!(state.active.lock().unwrap().len(), 0);
    let mut wrong = open(&address, ORIGIN).await.unwrap();
    hello(&mut wrong, &owner).await;
    authenticate(&mut wrong, &"00".repeat(64)).await;
    rejected(&mut wrong).await;
    let mut first = open(&address, ORIGIN).await.unwrap();
    let c = hello(&mut first, &owner).await;
    let sig = signature(&owner, &c);
    authenticate(&mut first, &sig).await;
    assert_eq!(json(&mut first).await["type"], "ready");
    let mut second = open(&address, ORIGIN).await.unwrap();
    let next = hello(&mut second, &owner).await;
    assert_ne!(next["nonce"], c["nonce"]);
    authenticate(&mut second, &sig).await;
    rejected(&mut second).await;
    // The same authorized key may open isolated stacks; saved MAC/IP do not identify a session.
    let mut second = open(&address, ORIGIN).await.unwrap();
    let c = hello(&mut second, &owner).await;
    authenticate(&mut second, &signature(&owner, &c)).await;
    assert_eq!(json(&mut second).await["type"], "ready");
    assert_eq!(state.active.lock().unwrap().len(), 2);
    // Replay on an already-authenticated socket is rejected and tears down only that stack.
    authenticate(&mut second, &signature(&owner, &c)).await;
    let _ = timeout(Duration::from_secs(3), second.next()).await;
    let (client, server) = tokio::net::UnixStream::pair().unwrap();
    let admin_state = state.clone();
    tokio::spawn(async move {
        admin(server, admin_state).await.unwrap();
    });
    let (read, mut write) = client.into_split();
    write.write_all(format!("{}\n",serde_json::json!({"command":"revoke","public_key":hex::encode(owner.relay_public_key().unwrap())})).as_bytes()).await.unwrap();
    let mut result = String::new();
    BufReader::new(read).read_line(&mut result).await.unwrap();
    assert!(result.contains("true"));
    rejected(&mut first).await;
    assert!(!state
        .allow
        .lock()
        .unwrap()
        .contains(&hex::encode(owner.relay_public_key().unwrap())));
    task.abort();
    fs::remove_dir_all(state.config.allow_file.parent().unwrap()).unwrap();
}
#[tokio::test]
async fn expired_challenge_and_pending_limit() {
    let owner = random_owner();
    let (state, address, task) = fixture(&owner).await;
    let mut ws = open(&address, ORIGIN).await.unwrap();
    let c = hello(&mut ws, &owner).await;
    tokio::time::sleep(Duration::from_secs(10)).await;
    let _ = ws
        .send(Message::Text(
            serde_json::json!({"type":"authenticate","signature":signature(&owner,&c)})
                .to_string()
                .into(),
        ))
        .await;
    rejected(&mut ws).await;
    let permits = state
        .handshakes
        .clone()
        .acquire_many_owned(32)
        .await
        .unwrap();
    assert!(open(&address, ORIGIN).await.is_err());
    drop(permits);
    task.abort();
    fs::remove_dir_all(state.config.allow_file.parent().unwrap()).unwrap();
}

#[tokio::test]
async fn four_session_limit_and_origin_binding() {
    let owner = random_owner();
    let (state, address, task) = fixture(&owner).await;
    let mut sockets = Vec::new();
    for _ in 0..4 {
        let mut ws = open(&address, ORIGIN).await.unwrap();
        let c = hello(&mut ws, &owner).await;
        authenticate(&mut ws, &signature(&owner, &c)).await;
        assert_eq!(json(&mut ws).await["type"], "ready");
        sockets.push(ws);
    }
    assert_eq!(state.active.lock().unwrap().len(), 4);
    let mut fifth = open(&address, ORIGIN).await.unwrap();
    let c = hello(&mut fifth, &owner).await;
    authenticate(&mut fifth, &signature(&owner, &c)).await;
    match timeout(Duration::from_secs(3), fifth.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap()
    {
        Message::Close(Some(c)) => assert_eq!(c.code, CloseCode::Again),
        other => panic!("{other:?}"),
    }
    // Same allowed Origin, but a signature made for another Origin/service is invalid.
    let mut cross = open(&address, ORIGIN).await.unwrap();
    let c = hello(&mut cross, &owner).await;
    let wrong = hex::encode(
        owner
            .sign_relay_challenge(
                URL,
                "https://other.example",
                &hex::decode(c["nonce"].as_str().unwrap()).unwrap(),
                c["expires"].as_u64().unwrap(),
            )
            .unwrap(),
    );
    authenticate(&mut cross, &wrong).await;
    rejected(&mut cross).await;
    drop(sockets);
    task.abort();
    fs::remove_dir_all(state.config.allow_file.parent().unwrap()).unwrap();
}
