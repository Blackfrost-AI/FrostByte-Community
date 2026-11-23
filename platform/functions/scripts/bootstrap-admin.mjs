/**
 * FrostByte admin bootstrap (spec §6.2).
 *
 * Creates or updates the operator account INSIDE the FrostByte Identity
 * Platform tenant, mints the frostbyteAdmin claim, writes admins/{uid} +
 * users/{uid} in the `blackfrost-hub` database, and appends an audit entry.
 *
 * The generated temp password is written ONLY to a 0600 file under .secrets/
 * (gitignored). It is never printed to stdout/stderr and never enters the
 * audit log.
 *
 * Usage:
 *   node scripts/bootstrap-admin.mjs --email owner@example.com [--tenant-id ID]
 *        [--project blackfrost-ai-prod] [--role owner|admin] [--reset-password]
 *
 * Requires Application Default Credentials with access to the target project
 * (gcloud auth application-default login).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

const EMAIL_RE = /^[^\s@]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const TENANT_RE = /^[A-Za-z0-9_-]{4,64}$/;
const HUB_DATABASE = 'blackfrost-hub';

function fail(message, code = 2) {
  console.error(message);
  process.exit(code);
}

function parseArgs(argv) {
  const options = { email: '', tenantId: '', project: 'blackfrost-ai-prod', role: 'owner', resetPassword: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) fail(`Missing value for ${arg}`);
      i += 1;
      return argv[i];
    };
    if (arg === '--email') options.email = next();
    else if (arg === '--tenant-id') options.tenantId = next();
    else if (arg === '--project') options.project = next();
    else if (arg === '--role') options.role = next();
    else if (arg === '--reset-password') options.resetPassword = true;
    else fail(`Unknown argument: ${arg}`);
  }
  return options;
}

/** Validate inputs before any network call. Exported for unit tests. */
export function validateOptions(options, env = process.env) {
  const email = String(options.email || '').trim();
  if (!email) fail('--email is required.');
  if (!EMAIL_RE.test(email)) {
    if ((email.match(/@/g) || []).length > 1) {
      fail(`Invalid email "${email}": it contains more than one '@' (check for an extra '@' before the domain).`);
    }
    fail(`Invalid email "${email}": expected a single-@ address like owner@example.com.`);
  }

  const tenantId = String(options.tenantId || env.FROSTBYTE_AUTH_TENANT_ID || '').trim();
  if (!tenantId) fail('A tenant is required: pass --tenant-id or set FROSTBYTE_AUTH_TENANT_ID.');
  if (!TENANT_RE.test(tenantId)) {
    fail(`Invalid tenant id "${tenantId}": must match /^[A-Za-z0-9_-]{4,64}$/.`);
  }

  const role = String(options.role || 'owner');
  if (role !== 'owner' && role !== 'admin') fail('--role must be "owner" or "admin".');

  return { email, tenantId, project: options.project, role, resetPassword: options.resetPassword === true };
}

/** CSPRNG temp password with guaranteed character-class coverage. */
export function generateTempPassword() {
  return `${crypto.randomBytes(18).toString('base64url')}!Fb9`;
}

/**
 * Write the credential file with O_EXCL|O_NOFOLLOW and 0600 perms inside a
 * 0700 directory. Returns the absolute path. Never logs the password.
 */
export function writeCredentialFile({ secretsDir, email, tenantId, uid, role, tempPassword }) {
  fs.mkdirSync(secretsDir, { mode: 0o700, recursive: true });
  const filePath = path.join(secretsDir, `frostbyte-admin-bootstrap-${Date.now()}.json`);
  const payload = JSON.stringify({ email, tenantId, uid, role, tempPassword, createdAt: new Date().toISOString() }, null, 2);
  const fd = fs.openSync(
    filePath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.writeFileSync(fd, payload, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
  return filePath;
}

async function main() {
  const options = validateOptions(parseArgs(process.argv.slice(2)));
  const { email, tenantId, project, role, resetPassword } = options;

  const app = getApps().length > 0 ? getApps()[0] : initializeApp({ projectId: project });
  const tenantAuth = getAuth(app).tenantManager().authForTenant(tenantId);
  // MUST target blackfrost-hub, never the default database.
  const db = getFirestore(app, HUB_DATABASE);

  let userRecord;
  let tempPassword = null;
  let created = false;

  try {
    userRecord = await tenantAuth.getUserByEmail(email);
  } catch (error) {
    if (error.code !== 'auth/user-not-found') throw error;
    tempPassword = generateTempPassword();
    userRecord = await tenantAuth.createUser({
      email,
      emailVerified: true,
      password: tempPassword,
      displayName: 'FrostByte Admin',
      disabled: false,
    });
    created = true;
  }

  if (!created && resetPassword) {
    tempPassword = generateTempPassword();
    await tenantAuth.updateUser(userRecord.uid, { password: tempPassword, disabled: false, emailVerified: true });
  }

  const existingClaims = userRecord.customClaims || {};
  await tenantAuth.setCustomUserClaims(userRecord.uid, { ...existingClaims, frostbyteAdmin: true });
  await tenantAuth.revokeRefreshTokens(userRecord.uid);

  const nowIso = new Date().toISOString();
  const userRef = db.collection('users').doc(userRecord.uid);
  const existingUserSnap = await userRef.get();
  const existingUser = existingUserSnap.exists ? existingUserSnap.data() : null;
  const authCreatedMs = Date.parse(userRecord.metadata?.creationTime || '');
  const createdAt = existingUser?.createdAt
    || (Number.isFinite(authCreatedMs) ? new Date(authCreatedMs).toISOString() : nowIso);

  await db.collection('admins').doc(userRecord.uid).set(
    { uid: userRecord.uid, email, emailLower: email.toLowerCase(), role, status: 'active', grantedBy: 'bootstrap-script', updatedAt: nowIso },
    { merge: true },
  );
  await userRef.set(
    {
      uid: userRecord.uid,
      email,
      emailLower: email.toLowerCase(),
      displayName: existingUser?.displayName || userRecord.displayName || 'FrostByte Admin',
      tenantId,
      disabled: existingUser?.disabled ?? false,
      createdAt,
      updatedAt: nowIso,
    },
    { merge: true },
  );
  await db.collection('auditLog').add({
    actorUid: userRecord.uid,
    actorEmail: email,
    action: 'admin.bootstrap',
    targetType: 'user',
    targetId: userRecord.uid,
    reason: 'Initial CLI owner bootstrap',
    at: nowIso,
  });

  let passwordFile = null;
  if (tempPassword) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const secretsDir = path.resolve(here, '../../../.secrets');
    passwordFile = writeCredentialFile({ secretsDir, email, tenantId, uid: userRecord.uid, role, tempPassword });
  }

  // Zero-leak: the password exists only in the credential file.
  console.log(JSON.stringify({ ok: true, uid: userRecord.uid, tenantId, email, role, created, passwordFile }));
}

// Only run when invoked directly (keeps the helpers importable for tests).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('Bootstrap failed:', error.message);
    process.exit(1);
  });
}
