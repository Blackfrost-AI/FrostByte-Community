import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { armShutdownFailsafe, ShutdownCleanup } from '../src/main/shutdown.js';

test('shutdown failsafe fires once and can be disarmed', async () => {
  let fired = 0;
  const disarm = armShutdownFailsafe(() => { fired++; }, 10);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(fired, 1);
  assert.equal(disarm(), false);

  const cancelled = armShutdownFailsafe(() => { fired++; }, 10);
  assert.equal(cancelled(), true);
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(fired, 1);
});

test('persistence and router failures cannot skip download cancellation, drain, or engine shutdown', async () => {
  const calls = [];
  const cleanup = new ShutdownCleanup();
  const activeDownload = {
    abort() { calls.push('hf:abort'); },
  };

  await cleanup.attempt('Final transfer checkpoint', () => {
    calls.push('persist:transfers');
    throw new Error('fixture disk failure');
  });
  await cleanup.attempt('Pre-cancellation Hugging Face checkpoint', () => {
    calls.push('persist:hf:before');
  });
  await cleanup.attempt('Hugging Face download cancellation', () => activeDownload.abort());
  await cleanup.attempt('Hugging Face download drain', async () => {
    calls.push('hf:drain');
  });
  await cleanup.attempt('Final Hugging Face checkpoint', () => {
    calls.push('persist:hf:after');
    throw new Error('fixture disk failure');
  });
  await cleanup.retry('Router mapping removal', async () => {
    calls.push('upnp:disable');
    throw new Error('fixture unmap failure');
  }, 2);
  await cleanup.attempt('Torrent engine shutdown', async () => {
    calls.push('engine:destroy');
  });

  assert.deepEqual(calls, [
    'persist:transfers', 'persist:hf:before', 'hf:abort', 'hf:drain', 'persist:hf:after',
    'upnp:disable', 'upnp:disable', 'engine:destroy',
  ]);
  assert.throws(() => cleanup.throwIfFailed(), error => {
    assert.equal(error instanceof AggregateError, true);
    assert.equal(error.errors.length, 3);
    assert.match(error.errors[0].message, /Final transfer checkpoint: fixture disk failure/);
    assert.match(error.errors[1].message, /Final Hugging Face checkpoint: fixture disk failure/);
    assert.match(error.errors[2].message, /Router mapping removal: Router mapping removal failed after 2 attempts/);
    assert.equal(error.errors[2].cause instanceof AggregateError, true);
    assert.equal(error.errors[2].cause.errors.length, 2);
    return true;
  });
});

test('the final Hugging Face checkpoint follows cancellation and drain in the app shutdown sequence', () => {
  const source = fs.readFileSync(new URL('../src/main/index.js', import.meta.url), 'utf8');
  const before = source.indexOf("cleanup.attempt('Pre-cancellation Hugging Face checkpoint'");
  const cancel = source.indexOf("cleanup.attempt('Hugging Face download cancellation'");
  const drain = source.indexOf("cleanup.attempt('Hugging Face download drain'");
  const final = source.indexOf("cleanup.attempt('Final Hugging Face checkpoint'");
  assert.ok(before >= 0 && before < cancel);
  assert.ok(cancel < drain && drain < final);
});

test('a successful router cleanup retry does not make shutdown fail', async () => {
  const cleanup = new ShutdownCleanup();
  let attempts = 0;
  assert.equal(await cleanup.retry('Router mapping removal', async () => {
    attempts++;
    if (attempts === 1) throw new Error('transient router failure');
  }), true);
  assert.equal(attempts, 2);
  assert.doesNotThrow(() => cleanup.throwIfFailed());
});

test('completed app cleanup exits directly instead of re-entering the cancelled native quit', () => {
  const source = fs.readFileSync(new URL('../src/main/index.js', import.meta.url), 'utf8');
  const start = source.indexOf('function gracefulShutdown(');
  const end = source.indexOf('function finishGracefulShutdown(', start);
  const shutdown = source.slice(start, end);
  assert.ok(shutdown.indexOf('cleanup.throwIfFailed();') < shutdown.indexOf('app.exit(shutdownExitCode);'));
  assert.doesNotMatch(shutdown, /else app\.quit\(\)/);
});
