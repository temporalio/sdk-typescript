import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'ava';
import * as nexus from 'nexus-rpc';
import { TemporalOperationHandler, TemporalOperationResult } from '../workflow-helpers';
import { makeStartContext } from './helpers';

test('TemporalOperationHandler preserves a direct null result', async (t) => {
  const handler = new TemporalOperationHandler<void, string | null>({
    async start() {
      return null;
    },
  });
  t.deepEqual(await handler.start(makeStartContext(), undefined), nexus.HandlerStartOperationResult.sync(null));
});

test('TemporalOperationHandler completes a void result synchronously', async (t) => {
  const handler = new TemporalOperationHandler<void, void>({
    async start() {},
  });
  t.deepEqual(await handler.start(makeStartContext(), undefined), nexus.HandlerStartOperationResult.sync(undefined));
});

test('TemporalOperationHandler preserves explicit results from another loaded copy', async (t) => {
  const filename = require.resolve('../workflow-helpers');
  const loaded = { exports: {} as typeof import('../workflow-helpers') };
  runInNewContext(
    readFileSync(filename, 'utf8'),
    { exports: loaded.exports, module: loaded, require: createRequire(filename) },
    { filename }
  );
  const otherResult = loaded.exports.TemporalOperationResult;
  t.not(otherResult, TemporalOperationResult);

  const payload = { token: 'ordinary payload field', isAsync: true };
  const asyncToken = 'operation-token';
  const cases = [
    [otherResult.async<typeof payload>(asyncToken), nexus.HandlerStartOperationResult.async(asyncToken)],
    [otherResult.sync(payload), nexus.HandlerStartOperationResult.sync(payload)],
    [payload, nexus.HandlerStartOperationResult.sync(payload)],
  ] as const;

  for (const [result, expected] of cases) {
    const handler = new TemporalOperationHandler<void, typeof payload>({ start: async () => result });
    t.deepEqual(await handler.start(makeStartContext(), undefined), expected);
  }
});
