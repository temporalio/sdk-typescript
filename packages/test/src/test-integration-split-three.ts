import path from 'node:path';
import v8 from 'node:v8';
import { readFileSync } from 'node:fs';
import pkg from '@temporalio/worker/lib/pkg';
import { bundleWorkflowCode } from '@temporalio/worker';
import { configMacro, makeTestFn } from './configured-integration-helpers';
import { configurableHelpers } from './helpers-integration';
import { withZeroesHTTPServer } from './zeroes-http-server';
import * as activities from './activities';
import { cleanOptionalStackTrace } from './helpers';
import * as workflows from './workflows';

const test = makeTestFn(() => bundleWorkflowCode({ workflowsPath: require.resolve('./workflows') }));
test.macro(configMacro);

test('cancel-http-request', configMacro, async (t, config) => {
  const { env, createWorkerWithDefaults } = config;
  const { executeWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
  const worker = await createWorkerWithDefaults(t, { activities });
  await withZeroesHTTPServer(async (port) => {
    const url = `http://127.0.0.1:${port}`;
    await worker.runUntil(
      executeWorkflow(workflows.cancellableHTTPRequest, {
        args: [url],
      })
    );
  });
  t.pass();
});

// TODO(thomas): fix
if ('promiseHooks' in v8) {
  // Skip in old node versions
  test('Stack trace query returns stack that makes sense', configMacro, async (t, config) => {
    const { env, createWorkerWithDefaults } = config;
    const { executeWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
    const worker = await createWorkerWithDefaults(t, { activities });
    const rawStacks = await worker.runUntil(executeWorkflow(workflows.stackTracer));

    const [stack1, stack2] = rawStacks.map((r) =>
      r
        .split('\n\n')
        .map((s) => cleanOptionalStackTrace(`\n${s}`))
        .join('\n')
    );
    // Can't get the Trigger stack cleaned, this is okay for now
    // NOTE: we check endsWith because under certain conditions we might see Promise.race in the trace
    t.true(
      stack1.endsWith(
        `
    at Function.all (<anonymous>)
    at stackTracer (test/src/workflows/stack-tracer.ts)

    at stackTracer (test/src/workflows/stack-tracer.ts)

    at Promise.then (<anonymous>)
    at Trigger.then (workflow/src/trigger.ts)`
      ),
      `Got invalid stack:\n--- clean ---\n${stack1}\n--- raw ---\n${rawStacks[0]}`
    );

    t.is(
      stack2,
      `
    at executeChild (workflow/src/workflow.ts)
    at stackTracer (test/src/workflows/stack-tracer.ts)

    at new Promise (<anonymous>)
    at timerNextHandler (workflow/src/workflow.ts)
    at sleep (workflow/src/workflow.ts)
    at stackTracer (test/src/workflows/stack-tracer.ts)

    at stackTracer (test/src/workflows/stack-tracer.ts)`
    );
  });

  test('Enhanced stack trace returns trace that makes sense', configMacro, async (t, config) => {
    const { env, createWorkerWithDefaults } = config;

    const { executeWorkflow } = configurableHelpers(t, t.context.workflowBundle, env);
    const worker = await createWorkerWithDefaults(t, { activities });
    const enhancedStack = await worker.runUntil(executeWorkflow(workflows.enhancedStackTracer));

    const stacks = enhancedStack.stacks.map((s) => ({
      locations: s.locations.map((l) => ({
        ...l,
        ...(l.file_path
          ? { file_path: l.file_path.replace(path.resolve(__dirname, '../../../'), '').replace(/\\/g, '/') }
          : undefined),
      })),
    }));
    t.is(enhancedStack.sdk.name, 'typescript');
    t.is(enhancedStack.sdk.version, pkg.version); // Expect workflow and worker versions to match
    t.deepEqual(stacks, [
      {
        locations: [
          {
            function_name: 'Function.all',
            internal_code: false,
          },
          {
            file_path: '/packages/test/src/workflows/stack-tracer.ts',
            function_name: 'enhancedStackTracer',
            line: 32,
            column: 35,
            internal_code: false,
          },
        ],
      },
      {
        locations: [
          {
            file_path: '/packages/test/src/workflows/stack-tracer.ts',
            function_name: 'enhancedStackTracer',
            line: 32,
            column: 35,
            internal_code: false,
          },
        ],
      },
      {
        locations: [
          {
            function_name: 'Promise.then',
            internal_code: false,
          },
          {
            file_path: '/packages/workflow/src/trigger.ts',
            function_name: 'Trigger.then',
            line: 47,
            column: 24,
            internal_code: false,
          },
        ],
      },
    ]);
    const expectedSources = ['../src/workflows/stack-tracer.ts', '../../workflow/src/trigger.ts'].map((p) => [
      path.resolve(__dirname, p),
      [{ content: readFileSync(path.resolve(__dirname, p), 'utf8'), line_offset: 0 }],
    ]);
    t.deepEqual(Object.entries(enhancedStack.sources), expectedSources);
  });
}
