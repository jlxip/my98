use crate::*;
use wasm_bindgen::prelude::*;
impl From<Error> for JsValue {
    fn from(e: Error) -> Self {
        JsValue::from_str(&serde_json::to_string(&e).unwrap())
    }
}
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(catch,js_namespace=globalThis,js_name=slopDiskRead)]
    async fn host_read(
        source: &str,
        offset: f64,
        length: usize,
    ) -> std::result::Result<JsValue, JsValue>;
    #[wasm_bindgen(js_namespace=globalThis,js_name=slopDiskCancelled)]
    fn host_cancelled() -> bool;
}
struct BrowserIo;
#[async_trait::async_trait(?Send)]
impl Io for BrowserIo {
    async fn read(&self, source: &str, offset: u64, length: usize) -> Result<Vec<u8>> {
        host_read(source, offset as f64, length)
            .await
            .map(|bytes| js_sys::Uint8Array::new(&bytes).to_vec())
            .map_err(|value| {
                let code = js_sys::Reflect::get(&value, &JsValue::from_str("code"))
                    .ok()
                    .and_then(|v| v.as_string());
                let code = match code.as_deref() {
                    Some("CORRUPTION") => "CORRUPTION",
                    Some("CANCELLED") => "CANCELLED",
                    Some("UNSUPPORTED_FORMAT") => "UNSUPPORTED_FORMAT",
                    _ => "IO_ERROR",
                };
                let message = js_sys::Reflect::get(&value, &JsValue::from_str("message"))
                    .ok()
                    .and_then(|v| v.as_string())
                    .unwrap_or_else(|| "Source read failed".into());
                error(code, message)
            })
    }
    fn cancelled(&self) -> bool {
        host_cancelled()
    }
}
fn number(n: f64) -> Result<u64> {
    if !n.is_finite() || n < 0.0 || n.fract() != 0.0 || n > 9_007_199_254_740_991.0 {
        Err(error("IO_ERROR", "Invalid offset or size"))
    } else {
        Ok(n as u64)
    }
}
#[wasm_bindgen]
pub struct Vault {
    engine: Engine,
}
#[wasm_bindgen]
impl Vault {
    #[wasm_bindgen(constructor)]
    pub fn new(username: &str, password: Vec<u8>, machine: &str) -> Result<Self> {
        Ok(Self {
            engine: Engine::new(username, password, machine)?,
        })
    }
    pub fn identity(&self) -> Result<String> {
        Ok(serde_json::json!({"ipnsName":self.engine.identity.ipns_name().map_err(operation)?,"publicKey":self.engine.identity.public_key().map_err(operation)?}).to_string())
    }
    pub fn describe(&self) -> Result<String> {
        serde_json::to_string(&self.engine.describe()?).map_err(|e| operation(e.to_string()))
    }
    pub async fn open(&mut self, source: String, total: f64) -> Result<()> {
        self.engine.open(&BrowserIo, source, number(total)?).await
    }
    pub fn begin_create(&mut self, source: String, size: f64) -> Result<()> {
        self.engine.begin_create(source, number(size)?)
    }
    pub async fn begin_save(&mut self) -> Result<bool> {
        self.engine.begin_save(&BrowserIo).await
    }
    pub fn accept_unchanged(&mut self) -> Result<()> {
        self.engine.accept_unchanged(&BrowserIo)
    }
    pub fn header(&self) -> Result<Vec<u8>> {
        self.engine.header()
    }
    pub async fn next(&mut self) -> Result<Option<Vec<u8>>> {
        self.engine.next(&BrowserIo).await
    }
    pub fn accept(&mut self, source: String, total: f64) -> Result<()> {
        self.engine.accept(&BrowserIo, source, number(total)?)
    }
    pub fn cancel(&mut self) {
        self.engine.cancel();
    }
    pub async fn read(&mut self, offset: f64, len: u32) -> Result<Vec<u8>> {
        self.engine
            .read(&BrowserIo, number(offset)?, len as usize)
            .await
    }
    pub async fn write(&mut self, offset: f64, bytes: Vec<u8>) -> Result<()> {
        let bytes = Zeroizing::new(bytes);
        self.engine.write(&BrowserIo, number(offset)?, &bytes).await
    }
    pub fn discard(&mut self) -> Result<()> {
        self.engine.discard()
    }
    pub fn clear_cache(&mut self) {
        self.engine.clear_cache()
    }
    pub fn verify_start(&mut self) -> Result<()> {
        self.engine.verify_start()
    }
    pub async fn verify_step(&mut self) -> Result<Option<Vec<u8>>> {
        self.engine.verify_step(&BrowserIo).await
    }
}
