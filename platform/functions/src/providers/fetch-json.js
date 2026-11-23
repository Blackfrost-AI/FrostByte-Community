/**
 * Bounded outbound fetch.
 *
 * Mirrors the discipline in src/main/hub-client.js: a hard timeout, a response
 * size cap, `redirect: 'error'`, and no credential ever attached by default.
 * Nothing here retries automatically — a retry storm against three upstreams is
 * worse than a clean 502, and the caller decides.
 */

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_BYTES = 512 * 1024;

export class UpstreamError extends Error {
  constructor(message, { provider, status, retryable = true } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.provider = provider;
    this.status = status;
    this.retryable = retryable;
  }
}

/**
 * Fetch JSON from an upstream with bounds applied.
 *
 * @param {object} options
 * @param {string} options.url            Absolute https URL.
 * @param {Function} [options.fetcher]    Injected for tests; defaults to global fetch.
 * @param {Record<string,string>} [options.headers]
 * @param {number} [options.timeoutMs]
 * @param {number} [options.maxBytes]
 * @param {string} [options.provider]     Name used in error messages.
 */
export async function fetchJson({
  url,
  fetcher = globalThis.fetch,
  headers = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  provider = 'upstream',
}) {
  if (typeof fetcher !== 'function') {
    throw new UpstreamError(`${provider} is not reachable from this runtime.`, { provider });
  }
  if (!/^https:\/\//.test(url)) {
    throw new UpstreamError(`Refusing a non-HTTPS ${provider} URL.`, { provider, retryable: false });
  }

  const signal = AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': 'Blackfrost-Hub/1 (+https://blackfrost.si)', ...headers },
      signal,
      redirect: 'error',
    });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw new UpstreamError(
      timedOut ? `${provider} timed out.` : `${provider} could not be reached.`,
      { provider },
    );
  }

  if (!response || typeof response.status !== 'number') {
    throw new UpstreamError(`${provider} returned an unreadable response.`, { provider });
  }

  if (response.status === 404) {
    throw new UpstreamError(`${provider} has no such record.`, { provider, status: 404, retryable: false });
  }
  if (response.status === 429) {
    throw new UpstreamError(`${provider} is rate limiting us.`, { provider, status: 429 });
  }
  if (response.status < 200 || response.status >= 300) {
    throw new UpstreamError(`${provider} returned ${response.status}.`, { provider, status: response.status });
  }

  const text = await readBounded(response, maxBytes, provider);
  if (text.trim() === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    // A provider that answers HTML where JSON was promised is a real failure
    // mode here — Pirate Face serves HTML for unknown /api routes.
    throw new UpstreamError(`${provider} returned a non-JSON response.`, { provider });
  }
}

async function readBounded(response, maxBytes, provider) {
  if (typeof response.text === 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new UpstreamError(`${provider} returned an oversized response.`, { provider });
    }
    return text;
  }
  if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) throw new UpstreamError(`${provider} returned an oversized response.`, { provider });
      chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  return '';
}

export { DEFAULT_TIMEOUT_MS, DEFAULT_MAX_BYTES };