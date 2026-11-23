/**
 * Minimal path router.
 *
 * Deliberately tiny: the Hub has a handful of routes and no need for a
 * framework. Patterns support `:param` segments only — no wildcards, no regex,
 * so a route table cannot become an injection surface.
 */

export class Router {
  constructor() {
    /** @type {Array<{method: string, segments: string[], handler: Function}>} */
    this.routes = [];
  }

  add(method, pattern, handler) {
    this.routes.push({
      method: method.toUpperCase(),
      segments: pattern.split('/').filter(Boolean),
      handler,
    });
    return this;
  }

  get(pattern, handler) {
    return this.add('GET', pattern, handler);
  }

  post(pattern, handler) {
    return this.add('POST', pattern, handler);
  }

  patch(pattern, handler) {
    return this.add('PATCH', pattern, handler);
  }

  delete(pattern, handler) {
    return this.add('DELETE', pattern, handler);
  }

  /**
   * @returns {{handler: Function, params: Record<string,string>} | {allow: string[]} | null}
   */
  match(method, pathname) {
    const parts = pathname.split('/').filter(Boolean);
    const allow = new Set();

    for (const route of this.routes) {
      const params = matchSegments(route.segments, parts);
      if (!params) continue;
      allow.add(route.method);
      if (route.method === method.toUpperCase() || (route.method === 'GET' && method === 'HEAD')) {
        return { handler: route.handler, params };
      }
    }

    if (allow.size > 0) return { allow: [...allow].sort() };
    return null;
  }
}

function matchSegments(segments, parts) {
  if (segments.length !== parts.length) return null;
  const params = {};
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment.startsWith(':')) {
      // A malformed percent-escape is a client error, not a server fault.
      let value;
      try {
        value = decodeURIComponent(parts[index]);
      } catch {
        return null;
      }
      if (!value || value.includes('/')) return null;
      params[segment.slice(1)] = value;
      continue;
    }
    if (segment !== parts[index]) return null;
  }
  return params;
}