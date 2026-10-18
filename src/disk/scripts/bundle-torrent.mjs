import {build} from "esbuild";
import {fileURLToPath} from "node:url";
import {writeFile} from "node:fs/promises";
const root=fileURLToPath(new URL("../../../",import.meta.url));
const result=await build({
    stdin:{contents:"export {default} from 'webtorrent';",resolveDir:root,sourcefile:"webtorrent-entry.js"},
    bundle:true,format:"esm",platform:"browser",target:"es2022",minify:true,
    alias:{path:"path-browserify",events:"events/"},
    inject:[root+"src/disk/scripts/browser-platform.js"],
    define:{global:"globalThis","process.env.NODE_ENV":'"production"'},
    legalComments:"linked",metafile:true,outfile:root+"build/torrent/webtorrent.min.js",
    plugins:[{name:"explicit-ciphertext-store",setup(builder) {
        // Upstream's default FSA store touches OPFS on module import, even when
        // opts.store overrides it. Our client always supplies its IndexedDB store.
        // Exclude the unused adapter without changing peer or transfer algorithms.
        builder.onResolve({filter:/^(fs-chunk-store|fsa-chunk-store)$/},
            ()=>({path:"required-ciphertext-store",namespace:"my98"}));
        builder.onLoad({filter:/.*/,namespace:"my98"},()=>({contents:
            'export default class RequiredCiphertextStore {constructor(){throw new Error("An explicit ciphertext piece store is required")}}'}));
    }}]
});
if(Object.keys(result.metafile.inputs).some(path=>/node_modules\/fsa-chunk-store\//.test(path)))
    throw Error("The torrent browser build unexpectedly includes the unused FSA store");
await writeFile(root+"build/torrent/browser-build.json",JSON.stringify(result.metafile,null,2)+"\n");
