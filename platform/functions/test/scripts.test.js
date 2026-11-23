/**
 * Script helper unit tests (hermetic — no Firebase, no network).
 * Covers bootstrap validation + credential-file safety, rules stamping, and
 * quarantine selection. The network paths run only during cutover (§8).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { generateTempPassword, writeCredentialFile } from '../scripts/bootstrap-admin.mjs';
import { stampRules } from '../scripts/stamp-firestore-rules.mjs';
import { selectPreTenantUsers } from '../scripts/quarantine-pre-tenant-records.mjs';

// ---- bootstrap helpers -------------------------------------------------------

test('bootstrap: temp password has class coverage and unique values', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i += 1) {
    const password = generateTempPassword();
    assert.ok(password.length >= 24);
    assert.ok(/[a-z]/.test(password) || /[A-Z]/.test(password));
    assert.ok(/[0-9]/.test(password));
    assert.ok(password.endsWith('!Fb9'));
    assert.ok(!seen.has(password));
    seen.add(password);
  }
});

test('bootstrap: credential file is 0600 inside a 0700 dir, exclusive create', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-bootstrap-test-'));
  try {
    const secretsDir = path.join(dir, '.secrets');
    const filePath = writeCredentialFile({
      secretsDir, email: 'owner@example.com', tenantId: 'test-tenant', uid: 'u1', role: 'owner', tempPassword: 'SECRET-VALUE',
    });
    const fileMode = fs.statSync(filePath).mode & 0o777;
    const dirMode = fs.statSync(secretsDir).mode & 0o777;
    assert.equal(fileMode, 0o600);
    assert.equal(dirMode, 0o700);
    const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(payload.tempPassword, 'SECRET-VALUE');
    assert.equal(payload.uid, 'u1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- rules stamping -------------------------------------------------------------

const TEMPLATE = `
    function isFrostByteTenant() {
      return isSignedIn()
        && request.auth.token.firebase.get('tenant', '') == '__FROSTBYTE_AUTH_TENANT_ID__';
    }
`;

test('stamp: placeholder is substituted with the validated tenant', () => {
  const result = stampRules({ source: TEMPLATE, tenantId: 'frostbyte-abc1' });
  assert.equal(result.changed, true);
  assert.ok(result.stamped.includes("'frostbyte-abc1'"));
  assert.ok(!result.stamped.includes('__FROSTBYTE_AUTH_TENANT_ID__'));
});

test('stamp: malformed tenant ids are refused', () => {
  for (const bad of ['', 'ab', 'has space', 'x'.repeat(65), "drop';--"]) {
    assert.throws(() => stampRules({ source: TEMPLATE, tenantId: bad }), /Invalid tenant id/);
  }
});

test('stamp: same tenant is a no-op; different tenant needs --force', () => {
  const first = stampRules({ source: TEMPLATE, tenantId: 'tenant-aaaa' });
  const again = stampRules({ source: first.stamped, tenantId: 'tenant-aaaa' });
  assert.equal(again.changed, false);
  assert.throws(() => stampRules({ source: first.stamped, tenantId: 'tenant-bbbb' }), /refusing to overwrite/);
  const forced = stampRules({ source: first.stamped, tenantId: 'tenant-bbbb', force: true });
  assert.equal(forced.changed, true);
  assert.ok(forced.stamped.includes("'tenant-bbbb'"));
  assert.ok(!forced.stamped.includes("'tenant-aaaa'"));
});

// ---- quarantine selection -----------------------------------------------------------

test('quarantine: selects only docs whose tenantId differs', () => {
  const users = [
    { id: 'a', tenantId: 'tenant-live' },
    { id: 'b', tenantId: 'other-tenant' },
    { id: 'c' }, // pre-tenant ghost: no tenantId at all
    { id: 'd', tenantId: '' },
  ];
  const stale = selectPreTenantUsers(users, 'tenant-live');
  assert.deepEqual(stale.map((user) => user.id), ['b', 'c', 'd']);
});
