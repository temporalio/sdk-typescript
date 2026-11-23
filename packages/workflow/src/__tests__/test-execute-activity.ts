import test from 'ava';
import { createActivityReference } from '../activity-reference';
import { InvalidActivityReferenceError } from '../errors';
import { executeActivity, executeLocalActivity } from '../execute-activity';
import { setActivator } from '../global-attributes';
import { Activator } from '../internals';
import type { WorkflowCreateOptionsInternal, WorkflowInfo } from '../interfaces';
import { proxyActivities, proxyLocalActivities } from '../workflow';

function makeActivator(): Activator {
  return new Activator({
    info: {
      namespace: 'default',
      workflowId: 'workflow',
      workflowType: 'test',
      taskQueue: 'test',
      unsafe: { isReplaying: false },
    } as WorkflowInfo,
    randomnessSeed: [1],
    now: 0,
    showStackTraceSources: false,
    sourceMap: {} as WorkflowCreateOptionsInternal['sourceMap'],
    registeredActivityNames: new Set(['echo']),
    getTimeOfDay: () => 0n,
    stackTracesEnabled: false,
  });
}

test.serial('reference stubs are functions that reject direct calls', (t) => {
  const reference = createActivityReference('echo');
  t.is(typeof reference, 'function');
  t.throws(() => reference('hello'), {
    instanceOf: InvalidActivityReferenceError,
    message: /cannot be called directly.*Mark the Activity import.*Workflow Task/s,
  });
});

for (const execute of [executeActivity, executeLocalActivity] as (typeof executeActivity)[]) {
  test.serial(`${execute.name} rejects untransformed functions without invoking them`, (t) => {
    let invoked = false;
    const implementation = async () => {
      invoked = true;
    };
    t.throws(() => execute(implementation, { startToCloseTimeout: '1m' }), {
      instanceOf: InvalidActivityReferenceError,
      message: /with \{ temporal: 'activity' \}.*Deploy corrected workflow code/s,
    });
    t.false(invoked);
  });
}

for (const local of [false, true]) {
  test.serial(`${local ? 'Local Activity' : 'Activity'} scheduling inputs match proxies`, (t) => {
    const options = { startToCloseTimeout: '1m' as const, retry: { maximumAttempts: 2 } };
    const reference = createActivityReference('echo') as (s: string) => Promise<string>;
    function schedulingInput(useProxy: boolean): unknown {
      const activator = makeActivator();
      let observed: unknown;
      activator.interceptors.outbound.push({
        scheduleActivity: async (input) => {
          observed = input;
        },
        scheduleLocalActivity: async (input) => {
          observed = input;
        },
      });
      setActivator(activator);
      try {
        if (useProxy) {
          const proxy = local
            ? proxyLocalActivities<{ echo: typeof reference }>(options)
            : proxyActivities<{ echo: typeof reference }>(options);
          void proxy.echo('hello');
        } else {
          const execute = (local ? executeLocalActivity : executeActivity) as typeof executeActivity;
          void execute(reference, { ...options, args: ['hello'] });
        }
        t.truthy(observed);
        return observed;
      } finally {
        setActivator(undefined);
      }
    }
    t.deepEqual(schedulingInput(false), schedulingInput(true));
  });
}

test.serial('name-based calls forward explicit serialization metadata to interceptors', async (t) => {
  const activator = makeActivator();
  const metadata = {
    inputTypes: [{ payloadConverterHint: { converter: 'test' } }],
    outputType: { payloadConverterHint: { converter: 'test' } },
  };
  activator.interceptors.outbound.push({
    scheduleActivity: async (input) => {
      t.is(input.activityType, 'customEcho');
      t.deepEqual(input.args, ['hello']);
      t.is(input.typeInfo, metadata);
      t.false('typeInfo' in input.options);
      return 'result';
    },
  });
  setActivator(activator);
  try {
    t.is(
      await executeActivity<(s: string) => Promise<string>>('customEcho', {
        args: ['hello'],
        startToCloseTimeout: '1m',
        typeInfo: metadata,
      }),
      'result'
    );
  } finally {
    setActivator(undefined);
  }
});

test.serial('reference misuse fails a Workflow Task by default', (t) => {
  const activator = makeActivator();
  const error = t.throws(() => createActivityReference('echo')(), { instanceOf: InvalidActivityReferenceError })!;
  activator.handleWorkflowFailure(error);
  t.is(activator.workflowTaskError, error);
  t.deepEqual(activator.concludeActivation().commands, []);
  t.false(activator.completed);
});

test.serial('reference misuse honors configured workflow failure exception types', (t) => {
  const activator = makeActivator();
  activator.failureExceptionTypeNames = ['Error'];
  const error = t.throws(() => createActivityReference('echo')(), { instanceOf: InvalidActivityReferenceError })!;
  activator.handleWorkflowFailure(error);
  t.is(activator.workflowTaskError, undefined);
  t.truthy(activator.concludeActivation().commands[0]?.failWorkflowExecution);
  t.true(activator.completed);
});

// Compile-time contract. Not invoked: references require a workflow execution context.
function typeChecks(
  echo: (s: string) => Promise<string>,
  optional: (s?: string) => Promise<void>,
  rest: (...s: string[]) => Promise<number>
): void {
  const result: Promise<string> = executeActivity(echo, { args: ['hello'], startToCloseTimeout: '1m' });
  void result;
  void executeActivity(echo, { args: ['hello'] as const, startToCloseTimeout: '1m' });
  void executeActivity(optional, { startToCloseTimeout: '1m' });
  void executeActivity(rest, { args: ['one', 'two'], startToCloseTimeout: '1m' });
  void executeActivity<typeof echo>('customEcho', { args: ['hello'], startToCloseTimeout: '1m' });
  // @ts-expect-error required arguments cannot be omitted
  void executeActivity(echo, { startToCloseTimeout: '1m' });
  // @ts-expect-error arguments must match the imported function
  void executeActivity(echo, { args: [1], startToCloseTimeout: '1m' });
  // @ts-expect-error typed string calls also validate arguments
  void executeActivity<typeof echo>('customEcho', { args: [1], startToCloseTimeout: '1m' });
  // @ts-expect-error Local Activities do not accept a task queue
  void executeLocalActivity(echo, { args: ['hello'], taskQueue: 'other', startToCloseTimeout: '1m' });
}
void typeChecks;
