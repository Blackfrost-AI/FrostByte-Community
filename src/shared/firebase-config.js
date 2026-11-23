/**
 * FrostByte Hub — Firebase project configuration.
 *
 * These are PUBLIC web identifiers, not secrets: a Firebase web API key only
 * identifies the project to Google's Identity Toolkit and is safe to ship in a
 * client (the same values appear in site/src/lib/firebase.ts). Authorization is
 * enforced server-side by the Hub (Firebase ID-token verification + Firestore
 * rules), never by hiding this key.
 *
 * The desktop app uses these to exchange email/password for a Firebase ID token
 * (src/main/firebase-auth.js); the ID token is then presented to the Hub as a
 * Bearer credential. No password or token is ever stored in plaintext.
 */
export const FIREBASE_CONFIG = Object.freeze({
  apiKey: 'AIzaSyDGQ6mJ9RQatE7fGPo43YSFXf9Rl1o8oAU',
  authDomain: 'blackfrost-ai-prod.firebaseapp.com',
  projectId: 'blackfrost-ai-prod',
  // Dedicated Identity Platform tenant isolating FrostByte accounts from
  // Blackfrost AI (spec §2.4). Empty string in local offline/dev until stamped
  // at cutover (§8.2); validated in src/main/firebase-auth.js.
  tenantId: 'frostbyte-0ji2f',
});