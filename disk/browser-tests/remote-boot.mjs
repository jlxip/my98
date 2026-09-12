import {fixture,repo} from './ipfs-fixture.mjs';
import {readFile,writeFile,copyFile,mkdir} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
if(process.argv.length!==3)throw Error('Usage: node disk/browser-tests/remote-boot.mjs <Win98 fixture.json>');
const original=JSON.parse(await readFile(resolve(repo,process.argv[2]),'utf8'));
const directory=resolve(repo,'build/ipfs/win98');await mkdir(directory,{recursive:true});
const source=resolve(directory,'source.img'),file=resolve(directory,'encrypted.my98');
if(resolve(repo,original.source)===source||resolve(repo,original.file)===file)throw Error('Use a source fixture outside the test copy directory');
await copyFile(resolve(repo,original.source),source);await copyFile(resolve(repo,original.file),file);
const small={...original,source,file},f=await fixture({small});
try {
    const path=resolve(directory,'fixture.json');await writeFile(path,JSON.stringify({...small,gateway:f.endpoint}));
    const child=spawn(process.execPath,[resolve(repo,'disk/browser-tests/boot.mjs'),path],{cwd:repo,stdio:'inherit'});
    const code=await new Promise(r=>child.once('exit',r));if(code!==0)throw Error('Remote Windows boot failed');
} finally {await f.close();}
