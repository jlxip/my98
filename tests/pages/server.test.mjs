import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {serveSite} from './server.mjs';

test('general fixtures answer relay discovery offline before any service-worker fetch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'my98-server-'));
    let server;
    try {
        await writeFile(join(root, 'index.html'), '<html><head></head><body>fixture</body></html>');
        await writeFile(join(root, 'asset.js'), 'fixture asset');
        server = await serveSite({root, prefix: '/my98/'});
        const html = await (await fetch(server.url)).text();
        const script = html.match(/<head><script>(.*?)<\/script>/s)?.[1];
        assert.ok(script, 'Offline discovery runs before application scripts');
        const requests = [];
        const context = {URL, Request, Response, location: {href: server.url},
            fetch: async (...args) => {requests.push(args); return new Response('real fetch');}};
        runInNewContext(script, context);
        for(const input of ['https://nuc.jlxip.net/.well-known/my98-relay.json',
            new URL('https://piensa.jlxip.net/.well-known/my98-relay.json'),
            new Request('https://provider.example/.well-known/my98-relay.json')]) {
            const response = await context.fetch(input);
            assert.deepEqual(await response.json(), {version: 1, relay: null});
            assert.equal(response.headers.get('content-type'), 'application/json');
        }
        assert.equal(requests.length, 0, 'No production requests or service-worker failures');
        const options = {cache: 'no-store'};
        await context.fetch('./asset.js', options);
        assert.equal(requests.length, 1);
        assert.equal(requests[0][0], './asset.js');
        assert.equal(requests[0][1], options);
        assert.equal(await (await fetch(server.url + 'asset.js')).text(), 'fixture asset');
    } finally {await server?.close(); await rm(root, {recursive: true, force: true});}
});

test('relay-specific fixtures retain their discovery mocks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'my98-server-'));
    let server;
    try {
        const original = '<html><head></head><body>relay fixture</body></html>';
        await writeFile(join(root, 'index.html'), original);
        server = await serveSite({root, headers: true, relayDiscovery: true});
        assert.equal(await (await fetch(server.url)).text(), original);
    } finally {await server?.close(); await rm(root, {recursive: true, force: true});}
});
