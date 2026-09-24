import test from 'node:test';
import {build} from './bundle.mjs';
await build({entryPoints:['src/disk/scripts/car-cases.mjs'],bundle:true,format:'esm',platform:'node',target:'node24',outfile:'build/disk/car-cases.mjs'});
const {runCarCases}=await import('../../../build/disk/car-cases.mjs');
test('CAR proofs, parallel ranges, fallback, admission and cancellation',async()=>{
 const result=await runCarCases();for(const c of result.checks)console.log(JSON.stringify(c));
});
