"""Check the source server's public URL contract after make site."""
import hashlib
from http.client import HTTPConnection
import importlib.util
from pathlib import Path
import threading
import unittest

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("my98_server", ROOT / "scripts/serve.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class QuietHandler(module.Handler):
    def log_message(self, *_args):
        pass


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = module.ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def request(self, path, method="GET", headers=None):
        connection = HTTPConnection("127.0.0.1", self.server.server_port, timeout=10)
        try:
            connection.request(method, path, headers=headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_public_assets_match_package(self):
        for url in module.ASSETS:
            with self.subTest(url=url):
                status, headers, body = self.request("/" + url)
                self.assertEqual(status, 200)
                self.assertEqual(hashlib.sha256(body).digest(), hashlib.sha256((ROOT / "build/site" / url).read_bytes()).digest())
                self.assertEqual(headers["Cross-Origin-Opener-Policy"], "same-origin")
                self.assertEqual(headers["Cross-Origin-Embedder-Policy"], "require-corp")
                self.assertEqual(headers["Cache-Control"], "no-store")
                self.assertEqual(int(headers["Content-Length"]), len(body))
        self.assertEqual(self.request("/")[2], (ROOT / "src/browser/index.html").read_bytes())
        self.assertEqual(self.request("/coi-serviceworker.js?revision=1")[1]["Content-Type"], "text/javascript")
        self.assertEqual(self.request("/build/v86.wasm")[1]["Content-Type"], "application/wasm")

    def test_head_and_cache_bypass(self):
        status, headers, body = self.request("/", "HEAD", {"If-Modified-Since": "Wed, 01 Jan 2099 00:00:00 GMT", "If-None-Match": "*"})
        self.assertEqual(status, 200)
        self.assertEqual(body, b"")
        self.assertEqual(int(headers["Content-Length"]), (ROOT / "src/browser/index.html").stat().st_size)

    def test_byte_ranges(self):
        original = (ROOT / module.ASSETS["bios/seabios.bin"]).read_bytes()
        for value, start, end in [("bytes=0-31", 0, 31), ("bytes=-32", len(original)-32, len(original)-1), (f"bytes={len(original)-16}-", len(original)-16, len(original)-1), (f"bytes=16-{len(original)+10}", 16, len(original)-1)]:
            with self.subTest(range=value):
                status, headers, body = self.request("/bios/seabios.bin", headers={"Range": value})
                self.assertEqual(status, 206)
                self.assertEqual(body, original[start:end+1])
                self.assertEqual(headers["Content-Range"], f"bytes {start}-{end}/{len(original)}")
        for value in ["bytes=3-2", f"bytes={len(original)}-", "bytes=-0", "bytes=-", "bytes=0-1,3-4", "invalid"]:
            with self.subTest(range=value):
                status, headers, body = self.request("/bios/seabios.bin", headers={"Range": value})
                self.assertEqual(status, 416)
                self.assertEqual(headers["Content-Range"], f"bytes */{len(original)}")
                self.assertEqual(body, b"")

    def test_only_public_urls(self):
        for url in ["/advanced.html", "/.git/config", "/src/crypto/Cargo.toml", "/vendor/slop86/.git", "/build/", "/src/browser/../crypto/Cargo.toml", "/src/browser/%2e%2e%2fcrypto/Cargo.toml", "/%2e%2e/LICENSE", "/unknown"]:
            with self.subTest(url=url):
                self.assertEqual(self.request(url)[0], 404)


if __name__ == "__main__":
    unittest.main()
