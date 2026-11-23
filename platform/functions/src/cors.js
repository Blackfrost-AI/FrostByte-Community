/**
 * CORS for browser clients.
 *
 * The Hub API was originally server-to-server only (the Electron main process
 * calls it with `fetch`, which never sends a preflight). A browser app on
 * `frostbyte.si` is cross-origin, so every authenticated request triggers an
 * `OPTIONS` preflight — without these headers the browser blocks the response
 * before any application code runs.
 *
 * Design notes:
 *
 * - **Explicit allowlist, never `*`.** A wildcard would let any page on the
 *   internet read a response the user's browser attaches a token to. The list
 *   is configuration, not code.
 * - **Exact origin echo.** We reflect the request's `Origin` back only when it
 *   matches the allowlist exactly. No pattern matching, no suffix checks — a
 *   suffix check is how `evil-frostbyte.si` gets in.
 * - **`Vary: Origin` always.** Responses differ by origin, so any shared cache
 *   must key on it. Omitting this leaks one origin's response to another.
 * - **No `Access-Control-Allow-Credentials`.** Authentication is a bearer
 *   header, not a cookie, so credentials mode buys nothing and would widen the
 *   surface (it is what makes wildcard-plus-cookies dangerous).
 * - **CORS is not authorisation.** These headers tell a browser which
 *   cross-origin reads to permit. They are not a security boundary: any
 *   non-browser client ignores them entirely. Authorisation stays in
 *   `auth.js` and `entitlements.js`, which re-verify on every request.
 */

/** Methods the API actually exposes. */
const ALLOWED_METHODS = 'GET, POST, PATCH, DELETE, OPTIONS';

/** Headers a browser client may send. */
const ALLOWED_HEADERS = 'Authorization, Content-Type, Stripe-Signature';

/** How long a browser may cache the preflight result, in seconds. */
const MAX_AGE_SECONDS = 600;

/**
 * Parse the configured allowlist.
 *
 * Accepts a comma-separated string (as an env var arrives) or an array.
 * Entries are trimmed and lowercased so `https://FrostByte.si` and
 * `https://frostbyte.si` cannot both be treated as distinct, and empty entries
 * are dropped. Returns a `Set` for O(1) membership checks.
 *
 * @param {string|string[]|undefined|null} value
 * @returns {Set<string>}
 */
export function parseAllowedOrigins(value) {
  if (!value) return new Set();
  const parts = Array.isArray(value) ? value : String(value).split(',');
  const set = new Set();
  for (const part of parts) {
    const origin = String(part).trim().toLowerCase().replace(/\/+$/, '');
    if (!origin) continue;
    // Reject anything that is not a concrete http(s) origin. A bare `*` here
    // would silently disable the allowlist, so require an explicit scheme.
    if (!/^https?:\/\/[a-z0-9.-]+(:\d+)?$/.test(origin)) continue;
    set.add(origin);
  }
  return set;
}

/**
 * Apply CORS headers for this request.
 *
 * Always sets `Vary: Origin` so caches cannot serve one origin's response to
 * another. Only sets `Access-Control-Allow-Origin` when the request's origin
 * is on the allowlist.
 *
 * @param {object} req
 * @param {object} res
 * @param {Set<string>} allowedOrigins
 * @returns {{ allowed: boolean, origin: string|null, preflight: boolean }}
 */
export function applyCors(req, res, allowedOrigins) {
  // The response body varies by request origin regardless of whether this
  // particular request carried one, so this is set unconditionally.
  res.setHeader('Vary', 'Origin');

  const rawOrigin = req.headers?.origin ?? req.headers?.Origin;
  const origin = typeof rawOrigin === 'string' ? rawOrigin.trim().toLowerCase() : '';
  const method = String(req.method || 'GET').toUpperCase();
  const preflight = method === 'OPTIONS';

  const allowed = origin !== '' && allowedOrigins.has(origin);

  if (allowed) {
    // Echo the *normalised* origin rather than the raw header. They are equal
    // by construction, and this avoids reflecting arbitrary bytes.
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
    res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
    res.setHeader('Access-Control-Max-Age', String(MAX_AGE_SECONDS));
  } else if (preflight) {
    // An unlisted origin still gets a readable preflight failure rather than a
    // hang: the browser reports "no ACAO header", which is diagnosable. The
    // request is not rejected outright because CORS is browser policy — the
    // server has nothing to authorise yet on an OPTIONS.
    res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
    res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
  }

  return { allowed, origin: origin || null, preflight };
}

/**
 * Answer a preflight.
 *
 * `204 No Content` is the conventional preflight response — there is no body
 * to send and sending one would be ignored.
 */
export function sendPreflight(res) {
  res.statusCode = 204;
  res.setHeader('Content-Length', '0');
  res.end();
}

export const CORS_DEFAULTS = {
  ALLOWED_METHODS,
  ALLOWED_HEADERS,
  MAX_AGE_SECONDS,
};