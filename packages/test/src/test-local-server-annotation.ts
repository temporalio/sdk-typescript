import test from 'ava';
import type { TestFn } from 'ava';
import { requiresLocalServer } from '@temporalio/test-helpers';
import { makeDefaultTestContextFunction } from './helpers-integration';

function makeFakeTest(registrations: string[], hooks: string[]): TestFn<unknown> {
  const register = ((title: string) => registrations.push(title)) as any;
  register.skip = ((title: string) => registrations.push(`skip:${title}`)) as any;

  const before = (() => hooks.push('before')) as any;
  before.skip = (() => hooks.push('before.skip')) as any;
  const beforeEach = (() => hooks.push('beforeEach')) as any;
  beforeEach.skip = (() => hooks.push('beforeEach.skip')) as any;
  const after = (() => hooks.push('after')) as any;
  after.skip = (() => hooks.push('after.skip')) as any;
  after.always = (() => hooks.push('after.always')) as any;
  after.always.skip = (() => hooks.push('after.always.skip')) as any;
  const afterEach = (() => hooks.push('afterEach')) as any;
  afterEach.skip = (() => hooks.push('afterEach.skip')) as any;
  afterEach.always = (() => hooks.push('afterEach.always')) as any;
  afterEach.always.skip = (() => hooks.push('afterEach.always.skip')) as any;

  register.before = before;
  register.after = after;
  register.beforeEach = beforeEach;
  register.afterEach = afterEach;
  register.serial = register;
  register.failing = register;
  register.only = register;
  register.todo = () => undefined;
  register.macro = () => undefined;
  register.meta = {};
  return register;
}

test.serial('requiresLocalServer passes through when envconfig is disabled', (t) => {
  const previous = process.env.TEMPORAL_TEST_ENV_CONFIG_SERVER;
  t.teardown(() => {
    if (previous === undefined) delete process.env.TEMPORAL_TEST_ENV_CONFIG_SERVER;
    else process.env.TEMPORAL_TEST_ENV_CONFIG_SERVER = previous;
  });
  delete process.env.TEMPORAL_TEST_ENV_CONFIG_SERVER;

  const base = makeFakeTest([], []);
  t.is(requiresLocalServer('starts an ephemeral server', base), base);
});

test.serial('requiresLocalServer skips tests and hooks in envconfig mode', (t) => {
  const previous = process.env.TEMPORAL_TEST_ENV_CONFIG_SERVER;
  t.teardown(() => {
    if (previous === undefined) delete process.env.TEMPORAL_TEST_ENV_CONFIG_SERVER;
    else process.env.TEMPORAL_TEST_ENV_CONFIG_SERVER = previous;
  });
  process.env.TEMPORAL_TEST_ENV_CONFIG_SERVER = 'true';

  const registrations: string[] = [];
  const hooks: string[] = [];
  const localOnly = requiresLocalServer('starts an ephemeral server', makeFakeTest(registrations, hooks));
  localOnly('regular test', () => undefined);
  localOnly.serial('serial test', () => undefined);
  localOnly.before(() => undefined);
  localOnly.after.always(() => undefined);

  t.deepEqual(registrations, [
    'skip:regular test (requires local server: starts an ephemeral server)',
    'skip:serial test (requires local server: starts an ephemeral server)',
  ]);
  t.deepEqual(hooks, ['before.skip', 'after.always.skip']);
});

test.serial('requiresLocalServer requires a reason', (t) => {
  t.throws(() => requiresLocalServer(''), {
    instanceOf: TypeError,
    message: 'A non-empty reason is required for a local-server-only test',
  });
});

test.serial('envconfig rejects local server options before creating an environment', async (t) => {
  const previous = process.env.TEMPORAL_TEST_ENV_CONFIG_SERVER;
  t.teardown(() => {
    if (previous === undefined) delete process.env.TEMPORAL_TEST_ENV_CONFIG_SERVER;
    else process.env.TEMPORAL_TEST_ENV_CONFIG_SERVER = previous;
  });
  process.env.TEMPORAL_TEST_ENV_CONFIG_SERVER = 'true';

  const createContext = makeDefaultTestContextFunction({
    workflowsPath: __filename,
    workflowEnvironmentOpts: { server: { extraArgs: ['--dynamic-config-value', 'test.value=true'] } },
  });
  const error = await t.throwsAsync(createContext({} as any));
  t.regex(error!.message, /workflowEnvironmentOpts\.server cannot be used/);
});
