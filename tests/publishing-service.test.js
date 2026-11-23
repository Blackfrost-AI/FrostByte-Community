import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bencode from 'bencode';
import { PublishingService } from '../src/main/publishing-service.js';
import { createShareMetadata } from '../src/main/torrent.js';

test('publication re-verifies exact local bytes and the complete reviewed metainfo before sending', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'frostbyte-publish-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'model.gguf'); fs.writeFileSync(target, 'test');
  const files = [{ path: target, size: 4 }], link = await createShareMetadata(target, { files });
  const directory = path.join(root, 'share-metainfo'); fs.mkdirSync(directory);
  const metainfo = path.join(directory, link.infohash + '.torrent'); fs.writeFileSync(metainfo, link.metadata);
  const store = { appDir: root, state: { savedShareLinks: [{ path: target, device: 'local', infohash: link.infohash }] }, _commitStateFields(patch) { Object.assign(this.state, structuredClone(patch)); } };
  const service = new PublishingService({ store, protection: {}, resolve: async () => ({ path: target, name: 'Model', files }), inventory: { rows: [] }, sessions: () => [], review: async () => ({ response: 0 }), dialog: {}, state: () => ({}), handle() {} });
  t.after(() => service.stop());
  const release = await service.preview({ id: 'test', publisher: 'blackfrost', release: 'fixture', variant: 'gguf', license: { id: 'MIT', statement: 'Owner-created test bytes.' }, redistribution_confirmed: true });
  await service.queue.beforeSubmit({ digest: release.digest }, release);
  fs.writeFileSync(target, 'tEst');
  await assert.rejects(service.queue.beforeSubmit({ digest: release.digest }, release), /no longer match/);
  fs.writeFileSync(target, 'test');
  fs.writeFileSync(metainfo, bencode.encode({ ...bencode.decode(link.metadata), comment: 'Changed after review' }));
  await assert.rejects(service.queue.beforeSubmit({ digest: release.digest }, release), /metadata changed/);
});
