function asError(value) {
  return value instanceof Error ? value : new Error(String(value));
}

export function armShutdownFailsafe(onTimeout, timeoutMs = 60_000) {
  if (typeof onTimeout !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10 * 60_000) {
    throw new Error('A shutdown failsafe needs a callback and a deadline between 1 ms and 10 minutes.');
  }
  let timer = setTimeout(() => {
    timer = null;
    onTimeout();
  }, timeoutMs);
  return () => {
    if (!timer) return false;
    clearTimeout(timer);
    timer = null;
    return true;
  };
}

/**
 * Run shutdown work without allowing one failed cleanup to skip the rest.
 * Callers preserve the required ordering by awaiting each attempt in order,
 * then surface every collected failure after the final cleanup has run.
 */
export class ShutdownCleanup {
  constructor() {
    this.failures = [];
  }

  async attempt(label, operation) {
    if (typeof label !== 'string' || !label || typeof operation !== 'function') {
      throw new Error('A shutdown cleanup needs a label and operation.');
    }
    try {
      await operation();
      return true;
    } catch (value) {
      const cause = asError(value);
      this.failures.push(new Error(`${label}: ${cause.message}`, { cause }));
      return false;
    }
  }

  async retry(label, operation, attempts = 2) {
    if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10) {
      throw new Error('A shutdown cleanup retry count must be between 1 and 10.');
    }
    const failures = [];
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        await operation();
        return true;
      } catch (value) {
        failures.push(asError(value));
      }
    }
    const cause = failures.length === 1 ? failures[0]
      : new AggregateError(failures, `${label} failed after ${attempts} attempts.`);
    this.failures.push(new Error(`${label}: ${cause.message}`, { cause }));
    return false;
  }

  throwIfFailed() {
    if (this.failures.length) {
      throw new AggregateError(this.failures,
        'FrostByte could not complete every shutdown cleanup. The application will exit with an error.');
    }
  }
}
