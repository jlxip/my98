import {build} from "esbuild";
import {fileURLToPath} from "node:url";
import {writeFile} from "node:fs/promises";
import {torrentPlugins} from "./torrent-plugins.mjs";
const root=fileURLToPath(new URL("../../../",import.meta.url));
const result=await build({
    stdin:{contents:"import WebTorrent from 'webtorrent'; export default WebTorrent;",resolveDir:root,sourcefile:"webtorrent-entry.js"},
    bundle:true,format:"esm",platform:"browser",target:"es2022",minify:true,
    alias:{path:"path-browserify",events:"events/"},
    inject:[root+"src/disk/scripts/browser-platform.js"],
    define:{global:"globalThis","process.env.NODE_ENV":'"production"'},
    legalComments:"linked",metafile:true,outfile:root+"build/torrent/webtorrent.min.js",
    plugins:await torrentPlugins(root)
});
if(Object.keys(result.metafile.inputs).some(path=>/node_modules\/fsa-chunk-store\//.test(path)))
    throw Error("The torrent browser build unexpectedly includes the unused FSA store");
await writeFile(root+"build/torrent/browser-build.json",JSON.stringify(result.metafile,null,2)+"\n");
