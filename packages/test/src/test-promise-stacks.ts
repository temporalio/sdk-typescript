import vm from 'node:vm';
import type { TestFn } from 'ava';
import anyTest from 'ava';
import type { Activator } from '@temporalio/workflow/lib/internals';
import { GlobalHandlers } from '@temporalio/worker/lib/workflow/vm-shared';
import { isBun } from './helpers';

interface Context {
  handlers: GlobalHandlers;
  sandbox: vm.Context;
  store: Activator['promiseStackStore'];
  sourceMapLookups: number;
}

const test = anyTest as TestFn<Context>;
// Bun does not implement V8 promise hooks. These hooks also require serial tests within this process.
const testWithPromiseHooks = isBun ? test.serial.skip : test.serial;
const filename = 'promise-stack-test.js';

test.beforeEach(async (t) => {
  const handlers = new GlobalHandlers();
  const store: Activator['promiseStackStore'] = { promiseToStack: new Map(), childToParent: new Map() };
  const sandbox = vm.createContext({ __TEMPORAL_ACTIVATOR__: { info: { runId: t.title }, promiseStackStore: store } });
  t.context = { handlers, store, sandbox, sourceMapLookups: 0 };
  await handlers.addWorkflowBundle({
    code: '',
    filename,
    sourceMap: {
      version: 3,
      file: filename,
      sources: ['workflow.ts'],
      names: ['waiting'],
      mappings: 'AAAAA',
      sourcesContent: ['const pending = new Promise(() => {});'],
    },
  });
  const consumer = handlers.bundleFilenameToSourceMapConsumer.get(filename)!;
  const originalPositionFor = consumer.originalPositionFor.bind(consumer);
  consumer.originalPositionFor = (position) => {
    t.context.sourceMapLookups++;
    return originalPositionFor(position);
  };
  handlers.install();
});

test.afterEach.always((t) => {
  t.context.handlers.uninstall();
});

for (const firstRead of ['formatted', 'structured'] as const) {
  testWithPromiseHooks(
    `promise stacks defer source maps until reading ${firstRead} and cache both diagnostics`,
    (t) => {
      const { sandbox, store } = t.context;
      const pending = vm.runInContext('new Promise(() => {})', sandbox, { filename }) as Promise<unknown>;
      vm.runInContext('Promise.resolve()', sandbox, { filename });
      t.is(store.promiseToStack.size, 1);
      t.is(t.context.sourceMapLookups, 0);

      const stack = store.promiseToStack.get(pending)!;
      t.truthy(stack[firstRead]);
      const lookups = t.context.sourceMapLookups;
      t.true(lookups > 0);
      t.regex(stack.formatted, /at waiting \(workflow\.ts:1:0\)/);
      t.deepEqual(
        stack.structured.find((location) => location.file_path === 'workflow.ts'),
        {
          file_path: 'workflow.ts',
          function_name: 'waiting',
          line: 1,
          column: 0,
          internal_code: false,
        }
      );
      t.false(stack.formatted.includes('node:internal/promise_hooks'));
      t.false(stack.structured.some((location) => location.file_path === 'node:internal/promise_hooks'));
      t.is(t.context.sourceMapLookups, lookups);
    }
  );
}

for (const aggregator of ['race', 'all', 'allSettled', 'any']) {
  testWithPromiseHooks(`Promise.${aggregator} keeps both parents without formatting internal promises`, (t) => {
    const { sandbox, store } = t.context;
    const { first, second, aggregate } = vm.runInContext(
      `const first = new Promise(() => {});
       const second = new Promise(() => {});
       const aggregate = Promise.${aggregator}([first, second]);
       ({ first, second, aggregate });`,
      sandbox,
      { filename }
    ) as Record<'first' | 'second' | 'aggregate', Promise<unknown>>;

    t.deepEqual(store.childToParent.get(aggregate), new Set([first, second]));
    t.deepEqual(new Set(store.promiseToStack.keys()), new Set([first, second, aggregate]));
    t.is(t.context.sourceMapLookups, 0);
  });
}

testWithPromiseHooks('a user-defined Promise.all is not treated as a native aggregator', (t) => {
  const { sandbox, store } = t.context;
  const aggregate = vm.runInContext(
    `const NativePromise = globalThis.Promise;
     class Promise {
       static async all(first, second) {
         first.then(() => {});
         second.then(() => {});
         await new NativePromise(() => {});
       }
     }
     const first = new NativePromise(() => {});
     const second = new NativePromise(() => {});
     Promise.all(first, second);`,
    sandbox,
    { filename }
  ) as Promise<unknown>;

  t.deepEqual(store.childToParent.get(aggregate), new Set());
  t.is(t.context.sourceMapLookups, 0);
});

testWithPromiseHooks('settled promises leave the stack store without source-map lookups', (t) => {
  const { sandbox, store } = t.context;
  vm.runInContext(
    'globalThis.resolve = undefined; new Promise((resolve) => { globalThis.resolve = resolve; });',
    sandbox,
    {
      filename,
    }
  );
  t.is(store.promiseToStack.size, 1);
  vm.runInContext('resolve()', sandbox, { filename });
  t.is(store.promiseToStack.size, 0);
  t.is(store.childToParent.size, 0);
  t.is(t.context.sourceMapLookups, 0);
});

testWithPromiseHooks(
  'ordinary errors still format immediately and delegate host errors to the original formatter',
  (t) => {
    const { sandbox, handlers } = t.context;
    const stack = vm.runInContext('new Error("workflow error").stack', sandbox, { filename }) as string;
    t.regex(stack, /^Error: workflow error\n/);
    t.regex(stack, /at waiting \(workflow\.ts:1:0\)/);
    t.true(t.context.sourceMapLookups > 0);

    const original = handlers.origPrepareStackTrace;
    try {
      handlers.origPrepareStackTrace = (error) => `custom host stack: ${error.message}`;
      t.is(new Error('host error').stack, 'custom host stack: host error');
    } finally {
      handlers.origPrepareStackTrace = original;
    }
  }
);

testWithPromiseHooks('a VM timeout during promise stack capture does not corrupt later error stacks', (t) => {
  const { sandbox, store } = t.context;
  const error = t.throws(() =>
    vm.runInContext(
      `globalThis.OriginalError = Error;
       globalThis.Error = class extends OriginalError {
         constructor() {
           super();
           Object.defineProperty(this, 'stack', { get() { while (true) {} } });
         }
       };
       new Promise(() => {});`,
      sandbox,
      { filename, timeout: 50 }
    )
  );
  t.is((error as NodeJS.ErrnoException).code, 'ERR_SCRIPT_EXECUTION_TIMEOUT');
  t.regex(error!.stack!, /^Error: Script execution timed out/);
  t.regex(new Error('after timeout').stack!, /^Error: after timeout\n/);

  const stack = vm.runInContext('globalThis.Error = OriginalError; new Error("recovered").stack', sandbox, {
    filename,
  }) as string;
  t.regex(stack, /^Error: recovered\n/);
  t.regex(stack, /at waiting \(workflow\.ts:1:0\)/);
  const pending = vm.runInContext('new Promise(() => {})', sandbox, { filename }) as Promise<unknown>;
  t.regex(store.promiseToStack.get(pending)!.formatted, /at waiting \(workflow\.ts:1:0\)/);
});
