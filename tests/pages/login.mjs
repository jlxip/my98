import assert from 'node:assert/strict';
import {chromium,webkit} from 'playwright';
import {serveSite} from './server.mjs';
import {unlockIdentity} from './encrypted.mjs';
for(const [name,type] of Object.entries({chromium,webkit})) {
    const fixtureOptions={headers:true};
    const server=await serveSite(fixtureOptions),browser=await type.launch();
    try {
        const page=await browser.newPage(),errors=[],requests=[];
        page.on('pageerror',e=>errors.push(String(e)));page.on('request',r=>requests.push(r.url()));
        await page.goto(server.url);await page.waitForFunction(()=>!document.body.inert);
        assert.equal(await page.locator('#disk-reader').isVisible(),false);
        for(const width of [320,1280]) {
            await page.setViewportSize({width,height:800});
            await page.getByRole('button',{name:'Or use a read key',exact:true}).click();
            assert.equal(await page.locator('#disk-login').isVisible(),false);
            assert.equal(await page.locator('#disk-read-key').evaluate(el=>document.activeElement===el),true);
            assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
            await page.screenshot({path:`build/transport-retirement/${name}-access-reader-${width}.png`,fullPage:true});
            await page.getByRole('button',{name:'Or log in',exact:true}).focus();
            await page.keyboard.press('Enter');
            assert.equal(await page.locator('#disk-reader').isVisible(),false);
            assert.equal(await page.locator('#disk-user').evaluate(el=>document.activeElement===el),true);
            await page.screenshot({path:`build/transport-retirement/${name}-access-login-${width}.png`,fullPage:true});
        }
        await unlockIdentity(page);
        const key=await page.locator('#disk-identity').textContent();assert.match(key,/^[0-9a-f]{64}$/);
        assert.equal(await page.locator('#disk-password').inputValue(),'');
        assert.equal(await page.locator('#disk-remote').count(),0);
        assert.match(await page.locator('#disk-status').textContent(),/No publication was found/);
        assert.equal(await page.locator('#session').isVisible(),false);
        assert.equal(server.requests.filter(r=>r.path.startsWith('/v2/dht/')).length,2);
        assert.equal(await page.locator('#disk-auth-switch').isVisible(),false);
        assert.equal(await page.locator('#disk-only-localhost').isVisible(),false);
        assert.equal(await page.locator('#disk-boot').isDisabled(),true);
        assert.equal(await page.locator('#disk-open').isEnabled(),true);
        assert.equal(await page.locator('#disk-boot').isVisible(),false);
        assert.equal(await page.locator('#disk-menu-state').isVisible(),false);
        for(const width of [320,1280]) {
            await page.setViewportSize({width,height:800});
            await page.screenshot({path:`build/transport-retirement/${name}-workspace-open-${width}.png`,fullPage:true});
            await page.locator('#disk-menu-disk > summary').focus();await page.keyboard.press('Enter');
            assert.equal(await page.locator('#disk-create').isVisible(),true);
            assert.equal(await page.locator('#disk-open').isVisible(),true);
            assert.equal(await page.locator('#disk-save').isVisible(),false);
            await page.screenshot({path:`build/transport-retirement/${name}-workspace-disk-${width}.png`,fullPage:true});
            await page.locator('#disk-menu-tools > summary').click();
            await page.waitForFunction(()=>!document.querySelector('#disk-menu-disk').open);
            assert.equal(await page.locator('#disk-relay-key').isVisible(),true);
            assert.equal(await page.locator('#disk-clear-cache').isVisible(),false);
            assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
            await page.keyboard.press('Escape');
            assert.equal(await page.locator('#disk-menu-tools').evaluate(el=>el.open),false);
            assert.equal(await page.locator('#disk-menu-tools > summary').evaluate(el=>document.activeElement===el),true);
            await page.locator('#disk-menu-disk > summary').click();
            await page.locator('#disk-identity').click();
            assert.equal(await page.locator('#disk-menu-disk').evaluate(el=>el.open),false);
        }
        page.on('dialog',d=>d.accept());await page.locator('#disk-close').click();
        await page.waitForFunction(()=>!document.querySelector('#disk-login').hidden);
        fixtureOptions.publicationStatus=503;
        await unlockIdentity(page);assert.equal(await page.locator('#disk-identity').textContent(),key);
        assert.match(await page.locator('#disk-status').textContent(),/No signed publication source is available/);
        await page.locator('#disk-menu-disk > summary').click();
        assert.equal(await page.locator('#disk-empty').isEnabled(),true);
        assert.equal(await page.locator('#disk-open').isVisible(),true);
        assert.equal(server.requests.filter(r=>r.path.startsWith('/v2/dht/')).length,4);
        assert(requests.every(url=>new URL(url).origin===new URL(server.url).origin));
        assert.deepEqual(errors,[]);console.log(name+': local identity, key stability, secret clearing and zero external requests PASS');
    } finally {await browser.close();await server.close();}
}
