/**
 * Cloud Functions v2 entry point for the Blackfrost Hub API.
 *
 * One HTTPS function, `hubApi`, in `us-central1`, behind a small internal
 * router. Same deployment shape as the existing `frostnetApi` function, so the
 * operational procedure is already known.
 *
 * The Hub uses its own Firestore database (`blackfrost-hub`), never `(default)`
 * — see docs/adr/002-hub-backend-firebase.md.
 */

import { initializeApp, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { onRequest } from 'firebase-functions/v2/https';
import { setGlobalOptions } from 'firebase-functions/v2';
import { defineSecret } from 'firebase-functions/params';

import { createApp } from './src/app.js';
import { conflict, forbidden } from './src/http.js';
import { createFirestoreStore } from './src/store/firestore.js';
import { createMemoryStore } from './src/store/memory.js';

const HUB_DATABASE = process.env.HUB_FIRESTORE_DATABASE || 'blackfrost-hub';
const REGION = process.env.HUB_REGION || 'us-central1';

/**
 * Browser origins permitted to call the Hub API.
 *
 * Defaults to the production site so a deploy without configuration is still
 * correct for frostbyte.si. App Hosting preview URLs are added explicitly via
 * `HUB_ALLOWED_ORIGINS` rather than by pattern — see src/cors.js for why the
 * list is exact-match only.
 */
const DEFAULT_ALLOWED_ORIGINS = 'https://frostbyte.si,https://www.frostbyte.si';
const ALLOWED_ORIGINS = process.env.HUB_ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS;

setGlobalOptions({ region: REGION, maxInstances: 20, concurrency: 40 });

// Declared but never inlined: values are read from Secret Manager at runtime.
// STRIPE_HUB_WEBHOOK_SECRET is only required by the billing webhook;
// STRIPE_SECRET_KEY is required by checkout and the billing portal;
// HUB_CURSOR_SECRET signs discovery pagination cursors.
const stripeHubWebhookSecret = defineSecret('STRIPE_HUB_WEBHOOK_SECRET');
const stripeSecretKey = defineSecret('STRIPE_SECRET_KEY');
const hubCursorSecret = defineSecret('HUB_CURSOR_SECRET');

let cachedApp = null;

function buildApp() {
  if (cachedApp) return cachedApp;

  if (process.env.HUB_STORE === 'memory') {
    cachedApp = createApp({ store: createMemoryStore(), allowedOrigins: ALLOWED_ORIGINS });
    return cachedApp;
  }

  // Fail closed at cold start: a production Hub without an explicit Identity
  // Platform tenant would silently accept the shared Blackfrost AI root pool.
  const tenantId = (process.env.FROSTBYTE_AUTH_TENANT_ID || '').trim();
  if (!/^[A-Za-z0-9_-]{4,64}$/.test(tenantId)) {
    throw new Error('FROSTBYTE_AUTH_TENANT_ID must be configured in production and match /^[A-Za-z0-9_-]{4,64}$/');
  }

  const app = getApps().length > 0 ? getApps()[0] : initializeApp();
  const firestore = getFirestore(app, HUB_DATABASE);
  const tenantAuth = getAuth(app).tenantManager().authForTenant(tenantId);

  const store = createFirestoreStore({ firestore });

  cachedApp = createApp({
    store,
    // checkRevoked=true: a disabled/revoked account loses access on its very
    // next request, not when its cached ID token expires.
    verifyIdToken: async (token) => tenantAuth.verifyIdToken(token, true),
    tenantId,
    mintDesktopCustomToken: async ({ uid, sessionId }) => {
      const userRecord = await tenantAuth.getUser(uid);
      if (userRecord.disabled) {
        throw forbidden('This account has been disabled.');
      }
      return tenantAuth.createCustomToken(uid, {
        frostbyteDesktopSession: sessionId,
      });
    },
    adminDirectory: {
      getUser: (uid) => tenantAuth.getUser(uid),
      getUserByEmail: (email) => tenantAuth.getUserByEmail(email),
      listUsers: (maxResults = 100, pageToken) => tenantAuth.listUsers(maxResults, pageToken),
      createUser: (properties) => tenantAuth.createUser(properties),
      updateUser: (uid, properties) => tenantAuth.updateUser(uid, properties),
      setCustomUserClaims: (uid, claims) => tenantAuth.setCustomUserClaims(uid, claims),
      revokeRefreshTokens: (uid) => tenantAuth.revokeRefreshTokens(uid),
      generatePasswordResetLink: (email) => tenantAuth.generatePasswordResetLink(email),
      canSendEmail: () => Boolean((process.env.HUB_WEB_API_KEY || '').trim()),
      // The Admin SDK cannot send mail; dispatch through Firebase's own OOB
      // endpoint, tenant-scoped. Fails closed when the web API key is absent.
      sendPasswordResetEmail: async (email) => {
        // HUB_WEB_API_KEY: the Firebase CLI reserves the FIREBASE_ prefix in
        // functions .env files, so the web key ships under an unprefixed name.
        const apiKey = (process.env.HUB_WEB_API_KEY || '').trim();
        if (!apiKey) throw conflict('HUB_WEB_API_KEY is not configured; cannot dispatch reset emails.');
        const response = await fetch(
          `https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${encodeURIComponent(apiKey)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ requestType: 'PASSWORD_RESET', email, tenantId }),
          },
        );
        if (!response.ok) {
          const detail = await response.json().catch(() => ({}));
          throw conflict(`Password reset dispatch failed (${detail?.error?.message || response.status}).`);
        }
      },
    },
    allowedOrigins: ALLOWED_ORIGINS,
  });

  return cachedApp;
}

export const hubApi = onRequest(
  {
    region: REGION,
    timeoutSeconds: 30,
    memory: '256MiB',
    minInstances: 0,
    maxInstances: 20,
    secrets: [stripeHubWebhookSecret, stripeSecretKey, hubCursorSecret],
    cors: false,
  },
  async (req, res) => {
    const handler = buildApp();
    return handler(req, res);
  },
);

// Exported for tests and for `firebase emulators:start`.
export { buildApp, HUB_DATABASE };