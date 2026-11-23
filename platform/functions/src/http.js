/**
 * Shared HTTP contract for the Hub API.
 *
 * Every response is JSON with `Cache-Control: no-store` unless a route
 * explicitly opts into caching. Error bodies are `{ error: { code, message } }`
 * per docs/hub-api.md — the same shape the desktop client already parses in
 * src/main/hub-client.js, so no client change is needed.
 */

export class HubError extends Error {
  constructor(status, code, message, { retryAfterSeconds, headers } = {}) {
    super(message);
    this.name = 'HubError';
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
    this.headers = headers || {};
  }
}

export const badRequest = (message, code = 'bad_request') => new HubError(400, code, message);
export const unauthorized = (message = 'Sign in to continue.', code = 'unauthenticated') => new HubError(401, code, message);
export const forbidden = (message = 'Your plan does not include this.', code = 'forbidden') => new HubError(403, code, message);
export const notFound = (message = 'Not found.', code = 'not_found') => new HubError(404, code, message);
export const conflict = (message, code = 'conflict') => new HubError(409, code, message);
export const tooLarge = (message = 'Request body is too large.') => new HubError(413, 'payload_too_large', message);
export const unprocessable = (message) => new HubError(422, 'unprocessable', message);
export const rateLimited = (message = 'Too many requests. Try again shortly.', seconds = 60) =>
  new HubError(429, 'rate_limited', message, { retryAfterSeconds: seconds });
export const upstreamFailure = (message = 'An upstream provider is unavailable.') =>
  new HubError(502, 'upstream_unavailable', message, { retryAfterSeconds: 30 });
export const unavailable = (message = 'Hub is temporarily unavailable.') =>
  new HubError(503, 'unavailable', message, { retryAfterSeconds: 60 });

/** Serialize a value to JSON and apply the standard header set. */
export function sendJson(res, status, body, extraHeaders = {}) {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  for (const [key, value] of Object.entries(extraHeaders)) res.setHeader(key, value);
  res.end(text);
}

/** Send a HubError (or an unexpected error) using the standard error shape. */
export function sendError(res, error) {
  const isHub = error instanceof HubError;
  const status = isHub ? error.status : 500;
  const code = isHub ? error.code : 'internal';
  // Never leak an unexpected error's message to the client — it can contain
  // filesystem paths, Firestore internals, or upstream URLs with credentials.
  const message = isHub ? error.message : 'Something went wrong.';
  const headers = {};
  if (isHub && error.retryAfterSeconds) headers['Retry-After'] = String(error.retryAfterSeconds);
  if (isHub) Object.assign(headers, error.headers);
  sendJson(res, status, { error: { code, message } }, headers);
}

/**
 * Read and bound a JSON request body.
 *
 * `req.body` is populated by the Functions framework only when the content type
 * is JSON; we accept both that and a raw stream so tests can drive the handler
 * without the framework.
 */
export async function readJsonBody(req, maxBytes) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
      const encoded = JSON.stringify(req.body);
      if (Buffer.byteLength(encoded, 'utf8') > maxBytes) throw tooLarge();
      return req.body;
    }
    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body), 'utf8');
    if (buffer.byteLength > maxBytes) throw tooLarge();
    return parseJson(buffer);
  }

  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw tooLarge();
    chunks.push(chunk);
  }
  if (total === 0) return {};
  return parseJson(Buffer.concat(chunks));
}

function parseJson(buffer) {
  const text = buffer.toString('utf8');
  if (text.trim() === '') return {};
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw badRequest('Request body must be a JSON object.');
    }
    return value;
  } catch (error) {
    if (error instanceof HubError) throw error;
    throw badRequest('Request body is not valid JSON.');
  }
}

/** Extract the bearer token from an Authorization header. */
export function bearerToken(req) {
  const header = req.headers?.authorization || req.headers?.Authorization || '';
  const match = /^Bearer\s+(\S{1,4096})$/.exec(String(header));
  return match ? match[1] : '';
}