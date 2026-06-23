import test from 'ava';
import { coresdk } from '@temporalio/proto';
import type { Payload } from '../interfaces';
import {
  boundTransform,
  drain,
  visitWorkflowActivation,
  visitWorkflowActivationCompletion,
  type PayloadTransform,
} from '../internal-non-workflow/payload-visitor';

// Lets the event loop run every async step that is currently ready: `setImmediate` fires only after
// the microtask queue drains, so one `await tick()` advances all pending transforms to their next
// `await`. Deterministic alternative to setTimeout.
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// A one-shot gate. A transform `await`s `gate.wait()` to park mid-run; the test calls `gate.open()`
// to let every parked transform continue at once. This holds work in flight on demand so a test can
// observe how many transforms ran concurrently, without relying on timing.
const createGate = (): { wait: () => Promise<void>; open: () => void } => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait: () => opened, open };
};

// Never resolves; rejects only when the signal aborts. Lets a transform "run until cancelled"
// without a timer that would hang the test if the abort were not wired up.
const untilAborted = (signal: AbortSignal): Promise<never> =>
  new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

const payload = (data: string): Payload => ({ data: new TextEncoder().encode(data) });
const read = (p: Payload): string => new TextDecoder().decode(p.data ?? new Uint8Array());

test('boundTransform caps the number of in-flight calls', async (t) => {
  let active = 0;
  let maxActive = 0;
  const gate = createGate();
  const bounded = boundTransform(
    async (payloads) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await gate.wait();
      active -= 1;
      return payloads;
    },
    2,
    new AbortController()
  );

  const calls = Array.from({ length: 6 }, () => bounded([payload('x')]));
  await tick(); // let every call that can acquire a permit start
  t.is(maxActive, 2);

  gate.open();
  await drain(calls);
  t.is(maxActive, 2, 'never exceeded the limit as the queued calls drained');
});

test('boundTransform with concurrency 1 runs calls one at a time, in launch order', async (t) => {
  const order: string[] = [];
  let active = 0;
  let maxActive = 0;
  const bounded = boundTransform(
    async (payloads) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await tick(); // a broken limit would let a sibling interleave during this yield
      order.push(read(payloads[0]!));
      active -= 1;
      return payloads;
    },
    1,
    new AbortController()
  );

  await drain(['a', 'b', 'c'].map((tag) => bounded([payload(tag)])));
  t.is(maxActive, 1);
  t.deepEqual(order, ['a', 'b', 'c']);
});

test('drain applies each writeback once its transform resolves', async (t) => {
  const message: { result: Payload; arguments: Payload[] } = {
    result: payload('r'),
    arguments: [payload('x'), payload('y')],
  };
  const bounded = boundTransform(
    async (payloads) => payloads.map((p) => payload(`${read(p)}!`)),
    4,
    new AbortController()
  );

  await drain([
    bounded([message.result]).then(([replacement]) => {
      message.result = replacement!;
    }),
    bounded(message.arguments).then((replacements) => {
      message.arguments = replacements;
    }),
  ]);

  t.is(read(message.result), 'r!');
  t.deepEqual(message.arguments.map(read), ['x!', 'y!']);
});

test('first error is surfaced and not-yet-started transforms are skipped', async (t) => {
  const started: string[] = [];
  const bounded = boundTransform(
    async (payloads) => {
      const tag = read(payloads[0]!);
      started.push(tag);
      await tick();
      if (tag === 'boom') throw new Error('boom');
      return payloads;
    },
    1,
    new AbortController()
  );

  const error = await t.throwsAsync(drain(['ok', 'boom', 'never'].map((tag) => bounded([payload(tag)]))));
  t.is(error?.message, 'boom');
  t.deepEqual(started, ['ok', 'boom'], '"never" is skipped after the failure');
});

test('a failure aborts in-flight siblings instead of waiting them out', async (t) => {
  const settled: string[] = [];
  const bounded = boundTransform(
    async (payloads, signal) => {
      const tag = read(payloads[0]!);
      if (tag === 'boom') {
        await tick();
        throw new Error('boom');
      }
      try {
        await untilAborted(signal!); // settles only if the failure aborts it
        settled.push(tag);
        return payloads;
      } catch (reason) {
        settled.push(`${tag}:aborted`);
        throw reason;
      }
    },
    3,
    new AbortController()
  );

  const error = await t.throwsAsync(drain(['slow1', 'boom', 'slow2'].map((tag) => bounded([payload(tag)]))));
  t.is(error?.message, 'boom');
  t.deepEqual(settled.sort(), ['slow1:aborted', 'slow2:aborted']);
});

const completionWith = (...results: string[]): coresdk.workflow_completion.IWorkflowActivationCompletion => ({
  successful: {
    commands: results.map((r) => ({ completeWorkflowExecution: { result: payload(r) } })),
  },
});

test('visitWorkflowActivationCompletion with an already-aborted signal skips the walk', async (t) => {
  let calls = 0;
  const transform: PayloadTransform = async (payloads) => {
    calls += 1;
    return payloads;
  };

  const error = await t.throwsAsync(
    visitWorkflowActivationCompletion(completionWith('a', 'b'), transform, {
      abortSignal: AbortSignal.abort(new Error('stop')),
    })
  );
  t.is(error?.message, 'stop');
  t.is(calls, 0);
});

// An activation exercising every payload-bearing site shape: repeated lists, singular fields,
// the three map sites (headers / memo / search attributes), a `Payloads`-wrapped field, a oneof,
// and a Failure with a multi-level cause chain.
const richActivation = (): coresdk.workflow_activation.IWorkflowActivation => ({
  jobs: [
    {
      initializeWorkflow: {
        arguments: [payload('arg0'), payload('arg1')],
        headers: { h: payload('hdr') },
        lastCompletionResult: { payloads: [payload('lcr0'), payload('lcr1')] },
        memo: { fields: { m: payload('memo') } },
        searchAttributes: { indexedFields: { s: payload('sa') } },
        continuedFailure: {
          encodedAttributes: payload('cf0'),
          cause: { encodedAttributes: payload('cf1'), cause: { encodedAttributes: payload('cf2') } },
        },
      },
    },
    { resolveActivity: { result: { completed: { result: payload('act') } } } },
    {
      resolveActivity: {
        result: {
          failed: {
            failure: {
              encodedAttributes: payload('fenc'),
              applicationFailureInfo: { details: { payloads: [payload('afi0'), payload('afi1')] } },
            },
          },
        },
      },
    },
    { signalWorkflow: { input: [payload('sig')], headers: { sh: payload('shdr') } } },
  ],
});

const RICH_PAYLOADS = [
  'arg0',
  'arg1',
  'hdr',
  'lcr0',
  'lcr1',
  'memo',
  'sa',
  'cf0',
  'cf1',
  'cf2',
  'act',
  'fenc',
  'afi0',
  'afi1',
  'sig',
  'shdr',
];

test('visits every payload site exactly once and writes back in place', async (t) => {
  const activation = richActivation();

  const seen: string[] = [];
  await visitWorkflowActivation(
    activation,
    async (payloads) => {
      payloads.forEach((p) => seen.push(read(p)));
      return payloads.map((p) => payload(`${read(p)}#`));
    },
    { concurrency: 3 }
  );
  t.deepEqual(seen.slice().sort(), RICH_PAYLOADS.slice().sort(), 'sees every site exactly once');

  // A second walk should observe the first walk's rewrites, proving writeback landed in place
  // at every site (including deep in the cause chain and inside maps).
  const seenAgain: string[] = [];
  await visitWorkflowActivation(activation, async (payloads) => {
    payloads.forEach((p) => seenAgain.push(read(p)));
    return payloads;
  });
  t.deepEqual(
    seenAgain.slice().sort(),
    RICH_PAYLOADS.map((s) => `${s}#`).sort(),
    'in-place rewrites from the first walk are visible to the second'
  );
});

test('an activation with no payloads makes no transform calls and resolves', async (t) => {
  let calls = 0;
  const transform: PayloadTransform = async (payloads) => {
    calls += 1;
    return payloads;
  };

  await visitWorkflowActivation({ jobs: [] }, transform);
  await visitWorkflowActivation({}, transform); // no jobs field at all
  await visitWorkflowActivation(
    {
      // Empty repeated / empty map / a non-payload job variant — none should call the transform.
      jobs: [{ initializeWorkflow: { arguments: [], headers: {} } }, { fireTimer: {} }],
    },
    transform
  );

  t.is(calls, 0);
});

test('a transform that breaks singular cardinality fails loudly', async (t) => {
  const singular = (): coresdk.workflow_activation.IWorkflowActivation => ({
    jobs: [{ resolveActivity: { result: { completed: { result: payload('x') } } } }],
  });

  await t.throwsAsync(
    visitWorkflowActivation(singular(), async () => []),
    { message: /expected 1/ },
    'returning zero payloads for a singular site throws'
  );
  await t.throwsAsync(
    visitWorkflowActivation(singular(), async (payloads) => [...payloads, payload('extra')]),
    { message: /expected 1/ },
    'returning two payloads for a singular site throws'
  );
});

test('a transform that changes a repeated field length fails loudly', async (t) => {
  const withArgs = (): coresdk.workflow_activation.IWorkflowActivation => ({
    jobs: [{ signalWorkflow: { input: [payload('a'), payload('b')] } }],
  });

  await t.throwsAsync(
    visitWorkflowActivation(withArgs(), async (payloads) => payloads.slice(1)),
    { message: /expected 2/ },
    'dropping a payload from a repeated site throws'
  );
  await t.throwsAsync(
    visitWorkflowActivation(withArgs(), async (payloads) => [...payloads, payload('c')]),
    { message: /expected 2/ },
    'adding a payload to a repeated site throws'
  );
});

test('visits completion command payloads: user metadata and a rejected update', async (t) => {
  const completion: coresdk.workflow_completion.IWorkflowActivationCompletion = {
    successful: {
      commands: [
        { userMetadata: { summary: payload('summary'), details: payload('details') } },
        { updateResponse: { rejected: { encodedAttributes: payload('rejection') } } },
      ],
    },
  };

  const seen: string[] = [];
  await visitWorkflowActivationCompletion(completion, async (payloads) => {
    payloads.forEach((p) => seen.push(read(p)));
    return payloads.map((p) => payload(`${read(p)}!`));
  });

  t.deepEqual(seen.slice().sort(), ['details', 'rejection', 'summary']);
  const commands = completion.successful!.commands!;
  t.is(read(commands[0]!.userMetadata!.summary!), 'summary!');
  t.is(read(commands[0]!.userMetadata!.details!), 'details!');
  t.is(read(commands[1]!.updateResponse!.rejected!.encodedAttributes!), 'rejection!');
});

test('walks a decoded protobuf message instance, not just object literals', async (t) => {
  const Type = coresdk.workflow_completion.WorkflowActivationCompletion;
  const decoded = Type.decode(Type.encode(completionWith('a', 'b')).finish());

  await visitWorkflowActivationCompletion(decoded, async (payloads) => payloads.map((p) => payload(`${read(p)}!`)));

  const results = decoded.successful!.commands!.map((c) => read(c.completeWorkflowExecution!.result!));
  t.deepEqual(results, ['a!', 'b!']);
});

test('an identity transform leaves a real message byte-for-byte unchanged', async (t) => {
  const Type = coresdk.workflow_activation.WorkflowActivation;
  const original = Type.encode(richActivation()).finish();
  const decoded = Type.decode(original);

  await visitWorkflowActivation(decoded, async (payloads) => payloads);

  t.deepEqual(Buffer.from(Type.encode(decoded).finish()), Buffer.from(original));
});

test('concurrency caps in-flight transforms across the whole activation', async (t) => {
  const tracked = () => {
    let active = 0;
    let max = 0;
    const gate = createGate();
    const transform: PayloadTransform = async (payloads) => {
      active += 1;
      max = Math.max(max, active);
      await gate.wait();
      active -= 1;
      return payloads;
    };
    return { transform, open: gate.open, max: () => max };
  };

  const capped = tracked();
  const cappedVisit = visitWorkflowActivation(richActivation(), capped.transform, { concurrency: 4 });
  await tick();
  t.is(capped.max(), 4);
  capped.open();
  await cappedVisit;

  const sequential = tracked();
  const sequentialVisit = visitWorkflowActivation(richActivation(), sequential.transform, { concurrency: 1 });
  await tick();
  t.is(sequential.max(), 1);
  sequential.open();
  await sequentialVisit;
});

test('aborting mid-walk rejects and cancels in-flight transforms', async (t) => {
  const controller = new AbortController();
  let aborted = 0;
  const transform: PayloadTransform = async (payloads, signal) => {
    try {
      await untilAborted(signal!); // settles only when the walk is aborted
      return payloads;
    } catch (reason) {
      aborted += 1;
      throw reason;
    }
  };

  const visiting = visitWorkflowActivation(richActivation(), transform, {
    concurrency: 16,
    abortSignal: controller.signal,
  });
  await tick(); // let the transforms start and park on the signal
  controller.abort(new Error('shutdown'));

  const error = await t.throwsAsync(visiting);
  t.is(error?.message, 'shutdown');
  t.true(aborted > 0, 'in-flight transforms received the forwarded abort signal');
});
