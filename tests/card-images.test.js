import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { fetchCardImage, validateCardImageUrl, isHfImageHost } from '../src/main/card-images.js';

const publicResolve = async () => [{ address: '18.239.50.1', family: 4 }];

// Fake https.request: routes by URL to canned responses and records what was requested.
function fakeRequest(routes, seen = []) {
  return (url, options, onResponse) => {
    const req = new EventEmitter();
    req.destroy = (error) => { if (error) queueMicrotask(() => req.emit('error', error)); };
    req.end = () => {
      seen.push({ url: String(url), lookup: options.lookup });
      const route = routes[String(url)];
      if (!route) { queueMicrotask(() => req.emit('error', new Error('no route'))); return; }
      const response = new EventEmitter();
      response.statusCode = route.status ?? 200;
      response.headers = route.headers ?? {};
      response.destroy = (error) => { response.destroyed = true; if (error) queueMicrotask(() => response.emit('error', error)); };
      queueMicrotask(() => {
        onResponse(response);
        req.emit('response', response);
        // Real IncomingMessage streams stay paused until a data listener attaches; emulate that by deferring.
        if (route.body !== undefined) setImmediate(() => {
          const body = Buffer.isBuffer(route.body) ? route.body : Buffer.from(route.body);
          for (let i = 0; i < body.length && !response.destroyed; i += 4096) response.emit('data', body.subarray(i, i + 4096));
          if (!response.destroyed) response.emit('end');
        });
      });
    };
    return req;
  };
}

test('accepts only plain https URLs', () => {
  assert.ok(validateCardImageUrl('https://cdn-uploads.huggingface.co/a.png'));
  for (const bad of ['http://example.com/a.png', 'file:///etc/passwd', 'data:image/png;base64,AA', 'https://u:p@example.com/a.png', 'https://example.com:8443/a.png', 'javascript:alert(1)', '']) {
    assert.throws(() => validateCardImageUrl(bad), undefined, bad);
  }
});

test('recognises Hugging Face image hosts without suffix confusion', () => {
  for (const host of ['huggingface.co', 'cdn-uploads.huggingface.co', 'hf.co', 'cas-bridge.xethub.hf.co']) assert.equal(isHfImageHost(host), true, host);
  for (const host of ['evilhuggingface.co', 'huggingface.co.evil.com', 'img.shields.io', 'hf.co.attacker.net', '']) assert.equal(isHfImageHost(host), false, host);
});

test('fetches an image and pins the connection to the vetted address', async () => {
  const seen = [];
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const result = await fetchCardImage('https://cdn-uploads.huggingface.co/a.png', {
    resolve: publicResolve,
    request: fakeRequest({ 'https://cdn-uploads.huggingface.co/a.png': { headers: { 'content-type': 'image/png' }, body: png } }, seen),
  });
  assert.equal(result.mime, 'image/png');
  assert.deepEqual(result.data, png);
  const pinned = await new Promise(resolve => seen[0].lookup('cdn-uploads.huggingface.co', {}, (_e, address) => resolve(address)));
  assert.equal(pinned, '18.239.50.1');
});

test('refuses hosts that resolve to private, loopback or link-local addresses', async () => {
  for (const address of ['127.0.0.1', '10.80.10.37', '192.168.1.5', '169.254.169.254', '::1', 'fd00::1', '100.64.0.1']) {
    await assert.rejects(fetchCardImage('https://rebind.example/a.png', {
      resolve: async () => [{ address, family: address.includes(':') ? 6 : 4 }],
      request: fakeRequest({}),
    }), /network address/, address);
  }
  // Mixed answers are refused too (DNS rebinding with one public and one private record).
  await assert.rejects(fetchCardImage('https://rebind.example/a.png', {
    resolve: async () => [{ address: '18.239.50.1', family: 4 }, { address: '127.0.0.1', family: 4 }],
    request: fakeRequest({}),
  }), /network address/);
});

test('re-validates every redirect hop', async () => {
  const resolve = async (host) => host === 'internal.example' ? [{ address: '10.0.0.5', family: 4 }] : [{ address: '18.239.50.1', family: 4 }];
  await assert.rejects(fetchCardImage('https://img.example/a.png', {
    resolve,
    request: fakeRequest({ 'https://img.example/a.png': { status: 302, headers: { location: 'https://internal.example/secret.png' } } }),
  }), /network address/);
  await assert.rejects(fetchCardImage('https://img.example/a.png', {
    resolve,
    request: fakeRequest({ 'https://img.example/a.png': { status: 301, headers: { location: 'http://img.example/a.png' } } }),
  }), /HTTPS/);
  const loop = { 'https://img.example/a.png': { status: 302, headers: { location: 'https://img.example/a.png' } } };
  await assert.rejects(fetchCardImage('https://img.example/a.png', { resolve, request: fakeRequest(loop) }), /redirected too many/);
  const ok = await fetchCardImage('https://img.example/a.png', {
    resolve,
    request: fakeRequest({
      'https://img.example/a.png': { status: 307, headers: { location: '/b.webp' } },
      'https://img.example/b.webp': { headers: { 'content-type': 'image/webp' }, body: 'RIFF' },
    }),
  });
  assert.equal(ok.mime, 'image/webp');
});

test('rejects non-image content and oversized bodies', async () => {
  const url = 'https://img.example/a.png';
  for (const type of ['text/html', 'application/javascript', 'image/svg', '']) {
    await assert.rejects(fetchCardImage(url, { resolve: publicResolve, request: fakeRequest({ [url]: { headers: { 'content-type': type }, body: '<script>' } }) }), /not a supported image/, type);
  }
  await assert.rejects(fetchCardImage(url, { resolve: publicResolve, maxBytes: 1024, request: fakeRequest({ [url]: { headers: { 'content-type': 'image/png', 'content-length': '999999' }, body: '' } }) }), /too large/);
  await assert.rejects(fetchCardImage(url, { resolve: publicResolve, maxBytes: 1024, request: fakeRequest({ [url]: { headers: { 'content-type': 'image/png' }, body: Buffer.alloc(20_000) } }) }), /too large/);
  await assert.rejects(fetchCardImage(url, { resolve: publicResolve, request: fakeRequest({ [url]: { status: 404, body: '' } }) }), /HTTP 404/);
});
