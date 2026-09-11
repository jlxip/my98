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
    fn host_read(source: &str, offset: f64, length: usize)
        -> std::result::Result<Vec<u8>, JsValue>;
    #[wasm_bindgen(js_namespace=globalThis,js_name=slopDiskCancelled)]
    fn host_cancelled() -> bool;
}
struct BrowserIo;
impl Io for BrowserIo {
    fn read(&self, source: &str, offset: u64, length: usize) -> Result<Vec<u8>> {
        host_read(source, offset as f64, length)
            .map_err(|_| error("IO_ERROR", "Source read failed"))
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
    pub fn open(&mut self, source: String, total: f64) -> Result<()> {
        self.engine.open(&BrowserIo, source, number(total)?)
    }
    pub fn begin_create(&mut self, source: String, size: f64) -> Result<()> {
        self.engine.begin_create(source, number(size)?)
    }
    pub fn begin_save(&mut self) -> Result<bool> {
        self.engine.begin_save(&BrowserIo)
    }
    pub fn accept_unchanged(&mut self) -> Result<()> {
        self.engine.accept_unchanged(&BrowserIo)
    }
    pub fn header(&self) -> Result<Vec<u8>> {
        self.engine.header()
    }
    pub fn next(&mut self) -> Result<Option<Vec<u8>>> {
        self.engine.next(&BrowserIo)
    }
    pub fn accept(&mut self, source: String, total: f64) -> Result<()> {
        self.engine.accept(&BrowserIo, source, number(total)?)
    }
    pub fn cancel(&mut self) {
        self.engine.cancel();
    }
    pub fn read(&mut self, offset: f64, len: u32) -> Result<Vec<u8>> {
        self.engine.read(&BrowserIo, number(offset)?, len as usize)
    }
    pub fn write(&mut self, offset: f64, bytes: Vec<u8>) -> Result<()> {
        let bytes = Zeroizing::new(bytes);
        self.engine.write(&BrowserIo, number(offset)?, &bytes)
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
    pub fn verify_step(&mut self) -> Result<Option<Vec<u8>>> {
        self.engine.verify_step(&BrowserIo)
    }
}
