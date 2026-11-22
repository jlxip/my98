/** Keep Gecko test bookkeeping separate from macOS-protected personal profiles. */
import {firefox} from 'playwright';
import {mkdirSync,readFileSync,writeFileSync,readdirSync,symlinkSync,existsSync,chmodSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
export function browserOptions(name) {
    if(name!=='firefox'||process.platform!=='darwin')return {};
    const binary=firefox.executablePath(),resources=resolve(dirname(binary),'../Resources');
    if(!existsSync(join(resources,'browser')))return {};
    const root=fileURLToPath(new URL('../build/pages-tests/firefox-'+process.pid+'/',import.meta.url));
    mkdirSync(root,{recursive:true});
    for(const name of readdirSync(join(resources,'browser')))
        if(name!=='application.ini'&&!existsSync(join(root,name)))symlinkSync(join(resources,'browser',name),join(root,name));
    const label='My98Tests'+process.pid;
    const ini=readFileSync(join(resources,'application.ini'),'utf8').replace('Vendor=Mozilla','Vendor='+label).replace('Name=Firefox','Name='+label).replace('RemotingName=firefox-default','RemotingName='+label);
    writeFileSync(join(root,'application.ini'),ini);
    const quote=value=>"'"+value.replaceAll("'","'\\''")+"'",wrapper=join(root,'launch');
    writeFileSync(wrapper,'#!/bin/sh\nexec '+quote(binary)+' -app '+quote(join(root,'application.ini'))+' "$@"\n');chmodSync(wrapper,0o755);
    return {executablePath:wrapper};
}
