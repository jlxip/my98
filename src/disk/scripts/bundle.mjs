import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
await build({entryPoints:[fileURLToPath(new URL('../web/worker.js',import.meta.url))],bundle:true,format:'esm',platform:'browser',target:'es2022',external:['../pkg/slop86_disk.js'],legalComments:'inline',outfile:fileURLToPath(new URL('../../../build/disk/web/worker.js',import.meta.url))});
await build({entryPoints:[fileURLToPath(new URL('../web/client.js',import.meta.url))],bundle:true,format:'esm',platform:'browser',target:'es2022',legalComments:'inline',outfile:fileURLToPath(new URL('../../../build/disk/web/client.js',import.meta.url))});
