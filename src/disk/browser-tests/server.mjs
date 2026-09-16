import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
const assets = JSON.parse(await readFile(new URL("../../../scripts/site-assets.json", import.meta.url), "utf8"));
export function makeServer(repo, requests = []) {
return createServer(async(req,res)=>{
    try {
        requests.push(req.url);
        const url=new URL(req.url,"http://localhost");
        if(req.method!=="GET") {res.writeHead(405).end();return;}
        const pathname = decodeURIComponent(url.pathname);
        if(pathname.split("/").some(part => part === "." || part === "..")) {res.writeHead(404).end();return;}
        if(![/^\/build\/disk\//,/^\/build\/(libv86.mjs|v86.wasm)$/,/^\/bios\//,/^\/src\/browser\//,/^\/slop86\/src\//,/^\/disk\/browser-tests\//,/^\/index.html$/,/^\/win98.css$/].some(re=>re.test(pathname))) {res.writeHead(404).end();return;}
        const relative = pathname.slice(1);
        const source = assets[relative] || (relative.startsWith("disk/browser-tests/") ? "src/" + relative : relative);
        const file = path.resolve(repo, source);
        if(!file.startsWith(path.resolve(repo) + path.sep)) {res.writeHead(404).end();return;}
        const info=await stat(file);let start=0,end=info.size-1;
        if(req.headers.range) { const match=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range);if(!match)throw Error("range");start=+match[1];end=match[2]?Math.min(+match[2],end):end; }
        const type=file.endsWith(".wasm")?"application/wasm":file.endsWith(".html")?"text/html":file.endsWith(".css")?"text/css":/\.(m?js)$/.test(file)?"text/javascript":"application/octet-stream";
        res.writeHead(req.headers.range?206:200,{"Content-Type":type,"Content-Length":end-start+1,"Cache-Control":"no-store",...(url.searchParams.has("no-isolation")?{}:{"Cross-Origin-Opener-Policy":"same-origin","Cross-Origin-Embedder-Policy":"require-corp"}),...(req.headers.range?{"Content-Range":`bytes ${start}-${end}/${info.size}`}:{})});
        createReadStream(file,{start,end}).pipe(res);
    } catch {res.writeHead(404).end();}
});
}
