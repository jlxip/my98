import {readFile} from "node:fs/promises";
import {createHash} from "node:crypto";
import {resolve,dirname} from "node:path";

/** These are reviewed source forks, never text patches to installed dependencies. */
export async function torrentPlugins(root) {
    const vendor=resolve(root,"vendor/webrtc-ice");
    const manifest=JSON.parse(await readFile(resolve(vendor,"source.json"),"utf8"));
    const sources=new Map();
    for(const entry of manifest.sources) {
        const packageRoot=resolve(root,"node_modules",entry.package);
        const info=JSON.parse(await readFile(resolve(packageRoot,"package.json"),"utf8"));
        const path=resolve(packageRoot,entry.module),bytes=await readFile(path);
        if(info.version!==entry.version || createHash("sha256").update(bytes).digest("hex")!==entry.upstream_sha256)
            throw new Error(`Review the ICE source fork before upgrading ${entry.package}`);
        sources.set(path,resolve(vendor,entry.local));
    }
    return [{name:"reviewed-ice-sources",setup(builder) {
        builder.onLoad({filter:/\.js$/},async ({path})=>sources.has(path)?{
            contents:await readFile(sources.get(path),"utf8"),resolveDir:dirname(path),loader:"js"
        }:undefined);
        // The application always supplies its own ciphertext store; importing the
        // unused filesystem adapter would touch OPFS during module initialization.
        builder.onResolve({filter:/^(fs-chunk-store|fsa-chunk-store)$/},
            ()=>({path:"required-ciphertext-store",namespace:"my98"}));
        builder.onLoad({filter:/.*/,namespace:"my98"},()=>({contents:
            'export default class RequiredCiphertextStore {constructor(){throw new Error("An explicit ciphertext piece store is required")}}'}));
    }}];
}
