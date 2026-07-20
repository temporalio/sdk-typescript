import test from 'ava';
import { coresdk } from '@temporalio/proto';
import { limit } from '../concurrency/limit';
import type { Payload } from '../interfaces';
import {
  visit,
  walkWorkflowActivation,
  walkWorkflowActivationCompletion,
} from '../internal-non-workflow/payload-visitor';

// Lets the event loop run every async step that is currently ready
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// A one-shot gate
const createGate = (): { wait: () => Promise<void>; open: () => void } => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait: () => opened, open };
};

// Never resolves; rejects only when the signal aborts
const untilAborted = (signal: AbortSignal): Promise<never> =>
  new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

const payload = (data: string): Payload => ({ data: new TextEncoder().encode(data) });
const read = (p: Payload): string => new TextDecoder().decode(p.data ?? new Uint8Array());

// Applies the same per-payload function at both the singular and repeated sites, threading context.
const perPayload = <Ctx>(fn: (p: Payload, context: Ctx) => Payload) => ({
  transformPayload: async (p: Payload, context: Ctx) => fn(p, context),
  transformPayloads: async (ps: Payload[], context: Ctx) => ps.map((p) => fn(p, context)),
});

const identity = perPayload<void>((p) => p);

// Transforms that count how many times they are called, across both the singular and repeated sites.
const countingTransforms = () => {
  let calls = 0;
  return {
    transforms: {
      transformPayload: async (p: Payload) => {
        calls += 1;
        return p;
      },
      transformPayloads: async (ps: Payload[]) => {
        calls += 1;
        return ps;
      },
    },
    calls: () => calls,
  };
};

test('a failing transform surfaces its error and aborts in-flight siblings', async (t) => {
  const aborted: string[] = [];
  const activityResult = (data: string): coresdk.workflow_activation.IWorkflowActivationJob => ({
    resolveActivity: { result: { completed: { result: payload(data) } } },
  });
  const activation: coresdk.workflow_activation.IWorkflowActivation = {
    jobs: [activityResult('slow1'), activityResult('boom'), activityResult('slow2')],
  };

  const error = await t.throwsAsync(
    visit(activation, walkWorkflowActivation, {
      transformPayload: async (p, _context, signal) => {
        const tag = read(p);
        if (tag === 'boom') {
          await tick();
          throw new Error('boom');
        }
        try {
          await untilAborted(signal!);
          return p;
        } catch (reason) {
          aborted.push(tag);
          throw reason;
        }
      },
      transformPayloads: async (ps) => ps,
      limit: limit(3),
    })
  );
  t.is(error?.message, 'boom');
  t.deepEqual(aborted.sort(), ['slow1', 'slow2']);
});

test('a transform still waiting on the concurrency limit is skipped once a sibling fails', async (t) => {
  const started: string[] = [];
  const activityResult = (data: string): coresdk.workflow_activation.IWorkflowActivationJob => ({
    resolveActivity: { result: { completed: { result: payload(data) } } },
  });
  // Three payloads through a limit of 1: 'boom' runs first and fails, so 'a' and 'b' are still
  // queued on the permit when the failure lands and must never invoke their transform.
  const activation: coresdk.workflow_activation.IWorkflowActivation = {
    jobs: [activityResult('boom'), activityResult('a'), activityResult('b')],
  };

  const error = await t.throwsAsync(
    visitWorkflowActivation(activation, {
      transformPayload: async (p) => {
        const tag = read(p);
        started.push(tag);
        if (tag === 'boom') throw new Error('boom');
        return p;
      },
      transformPayloads: async (ps) => ps,
      limit: limit(1),
    })
  );
  t.is(error?.message, 'boom');
  t.deepEqual(started, ['boom'], 'only the failing transform ran; queued siblings were skipped');
});

const completionWith = (...results: string[]): coresdk.workflow_completion.IWorkflowActivationCompletion => ({
  successful: {
    commands: results.map((r) => ({ completeWorkflowExecution: { result: payload(r) } })),
  },
});

test('visitWorkflowActivationCompletion with an already-aborted signal skips the walk', async (t) => {
  const counter = countingTransforms();

  const error = await t.throwsAsync(
    visit(completionWith('a', 'b'), walkWorkflowActivationCompletion, {
      ...counter.transforms,
      abortSignal: AbortSignal.abort(new Error('stop')),
    })
  );
  t.is(error?.message, 'stop');
  t.is(counter.calls(), 0);
});

// An activation exercising every payload-bearing site shape: repeated lists, singular fields, the
// three map sites (headers / memo / search attributes), a `Payloads`-wrapped field, a oneof, and a
// Failure with a multi-level cause chain.
const activationWithEveryPayloadSite = (): coresdk.workflow_activation.IWorkflowActivation => ({
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

const EVERY_SITE_PAYLOAD = [
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
  const activation = activationWithEveryPayloadSite();

  const seen: string[] = [];
  await visit(activation, walkWorkflowActivation, {
    ...perPayload<void>((p) => {
      seen.push(read(p));
      return payload(`${read(p)}#`);
    }),
    limit: limit(3),
  });
  t.deepEqual(seen.slice().sort(), EVERY_SITE_PAYLOAD.slice().sort(), 'sees every site exactly once');

  // A second walk should observe the first walk's rewrites, proving writeback landed in place.
  const seenAgain: string[] = [];
  await visit(
    activation,
    walkWorkflowActivation,
    perPayload<void>((p) => {
      seenAgain.push(read(p));
      return p;
    })
  );
  t.deepEqual(
    seenAgain.slice().sort(),
    EVERY_SITE_PAYLOAD.map((s) => `${s}#`).sort(),
    'in-place rewrites from the first walk are visible to the second'
  );
});

test('an activation with no payloads makes no transform calls and resolves', async (t) => {
  const counter = countingTransforms();

  await visit({ jobs: [] }, walkWorkflowActivation, counter.transforms);
  await visit({}, walkWorkflowActivation, counter.transforms);
  await visit(
    { jobs: [{ initializeWorkflow: { arguments: [], headers: {} } }, { fireTimer: {} }] },
    walkWorkflowActivation,
    counter.transforms
  );

  t.is(counter.calls(), 0);
});

test('a repeated field may return any count, including zero', async (t) => {
  const withInput = (): coresdk.workflow_activation.IWorkflowActivation => ({
    jobs: [{ signalWorkflow: { input: [payload('a'), payload('b')] } }],
  });

  const emptied = withInput();
  await visit(emptied, walkWorkflowActivation, { ...identity, transformPayloads: async () => [] });
  t.deepEqual(emptied.jobs![0]!.signalWorkflow!.input, [], 'a repeated list can be emptied');

  const reframed = withInput();
  await visit(reframed, walkWorkflowActivation, { ...identity, transformPayloads: async () => [payload('merged')] });
  t.deepEqual(reframed.jobs![0]!.signalWorkflow!.input!.map(read), ['merged'], 'count may shrink');
});

test('context is derived per message and isolated across sibling jobs', async (t) => {
  const activation: coresdk.workflow_activation.IWorkflowActivation = {
    jobs: [{ signalWorkflow: { input: [payload('sig')] } }, { initializeWorkflow: { arguments: [payload('arg')] } }],
  };

  const seen: Record<string, string> = {};
  await visit(activation, walkWorkflowActivation, {
    initialContext: 'root',
    deriveContext: (_message, typeName, context) =>
      typeName === 'coresdk.workflow_activation.SignalWorkflow'
        ? 'signal'
        : typeName === 'coresdk.workflow_activation.InitializeWorkflow'
          ? 'init'
          : context,
    ...perPayload<string>((p, context) => {
      seen[read(p)] = context;
      return p;
    }),
  });

  t.deepEqual(seen, { sig: 'signal', arg: 'init' });
});

test('skipHeaders and skipSearchAttributes omit those sites', async (t) => {
  const activation: coresdk.workflow_activation.IWorkflowActivation = {
    jobs: [
      {
        initializeWorkflow: {
          arguments: [payload('arg')],
          headers: { h: payload('hdr') },
          searchAttributes: { indexedFields: { s: payload('sa') } },
        },
      },
    ],
  };

  const seen: string[] = [];
  await visit(activation, walkWorkflowActivation, {
    ...perPayload<void>((p) => {
      seen.push(read(p));
      return p;
    }),
    skipHeaders: true,
    skipSearchAttributes: true,
  });

  t.deepEqual(seen, ['arg'], 'headers and search attributes are not visited');
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
  await visit(
    completion,
    walkWorkflowActivationCompletion,
    perPayload<void>((p) => {
      seen.push(read(p));
      return payload(`${read(p)}!`);
    })
  );

  t.deepEqual(seen.slice().sort(), ['details', 'rejection', 'summary']);
  const commands = completion.successful!.commands!;
  t.is(read(commands[0]!.userMetadata!.summary!), 'summary!');
  t.is(read(commands[0]!.userMetadata!.details!), 'details!');
  t.is(read(commands[1]!.updateResponse!.rejected!.encodedAttributes!), 'rejection!');
});

test('walks a decoded protobuf message instance, not just object literals', async (t) => {
  const Type = coresdk.workflow_completion.WorkflowActivationCompletion;
  const decoded = Type.decode(Type.encode(completionWith('a', 'b')).finish());

  await visit(
    decoded,
    walkWorkflowActivationCompletion,
    perPayload<void>((p) => payload(`${read(p)}!`))
  );

  const results = decoded.successful!.commands!.map((c) => read(c.completeWorkflowExecution!.result!));
  t.deepEqual(results, ['a!', 'b!']);
});

test('an identity transform leaves a real message byte-for-byte unchanged', async (t) => {
  const Type = coresdk.workflow_activation.WorkflowActivation;
  const original = Type.encode(activationWithEveryPayloadSite()).finish();
  const decoded = Type.decode(original);

  await visit(decoded, walkWorkflowActivation, identity);

  t.deepEqual(Buffer.from(Type.encode(decoded).finish()), Buffer.from(original));
});

test('a concurrency limit caps in-flight transforms across the whole activation', async (t) => {
  const tracked = () => {
    let active = 0;
    let max = 0;
    const gate = createGate();
    const enter = () => {
      active += 1;
      max = Math.max(max, active);
    };
    const leave = () => {
      active -= 1;
    };
    return {
      transforms: {
        transformPayload: async (p: Payload) => {
          enter();
          await gate.wait();
          leave();
          return p;
        },
        transformPayloads: async (ps: Payload[]) => {
          enter();
          await gate.wait();
          leave();
          return ps;
        },
      },
      open: gate.open,
      max: () => max,
    };
  };

  const capped = tracked();
  const cappedVisit = visit(activationWithEveryPayloadSite(), walkWorkflowActivation, {
    ...capped.transforms,
    limit: limit(4),
  });
  await tick();
  t.is(capped.max(), 4);
  capped.open();
  await cappedVisit;

  const sequential = tracked();
  const sequentialVisit = visit(activationWithEveryPayloadSite(), walkWorkflowActivation, {
    ...sequential.transforms,
    limit: limit(1),
  });
  await tick();
  t.is(sequential.max(), 1);
  sequential.open();
  await sequentialVisit;
});

test('aborting mid-walk rejects and cancels in-flight transforms', async (t) => {
  const controller = new AbortController();
  let aborted = 0;
  const waitThenAbort = async <T>(value: T, signal: AbortSignal | undefined): Promise<T> => {
    try {
      await untilAborted(signal!);
      return value;
    } catch (reason) {
      aborted += 1;
      throw reason;
    }
  };

  const visiting = visit(activationWithEveryPayloadSite(), walkWorkflowActivation, {
    transformPayload: (p, _context, signal) => waitThenAbort(p, signal),
    transformPayloads: (ps, _context, signal) => waitThenAbort(ps, signal),
    limit: limit(16),
    abortSignal: controller.signal,
  });
  await tick();
  controller.abort(new Error('shutdown'));

  const error = await t.throwsAsync(visiting);
  t.is(error?.message, 'shutdown');
  t.true(aborted > 0, 'in-flight transforms received the forwarded abort signal');
});
