import {build as esbuild} from 'esbuild';
import {readFile} from 'node:fs/promises';
import {pathToFileURL,fileURLToPath} from 'node:url';

// ipfs-unixfs-exporter 16.2.2 forwards child failures into its read queue, but
// leaves PQueue.add's returned rejection unobserved. Cancelling a deep traversal
// thus also emits an unhandled rejection. Observe that duplicate rejection;
// the original error still reaches the caller through queue.end(error).
export function build(options) {
    return esbuild({...options,plugins:[...(options.plugins || []),{
        name:'unixfs-child-rejection',
        setup(builder) {
            builder.onLoad({filter:/ipfs-unixfs-exporter\/dist\/src\/exporters\/unixfs-v1\/content\/file.js$/},async({path})=>{
                const source=await readFile(path,'utf8');
                const before='await walkDAG(blockstore, child, queue, blockStart, start, end, options);\n            });';
                if(source.split(before).length!==2)throw Error('Review the UnixFS cancellation workaround for this dependency version');
                return {contents:source.replace(before,'await walkDAG(blockstore, child, queue, blockStart, start, end, options);\n            }).catch(() => {});'),loader:'js'};
            });
        },
    }]});
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
    await build({entryPoints:[fileURLToPath(new URL('../web/worker.js',import.meta.url))],bundle:true,format:'esm',platform:'browser',target:'es2022',external:['../pkg/slop86_disk.js'],legalComments:'inline',outfile:fileURLToPath(new URL('../../../build/disk/web/worker.js',import.meta.url))});
}
