import assert from 'node:assert/strict';
import {writeFile,mkdir} from 'node:fs/promises';
import {chromium,webkit} from 'playwright';
import {build} from '../../src/disk/scripts/bundle.mjs';
import {makeServer} from '../../src/disk/browser-tests/server.mjs';
await build({entryPoints:['src/disk/scripts/publication-cache-cases.mjs'],bundle:true,format:'esm',platform:'browser',target:'es2022',outfile:'build/disk/web/publication-cache-cases.js'});
const server=makeServer(process.cwd());await new Promise(r=>server.listen(0,'127.0.0.1',r));const results=[];
try{for(const [engine,type] of Object.entries({chromium,webkit})){
 const browser=await type.launch();try{const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>console.log(engine,m.text()));await page.goto('http://127.0.0.1:'+server.address().port+'/disk/browser-tests/index.html?no-isolation');
 const result=await page.evaluate(async()=>{const {runPublicationCacheCases}=await import('/build/disk/web/publication-cache-cases.js');return runPublicationCacheCases();});assert.deepEqual(errors,[]);results.push({engine,...result});console.log(engine,JSON.stringify(result));
 }finally{await browser.close();}
}}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
await mkdir('build/publication-cache',{recursive:true});await writeFile('build/publication-cache/validation.json',JSON.stringify(results,null,2));
