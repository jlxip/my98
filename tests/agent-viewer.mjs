import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {chromium,webkit} from 'playwright';
import {createViewer} from '../scripts/agent/viewer.mjs';
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jAFAAAAAASUVORK5CYII=';
const requests=[],typed=[];let state={loaded:true,running:true,network:{state:'identity-closed'}},saved=0;
const viewer=createViewer({frame:async()=>({data:png}),run:async request=>{
    requests.push(request.command);
    if(request.command==='status')return state;
    if(request.command==='network-login'){
        assert.equal(request.credentials.machine,'main');
        state.network.state=request.credentials.username==='rejected'?'rejected':'online';return {state:state.network.state};
    }
    if(request.command==='network-logout')state.network.state='identity-closed';
    if(request.command==='pause')state.running=false;if(request.command==='resume')state.running=true;
    if(request.command==='save-pause'){state.running=false;saved++;}
    if(request.command==='type'){assert(['A','Public fixture @+'].includes(request.text));typed.push(request.text);}
    if(request.command==='key')assert.equal(request.key,'Ctrl+a');
    return {};
}});
const server=createServer(async(req,res)=>{
    try{
        const url=new URL(req.url,'http://127.0.0.1');
        if(await viewer.handle(req,res,url))return;
        if(url.pathname==='/vendor/basecoat-1.0.2/basecoat.min.css'){res.setHeader('Content-Type','text/css');res.end(await readFile('vendor/basecoat-1.0.2/basecoat.min.css'));return;}
        res.writeHead(404).end();
    }catch(error){res.writeHead(500).end(String(error));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port,url=viewer.url(origin),token=url.split('#')[1];
try{
    for(const supplied of ['', 'g'.repeat(64), '0'.repeat(64)]){
        const response=await fetch(origin+'/_agent/view/frame',{headers:{'X-My98-View':supplied}});assert.equal(response.status,401);
    }
    const unsafe=await fetch(origin+'/_agent/view/api',{method:'POST',headers:{'X-My98-View':token},body:JSON.stringify({command:'stop'})});
    assert.equal(unsafe.status,400);assert(!requests.includes('stop'));
    for(const [name,type] of Object.entries({chromium,webkit})){
        state={loaded:true,running:true,network:{state:'identity-closed'}};
        const browser=await type.launch();
        try{
            const page=await browser.newPage({viewport:{width:1050,height:850}}),errors=[];
            page.on('pageerror',error=>errors.push(String(error)));
            await page.goto(url);await page.waitForFunction(()=>document.querySelector('#screen').naturalWidth>0);
            assert.equal(new URL(page.url()).hash,'','local capability removed from browser URL');
            await page.locator('[name=username]').fill('fixture');await page.locator('[name=password]').fill('public fixture');await page.locator('[type=submit]').click();
            await page.waitForFunction(()=>document.querySelector('#network-state').textContent==='Internet connected');
            assert.equal(await page.locator('[name=password]').inputValue(),'');
            assert(await page.locator('[name=username]').evaluate(el=>parseFloat(getComputedStyle(el).minHeight)>=44));
            await page.locator('#screen').focus();await page.keyboard.press('Shift+A');await page.keyboard.press('Control+a');
            await page.waitForTimeout(100);assert(requests.includes('type'));assert(requests.includes('key'));
            // Never touch the host clipboard: exercise the button with a public fixture.
            await page.evaluate(()=>{
                window.clipboardReads=0;window.clipboardMode='allow';
                Object.defineProperty(navigator,'clipboard',{configurable:true,value:{async readText(){
                    window.clipboardReads++;
                    if(window.clipboardMode==='deny')throw new DOMException('Blocked','NotAllowedError');
                    if(window.clipboardMode==='empty')return '';
                    if(window.clipboardMode==='delayed')await new Promise(resolve=>window.finishClipboard=resolve);
                    return 'Public fixture @+';
                }}});
            });
            assert.equal(await page.evaluate(()=>window.clipboardReads),0,'clipboard is only read on click');
            const typedBefore=typed.length;
            await page.locator('#paste').click();
            await page.waitForFunction(()=>document.querySelector('#message').textContent==='Pasted.');
            assert.equal(typed.length,typedBefore+1);assert.equal(typed.at(-1),'Public fixture @+');
            assert.equal(await page.locator('#screen').evaluate(el=>document.activeElement===el),true,'guest focus retained');
            assert(!(await page.locator('body').innerText()).includes('Public fixture @+'),'clipboard contents not displayed');
            await page.evaluate(()=>window.clipboardMode='deny');await page.locator('#paste').click();
            await page.waitForFunction(()=>document.querySelector('#message').textContent.startsWith('Allow clipboard'));
            assert.equal(typed.length,typedBefore+1,'denied read sends nothing');
            await page.evaluate(()=>window.clipboardMode='empty');await page.locator('#paste').click();
            await page.waitForFunction(()=>document.querySelector('#message').textContent==='Clipboard is empty.');
            assert.equal(typed.length,typedBefore+1,'empty read sends nothing');
            await page.evaluate(()=>window.clipboardMode='delayed');await page.locator('#paste').click();
            await page.waitForFunction(()=>typeof window.finishClipboard==='function');
            assert(await page.locator('#paste').isDisabled());
            await page.locator('#paste').evaluate(el=>el.click());
            await page.waitForTimeout(1100);assert(await page.locator('#paste').isDisabled(),'status polling preserves pending state');
            assert.equal(await page.evaluate(()=>window.clipboardReads),4,'no duplicate clipboard reads');
            await page.evaluate(()=>window.finishClipboard());
            await page.waitForFunction(()=>document.querySelector('#message').textContent==='Pasted.');
            assert.equal(typed.length,typedBefore+2);
            await page.locator('#run').click();await page.waitForFunction(()=>document.querySelector('#run').textContent==='Resume');
            assert(await page.locator('#paste').isDisabled(),'paused guest cannot paste');
            await page.locator('#save').click();await page.waitForFunction(()=>document.querySelector('#message').textContent==='Saved.');
            assert(saved>0);
            await page.locator('[name=username]').fill('rejected');await page.locator('[name=password]').fill('retain draft');await page.locator('[type=submit]').click();
            await page.waitForFunction(()=>document.querySelector('#network-state').textContent==='Login rejected');
            assert.equal(await page.locator('[name=password]').inputValue(),'retain draft','failed login preserves draft');
            await page.setViewportSize({width:390,height:844});
            assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
            assert.deepEqual(errors,[]);
            await fetch(origin+'/_agent/view/api',{method:'POST',headers:{'X-My98-View':token,'X-My98-Input':'closing-fixture'},body:JSON.stringify({command:'pointer',pointer:{buttons:[true,false,false]}})});
            const releases=requests.filter(x=>x==='release').length;
            await page.close();await new Promise(resolve=>setTimeout(resolve,1750));assert(requests.filter(x=>x==='release').length>releases,'lost input owner is released even without pagehide');
            console.log(name+': private access, login/draft, keyboard/clipboard, save/pause, mobile layout and input release PASS');
        }finally{await browser.close();}
    }
}finally{viewer.dispose();await new Promise(resolve=>server.close(resolve));}
