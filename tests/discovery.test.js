import test from 'node:test';
import assert from 'node:assert/strict';
import { hfBrowse, hfFacets, hfModelInfo, hfRefs } from '../src/main/hf.js';

test('Hub search sends filters and expanded dates, and follows the opaque page cursor', async () => {
  const original = globalThis.fetch, urls = [];
  globalThis.fetch = async url => {
    urls.push(new URL(url));
    return new Response(JSON.stringify([{id:'owner/model',downloads:42,likes:3,lastModified:'2026-09-01T00:00:00Z',tags:['gguf','license:mit'],pipeline_tag:'text-generation'}]), {
      headers: { link: '<https://huggingface.co/api/models?cursor=page%2Btwo%3D>; rel="next"' },
    });
  };
  try {
    const options = {sort:'lastModified',direction:1,author:'owner',format:'gguf',license:'mit',language:'en',pipeline_tag:'text-generation',gated:'false',limit:40};
    const first = await hfBrowse('model', options);
    assert.equal(first.models[0].lastModified, '2026-09-01T00:00:00Z');
    assert.equal(first.models[0].license, 'mit');
    assert.equal(first.cursor, 'page+two=');
    await hfBrowse('model', {...options,cursor:first.cursor});
    const params = urls[1].searchParams;
    assert.equal(params.get('sort'),'lastModified');
    assert.equal(params.get('direction'),'1');
    assert.equal(params.get('cursor'),'page+two=');
    assert.equal(params.get('author'),'owner');
    assert.equal(params.get('gated'),'false');
    assert.equal(params.get('pipeline_tag'),'text-generation');
    assert.deepEqual(params.getAll('filter'),['en','gguf','license:mit']);
    assert.ok(params.getAll('expand').includes('lastModified'));
  } finally { globalThis.fetch = original; }
});

test('Hub pagination ignores foreign next links and presents rate limits clearly', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('[]', {headers:{link:'<https://example.org/api/models?cursor=abc>; rel="next"'}});
    assert.equal((await hfBrowse('')).cursor, null);
    globalThis.fetch = async () => new Response('', {status:429});
    await assert.rejects(hfBrowse(''), /rate limiting/);
  } finally { globalThis.fetch = original; }
});

test('Hub filter choices use API labels and are cached across openings', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async url => {
    calls++; const type = new URL(url).searchParams.get('type');
    return new Response(JSON.stringify({[type]:[{id:'b',label:'Beta'},{id:'a',label:'Alpha'}]}));
  };
  try {
    const first = await hfFacets(), second = await hfFacets();
    assert.equal(calls,4); assert.deepEqual(first,second);
    assert.deepEqual(first.library.map(row=>row.id),['a','b']);
  } finally { globalThis.fetch = original; }
});

test('hostile Hub response shapes are bounded and normalized before rendering', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(options.redirect, 'error');
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/refs')) return new Response(JSON.stringify({ branches: [{ name: 'main' }, { name: '<img>'.repeat(100) }], tags: 'wrong' }));
      if (parsed.pathname.startsWith('/api/models/')) return new Response(JSON.stringify({ id: 'other/repo', sha: 'a'.repeat(40), downloads: '<img>',
        config: { architectures: ['Qwen3ForCausalLM', '<script>', 7, 'A'.repeat(200)], model_type: 'qwen3; rm -rf' }, tags: ['exl3', { x: 1 }],
        siblings: [{ rfilename: 'config.json', size: 12 }, { rfilename: '../secret', size: 1 }, { rfilename: 'weights.gguf', size: Infinity }] }));
      return new Response(JSON.stringify(Array.from({ length: 500 }, (_, index) => ({ id: `owner/model-${index}`, downloads: '<img>', likes: Infinity,
        tags: index ? [] : '<not-an-array>', pipeline_tag: { html: true } }))));
    };
    const page = await hfBrowse('model', { limit: 3 });
    assert.equal(page.models.length, 3); assert.equal(page.models[0].downloads, 0); assert.equal(page.models[0].pipelineTag, '');
    const model = await hfModelInfo('owner/model');
    assert.deepEqual(model.architectures, ['Qwen3ForCausalLM']); assert.equal(model.modelType, ''); assert.deepEqual(model.tags, ['exl3']);
    assert.equal(model.id, 'owner/model'); assert.deepEqual(model.files, [{ path: 'config.json', size: 12, sha256: null }, { path: 'weights.gguf', size: 0, sha256: null }]);
    assert.deepEqual(await hfRefs('owner/model'), [{ name: 'main', type: 'Branch' }]);
    await assert.rejects(hfRefs('../admin'), /repository/);
  } finally { globalThis.fetch = original; }
});
