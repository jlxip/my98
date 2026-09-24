import test from 'node:test';
import {build} from './bundle.mjs';
await build({entryPoints:['src/disk/scripts/network-cases.mjs'],bundle:true,format:'esm',platform:'node',target:'node24',outfile:'build/disk/network-cases.mjs'});
const {runNetworkCases}=await import('../../../build/disk/network-cases.mjs');
test('adaptive network scheduler, rescue and bounded early state transfer',async()=>{
 const {checks}=await runNetworkCases();for(const check of checks)console.log(check);
});
