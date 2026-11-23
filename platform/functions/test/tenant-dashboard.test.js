/**
 * Tenant isolation + user dashboard tests (spec §3, §4.4, Gate 1).
 *
 * Hermetic: memory store, fixed clock, stubbed verifier. Proves that root-pool
 * and foreign-tenant credentials never resolve to a FrostByte identity, that
 * pre-tenant API keys die at cutover, and that the dashboard routes enforce
 * ownership, limits, and interactive-session requirements.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { harness, FIXED_NOW, TEST_TENANT_ID } from './harness.js';
import { generateApiKey } from '../src/auth.js';

// ---- Tenant isolation --------------------------------------------------------

test('tenant: valid tenant token resolves; /v1/me carries emailVerified/isAdmin hints', async () => {
  const { request } = await harness({ tenantId: TEST_TENANT_ID });
  const res = await request({ url: '/v1/me', token: 'valid-token' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().emailVerified, true);
  assert.equal(res.json().isAdmin, false);
});

test('tenant: root-pool token (no tenant claim) is rejected 401', async () => {
  const { request } = await harness({ tenantId: TEST_TENANT_ID });
  const res = await request({ url: '/v1/me', token: 'root-pool-token' });
  assert.equal(res.statusCode, 401);
});

test('tenant: foreign-tenant token is rejected 401', async () => {
  const { request } = await harness({ tenantId: TEST_TENANT_ID });
  const res = await request({ url: '/v1/me', token: 'other-tenant-token' });
  assert.equal(res.statusCode, 401);
});

test('tenant: with no tenant configured, root-pool tokens still work (dev mode)', async () => {
  const { request } = await harness();
  const res = await request({ url: '/v1/me', token: 'root-pool-token' });
  assert.equal(res.statusCode, 200);
});

test('tenant: pre-tenant API key is rejected once the tenant is live', async () => {
  const { store, request } = await harness({ tenantId: TEST_TENANT_ID });
  // The harness seeds the user WITH the tenant; rewrite it to the pre-tenant
  // shape (no tenantId) to simulate a key minted before cutover.
  await store.setUser('user_123', { uid: 'user_123', email: 'user@example.com', tier: 'free', disabled: false });
  const { plaintext, keyHash } = generateApiKey();
  await store.setApiKey(keyHash, { uid: 'user_123', prefix: 'pretenant1', label: 'old key' });
  const res = await request({ url: '/v1/me', token: plaintext, headers: { authorization: `Bearer ${plaintext}` } });
  assert.equal(res.statusCode, 401);
});

test('tenant: API key for a tenant-stamped user still works', async () => {
  const { store, request } = await harness({ tenantId: TEST_TENANT_ID });
  const { plaintext, keyHash } = generateApiKey();
  await store.setApiKey(keyHash, { uid: 'user_123', prefix: 'tenantkey1', label: 'new key' });
  const res = await request({ url: '/v1/me', token: plaintext, headers: { authorization: `Bearer ${plaintext}` } });
  assert.equal(res.statusCode, 200);
});

test('tenant: disabled account is refused for both token and API key', async () => {
  const { store, request } = await harness({ tenantId: TEST_TENANT_ID });
  await store.updateUser('user_123', { disabled: true });
  const tokenRes = await request({ url: '/v1/me', token: 'valid-token' });
  assert.equal(tokenRes.statusCode, 403);
  const { plaintext, keyHash } = generateApiKey();
  await store.setApiKey(keyHash, { uid: 'user_123', prefix: 'disabledk1', label: 'k' });
  const keyRes = await request({ url: '/v1/me', token: plaintext, headers: { authorization: `Bearer ${plaintext}` } });
  assert.equal(keyRes.statusCode, 403);
});

// ---- Hardware profiles ---------------------------------------------------------

const HW = { label: 'MacBook Pro', acceleratorType: 'apple-unified', memoryGiB: 48, bandwidthGBs: 400 };

test('hardware: create, list, default-toggle, delete round-trip', async () => {
  const { request } = await harness({ tenantId: TEST_TENANT_ID });
  const create = await request({ url: '/v1/me/hardware-profiles', method: 'POST', token: 'valid-token', body: { ...HW, isDefault: true } });
  assert.equal(create.statusCode, 200);
  const id = create.json().profile.id;
  assert.ok(id);

  const second = await request({ url: '/v1/me/hardware-profiles', method: 'POST', token: 'valid-token', body: { label: 'RTX rig', acceleratorType: 'nvidia-vram', memoryGiB: 24, isDefault: true } });
  assert.equal(second.statusCode, 200);

  const list = await request({ url: '/v1/me/hardware-profiles', token: 'valid-token' });
  assert.equal(list.json().items.length, 2);
  const defaults = list.json().items.filter((item) => item.isDefault);
  assert.equal(defaults.length, 1, 'setting a new default clears the old one');
  assert.equal(defaults[0].label, 'RTX rig');

  const remove = await request({ url: `/v1/me/hardware-profiles/${id}`, method: 'DELETE', token: 'valid-token' });
  assert.equal(remove.statusCode, 200);
  const after = await request({ url: '/v1/me/hardware-profiles', token: 'valid-token' });
  assert.equal(after.json().items.length, 1);
});

test('hardware: validation rejects bad types and sizes', async () => {
  const { request } = await harness({ tenantId: TEST_TENANT_ID });
  const badType = await request({ url: '/v1/me/hardware-profiles', method: 'POST', token: 'valid-token', body: { ...HW, acceleratorType: 'quantum' } });
  assert.equal(badType.statusCode, 400);
  const badMem = await request({ url: '/v1/me/hardware-profiles', method: 'POST', token: 'valid-token', body: { ...HW, memoryGiB: 0 } });
  assert.equal(badMem.statusCode, 400);
  const badLabel = await request({ url: '/v1/me/hardware-profiles', method: 'POST', token: 'valid-token', body: { ...HW, label: '' } });
  assert.equal(badLabel.statusCode, 400);
});

test('hardware: API keys cannot write profiles (interactive session required)', async () => {
  const { store, request } = await harness({ tenantId: TEST_TENANT_ID });
  const { plaintext, keyHash } = generateApiKey();
  await store.setApiKey(keyHash, { uid: 'user_123', prefix: 'hwkey12345', label: 'k' });
  const res = await request({
    url: '/v1/me/hardware-profiles', method: 'POST', token: plaintext,
    headers: { authorization: `Bearer ${plaintext}` }, body: HW,
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error.code, 'interactive_session_required');
});

test('hardware: another user cannot delete my profile', async () => {
  const { store, request } = await harness({ tenantId: TEST_TENANT_ID });
  await store.upsertHardwareProfile('someone_else', { id: 'hw_other', label: 'theirs', acceleratorType: 'cpu-ram', memoryGiB: 16 });
  const res = await request({ url: '/v1/me/hardware-profiles/hw_other', method: 'DELETE', token: 'valid-token' });
  assert.equal(res.statusCode, 404);
  assert.equal((await store.listHardwareProfiles('someone_else')).length, 1);
});

test('hardware: 20-profile cap enforced, updates exempt', async () => {
  const { store, request } = await harness({ tenantId: TEST_TENANT_ID });
  for (let i = 0; i < 20; i += 1) {
    await store.upsertHardwareProfile('user_123', { id: `hw_${i}`, label: `p${i}`, acceleratorType: 'cpu-ram', memoryGiB: 8 });
  }
  const overflow = await request({ url: '/v1/me/hardware-profiles', method: 'POST', token: 'valid-token', body: { label: 'one too many', acceleratorType: 'cpu-ram', memoryGiB: 8 } });
  assert.equal(overflow.statusCode, 409);
  assert.equal(overflow.json().error.code, 'hardware_profile_limit_reached');
  const update = await request({ url: '/v1/me/hardware-profiles', method: 'POST', token: 'valid-token', body: { id: 'hw_0', label: 'renamed', acceleratorType: 'cpu-ram', memoryGiB: 8 } });
  assert.equal(update.statusCode, 200);
});

// ---- Saved models -----------------------------------------------------------------

const SAVE = { provider: 'huggingface', providerId: 'Qwen/Qwen3-0.6B-GGUF', name: 'Qwen3 0.6B', quant: 'Q4_K_M', sizeBytes: 400_000_000 };

test('saved models: save is idempotent by provider+id+quant', async () => {
  const { request } = await harness({ tenantId: TEST_TENANT_ID });
  const first = await request({ url: '/v1/me/saved-models', method: 'POST', token: 'valid-token', body: SAVE });
  assert.equal(first.statusCode, 200);
  const again = await request({ url: '/v1/me/saved-models', method: 'POST', token: 'valid-token', body: SAVE });
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().item.modelKey, first.json().item.modelKey);
  const list = await request({ url: '/v1/me/saved-models', token: 'valid-token' });
  assert.equal(list.json().items.length, 1);

  const remove = await request({ url: `/v1/me/saved-models/${first.json().item.modelKey}`, method: 'DELETE', token: 'valid-token' });
  assert.equal(remove.statusCode, 200);
  const empty = await request({ url: '/v1/me/saved-models', token: 'valid-token' });
  assert.equal(empty.json().items.length, 0);
});

test('saved models: unknown provider rejected; API key writes refused', async () => {
  const { store, request } = await harness({ tenantId: TEST_TENANT_ID });
  const bad = await request({ url: '/v1/me/saved-models', method: 'POST', token: 'valid-token', body: { ...SAVE, provider: 'napster' } });
  assert.equal(bad.statusCode, 400);
  const { plaintext, keyHash } = generateApiKey();
  await store.setApiKey(keyHash, { uid: 'user_123', prefix: 'svkey12345', label: 'k' });
  const keyRes = await request({
    url: '/v1/me/saved-models', method: 'POST', token: plaintext,
    headers: { authorization: `Bearer ${plaintext}` }, body: SAVE,
  });
  assert.equal(keyRes.statusCode, 403);
});

test('saved models: 200-item cap enforced', async () => {
  const { store, request } = await harness({ tenantId: TEST_TENANT_ID });
  for (let i = 0; i < 200; i += 1) {
    await store.upsertSavedModel('user_123', {
      modelKey: String(i).padStart(32, '0'), provider: 'huggingface', providerId: `org/m${i}`, name: `m${i}`, quant: '',
    });
  }
  const overflow = await request({ url: '/v1/me/saved-models', method: 'POST', token: 'valid-token', body: SAVE });
  assert.equal(overflow.statusCode, 409);
  assert.equal(overflow.json().error.code, 'saved_model_limit_reached');
});

// ---- Profile backfill ---------------------------------------------------------------

test('me: pre-tenant profile gets emailLower and tenantId backfilled on read', async () => {
  const { store, request } = await harness({ tenantId: TEST_TENANT_ID });
  await store.setUser('user_123', { uid: 'user_123', email: 'User@Example.com', tier: 'free', disabled: false });
  const res = await request({ url: '/v1/me', token: 'valid-token' });
  assert.equal(res.statusCode, 200);
  const user = await store.getUser('user_123');
  assert.equal(user.emailLower, 'user@example.com');
  assert.equal(user.tenantId, TEST_TENANT_ID);
});
