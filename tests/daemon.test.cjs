const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, '..', 'qbittorrent-interceptor.user.js'), 'utf8');
const title = { id: 42, kind: 'tv', name: 'Example Show', year: '2024', overview: 'A show.' };
const initialState = { destinations: ['/media/TV'], sources: [{ enabled: true }], subscriptions: [] };
const plain = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setImmediate(resolve));

function setup(t, { state = initialState, handler, storage = {}, addOK = true } = {}) {
    const dom = new JSDOM('<!doctype html><title>Example Show S01E05</title><body></body>', {
        url: 'https://tracker.example/show', runScripts: 'outside-only',
    });
    t.after(() => dom.window.close());
    const w = dom.window;
    const saved = new Map(Object.entries({ qbit_daemon_enabled: true, qbit_daemon_url: 'http://daemon:8791', qbit_daemon_token: 'secret', ...storage }));
    const requests = [];
    const adds = [];
    const menus = new Map();
    w.GM_getValue = (key, fallback) => saved.has(key) ? saved.get(key) : fallback;
    w.GM_setValue = (key, value) => saved.set(key, value);
    w.GM_addStyle = () => {};
    w.GM_registerMenuCommand = (name, callback) => menus.set(name, callback);
    w.GM_xmlhttpRequest = options => {
        requests.push(options);
        queueMicrotask(() => {
            const command = options.data ? JSON.parse(options.data) : null;
            const result = handler?.(command, options);
            if (result === 'pending') return;
            if (result?.event) return options[result.event]();
            const body = result?.body ?? (command?.action === 'discover' ? { titles: [title] } : command ? { message: 'Subscription saved' } : { state });
            options.onload({ status: result?.status || 200, responseText: typeof body === 'string' ? body : JSON.stringify(body) });
        });
        return { abort() {} };
    };
    w.__add = async (...args) => { adds.push(args); return addOK; };
    w.eval(source.replace('    init();\n})();', `
        globalThis.__test = { parseShowHint, validateDaemonSettings, daemonRequest, showFollowModal, showConfigModal,
            handleLink, setupMagnetProtocolInterceptor, handleTorrentDownload,
            stubAdds() { signInFromGestureIfNeeded = async () => true; addTorrentByUrl = globalThis.__add; addTorrentByFile = globalThis.__add; },
            stubBlob(blob) { downloadTorrentFile = async () => blob; }
        };
    })();`));
    const api = w.__test;
    api.stubAdds();
    const find = selector => w.document.querySelector(selector);
    const choose = () => {
        find('.qbit-show-title').value = '42';
        find('.qbit-show-title').dispatchEvent(new w.Event('change'));
    };
    const commands = () => requests.filter(r => r.data).map(r => JSON.parse(r.data));
    return { w, api, saved, requests, adds, menus, find, choose, commands };
}

test('release hints understand episodes, season packs, underscores, and malformed names', t => {
    const { api } = setup(t);
    for (const [name, query, season, episode] of [
        ['Example.Show.S01E05.1080p', 'Example Show', 1, 5],
        ['Example_Show_2x12_2160p', 'Example Show', 2, 12],
        ['Example Show Season 3', 'Example Show', 3, 1],
        ['Example Show S02', 'Example Show', 2, 1],
        ['No episode.torrent', 'No episode', 0, 1],
        [null, '', 0, 1],
    ]) assert.deepEqual(plain(api.parseShowHint(name)), { query, season, episode });
});

test('daemon uses bearer auth through GM, preserves base paths, rejects unsafe settings', async t => {
    const { api, requests } = setup(t);
    await api.daemonRequest({ action: 'state' }, { url: 'https://host/qbt-dl///', token: 'secret' });
    assert.equal(requests[0].url, 'https://host/qbt-dl/api/v1/library');
    assert.equal(requests[0].headers.Authorization, 'Bearer secret');
    assert.equal(requests[0].anonymous, true);
    assert.equal(requests[0].redirect, 'error');
    assert.equal(requests[0].headers.Cookie, undefined);
    for (const url of ['javascript:alert(1)', 'file:///tmp', 'https://user:pass@host', 'https://host/?q=x', 'https://host/#x', 'broken']) {
        await assert.rejects(api.daemonRequest(null, { url, token: 'secret' }), /HTTP\(S\)/);
    }
    await assert.rejects(api.daemonRequest(null, { url: 'https://host', token: '' }), /bearer token/);
});

for (const [label, response, pattern] of [
    ['unauthorized', { status: 401 }, /rejected the token/],
    ['old daemon', { status: 404 }, /3.4.0/],
    ['proxy HTML', { body: '<html>login</html>' }, /invalid response/],
    ['API validation', { status: 400, body: { error: 'choose a configured destination' } }, /configured destination/],
    ['network', { event: 'onerror' }, /Cannot reach/],
    ['timeout', { event: 'ontimeout' }, /timed out/],
]) test(`daemon reports ${label} errors`, async t => {
    const { api } = setup(t, { handler: () => response });
    await assert.rejects(api.daemonRequest(null, { url: 'https://host', token: 'secret' }), pattern);
});

for (const mode of ['future', 'missing', 'from']) test(`follow-only saves ${mode} scope after explicit catalog selection`, async t => {
    const ctx = setup(t);
    ctx.api.showFollowModal('Example.Show.S01E05.1080p');
    await tick();
    assert.equal(ctx.find('.qbit-confirm').disabled, true);
    assert.equal(ctx.find('.qbit-show-query').value, 'Example Show');
    ctx.choose();
    ctx.find('.qbit-show-mode').value = mode;
    ctx.find('.qbit-show-mode').dispatchEvent(new ctx.w.Event('change'));
    assert.equal(ctx.find('.qbit-show-from').hidden, mode !== 'from');
    ctx.find('.qbit-confirm').click();
    await tick();
    const subscription = ctx.commands().find(c => c.action === 'subscribe').subscription;
    assert.deepEqual(subscription, { title, mode, enabled: true, destination: '/media/TV', fromSeason: 1, fromEpisode: 5 });
    assert.equal(ctx.adds.length, 0);
    assert.equal(ctx.find('.qbit-modal'), null);
});

test('from mode rejects fractional, empty, zero, and negative episode numbers', async t => {
    const ctx = setup(t);
    ctx.api.showFollowModal('Example S01E05');
    await tick();
    ctx.choose();
    ctx.find('.qbit-show-mode').value = 'from';
    for (const value of ['1.5', '', '0', '-1']) {
        ctx.find('.qbit-show-episode').value = value;
        ctx.find('.qbit-confirm').click();
        await tick();
        assert.match(ctx.find('.qbit-show-status').textContent, /whole starting season and episode/);
    }
    assert.equal(ctx.commands().filter(c => c.action === 'subscribe').length, 0);
});

test('add succeeds, follow fails, and retry does not add the torrent twice', async t => {
    let attempts = 0;
    const ctx = setup(t, { handler(command) {
        if (command?.action === 'subscribe' && ++attempts === 1) return { status: 400, body: { error: 'library is checking releases; try again shortly' } };
    } });
    ctx.api.showFollowModal('Example S01E05', 'magnet:?xt=urn:btih:123');
    await tick();
    ctx.choose();
    ctx.find('.qbit-confirm').click();
    ctx.find('.qbit-confirm').click();
    await tick();
    assert.equal(ctx.adds.length, 1);
    assert.equal(ctx.find('.qbit-confirm').textContent, 'Retry follow');
    assert.match(ctx.find('.qbit-show-status').textContent, /Torrent added/);
    ctx.find('.qbit-confirm').click();
    await tick();
    assert.equal(attempts, 2);
    assert.equal(ctx.adds.length, 1);
    assert.equal(ctx.find('.qbit-modal'), null);
});

test('failed torrent add never creates a subscription', async t => {
    const ctx = setup(t, { addOK: false });
    ctx.api.showFollowModal('Example S01E05', 'magnet:?xt=urn:btih:123');
    await tick();
    ctx.choose();
    ctx.find('.qbit-confirm').click();
    await tick();
    assert.equal(ctx.commands().filter(c => c.action === 'subscribe').length, 0);
    assert.match(ctx.find('.qbit-show-status').textContent, /Torrent was not added/);
});

test('torrent-file upload and fallback propagate success/failure to caller', async t => {
    const ctx = setup(t, { addOK: false });
    ctx.api.stubBlob({ slice: () => ({ arrayBuffer: async () => new Uint8Array([100]).buffer }) });
    assert.equal(await ctx.api.handleTorrentDownload('https://tracker/file.torrent', 'file.torrent'), false);
    ctx.api.stubBlob({ slice: () => ({ arrayBuffer: async () => new Uint8Array([60]).buffer }) });
    assert.equal(await ctx.api.handleTorrentDownload('https://tracker/file.torrent', 'file.torrent'), false);
    assert.equal(ctx.adds.length, 2);
});

test('existing show retains its scope/destination and clearly indicates an update', async t => {
    const ctx = setup(t, { state: { ...initialState, destinations: ['/media/TV', '/media/Other'], subscriptions: [
        { title, mode: 'from', destination: '/media/Other', fromSeason: 2, fromEpisode: 8, enabled: false },
    ] } });
    ctx.api.showFollowModal('Example S01E05');
    await tick();
    ctx.choose();
    assert.equal(ctx.find('.qbit-show-mode').value, 'from');
    assert.equal(ctx.find('.qbit-show-season').value, '2');
    assert.equal(ctx.find('.qbit-show-episode').value, '8');
    assert.equal(ctx.find('.qbit-show-destination').value, '/media/Other');
    assert.match(ctx.find('.qbit-show-existing').textContent, /paused/);
    assert.equal(ctx.find('.qbit-confirm').textContent, 'Update follow');
});

test('missing destinations block follow; no sources produces a visible setup message', async t => {
    const ctx = setup(t, { state: { ...initialState, destinations: [], sources: [] } });
    ctx.api.showFollowModal('Example S01E05');
    await tick();
    ctx.choose();
    assert.equal(ctx.find('.qbit-confirm').disabled, true);
    assert.match(ctx.find('.qbit-show-status').textContent, /Add a destination/);
});

test('empty catalog and query edits do not retain a previous selection', async t => {
    const ctx = setup(t, { handler: command => command?.query === 'unknown' ? { body: { titles: [] } } : undefined });
    ctx.api.showFollowModal('Example S01E05');
    await tick();
    ctx.choose();
    ctx.find('.qbit-show-query').value = 'unknown';
    ctx.find('.qbit-show-query').dispatchEvent(new ctx.w.Event('input'));
    assert.equal(ctx.find('.qbit-confirm').disabled, true);
    ctx.find('.qbit-show-search').click();
    await tick();
    assert.match(ctx.find('.qbit-show-status').textContent, /No shows found/);
});

test('out-of-order searches cannot overwrite the latest results', async t => {
    const pending = [];
    const ctx = setup(t, { handler(command, options) {
        if (command?.action === 'discover') { pending.push(options); return 'pending'; }
    } });
    ctx.api.showFollowModal('First S01E01');
    await tick();
    ctx.find('.qbit-show-query').value = 'Second';
    ctx.find('.qbit-show-query').dispatchEvent(new ctx.w.Event('input'));
    ctx.find('.qbit-show-search').click();
    await tick();
    pending[1].onload({ status: 200, responseText: JSON.stringify({ titles: [{ ...title, name: 'Second' }] }) });
    await tick();
    pending[0].onload({ status: 200, responseText: JSON.stringify({ titles: [{ ...title, name: 'First' }] }) });
    await tick();
    assert.match(ctx.find('.qbit-show-title').textContent, /Second/);
    assert.doesNotMatch(ctx.find('.qbit-show-title').textContent, /First/);
});

test('untrusted torrent and catalog names are rendered as text', async t => {
    const ctx = setup(t, { handler: command => command?.action === 'discover' ? { body: { titles: [{ ...title, name: '<img src=x onerror=alert(1)>', overview: '<script>bad</script>' }] } } : undefined });
    ctx.api.showFollowModal('<img src=x onerror=alert(1)> S01E05', 'magnet:?dn=Example');
    await tick();
    ctx.choose();
    assert.equal(ctx.find('.qbit-modal img'), null);
    assert.equal(ctx.find('.qbit-modal script'), null);
    assert.equal(ctx.find('.qbit-show-overview').textContent, '<script>bad</script>');
});

test('settings test unsaved connection, load destinations, and save credentials', async t => {
    const ctx = setup(t);
    ctx.api.showConfigModal();
    ctx.find('#qbit-cfg-daemon-url').value = 'https://new-daemon/base';
    ctx.find('#qbit-cfg-daemon-token').value = 'new-token';
    ctx.find('#qbit-act-daemon-test').click();
    await tick();
    assert.equal(ctx.requests[0].url, 'https://new-daemon/base/api/v1/library');
    assert.equal(ctx.requests[0].headers.Authorization, 'Bearer new-token');
    assert.match(ctx.find('#qbit-daemon-status').textContent, /Connected/);
    ctx.find('#qbit-cfg-daemon-destination').value = '/media/TV';
    ctx.find('#qbit-cfg-save').click();
    assert.equal(ctx.saved.get('qbit_daemon_url'), 'https://new-daemon/base');
    assert.equal(ctx.saved.get('qbit_daemon_token'), 'new-token');
    assert.equal(ctx.saved.get('qbit_daemon_destination'), '/media/TV');
});

test('normal links and window.open magnets both expose the follow action', t => {
    const ctx = setup(t);
    ctx.api.handleLink('https://tracker.example/download.php?torrent=5', { preventDefault() {}, stopPropagation() {} }, 'Example Show S01E05');
    const button = [...ctx.w.document.querySelectorAll('button')].find(b => b.textContent === 'Add & follow TV show…');
    assert.ok(button);
    button.click();
    assert.equal(ctx.find('.qbit-show-query').value, 'Example Show');
    ctx.find('.qbit-cancel').click();
    ctx.api.setupMagnetProtocolInterceptor();
    ctx.w.open('magnet:?dn=Example.Show.S01E05');
    assert.ok([...ctx.w.document.querySelectorAll('button')].find(b => b.textContent === 'Add & follow TV show…'));
});

test('disabled integration leaves normal add unchanged; menu opens setup', t => {
    const ctx = setup(t, { storage: { qbit_daemon_enabled: false } });
    ctx.api.handleLink('magnet:?dn=Example.Show.S01E05', { preventDefault() {}, stopPropagation() {} });
    assert.equal([...ctx.w.document.querySelectorAll('button')].find(b => b.textContent.includes('follow')), undefined);
    ctx.find('.qbit-cancel').click();
    ctx.menus.get('📺 Follow TV show with qbt-dl')();
    assert.ok(ctx.find('#qbit-cfg-daemon-url'));
    assert.equal(ctx.requests.length, 0);
});
