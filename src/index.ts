import ivm from 'isolated-vm';
const isolate = new ivm.Isolate;
const context = isolate.createContextSync();
const jail = context.global;
jail.setSync('global', jail.derefInto());

export enum EvalMode {
  ASYNC = '',
  SYNC = 'Sync',
  IGNORED = 'Ignored',
  SYNC_PROMISE = 'SyncPromise',
}

export enum TransferMode {
  COPY = 'copy',
  REFERENCE = 'reference',
  EXTERNAL_COPY = 'externalCopy',
}

export interface ApplyMode {
  eval?: EvalMode,
  argTransfer?: TransferMode,
  resultTransfer?: TransferMode,
}

const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;

function register(
  path: string,
  handler: Function,
  mode?: ApplyMode
) {
  mode = { eval: EvalMode.SYNC, argTransfer: TransferMode.COPY, resultTransfer: TransferMode.COPY, ...mode };
  if (mode.eval === EvalMode.SYNC && handler instanceof AsyncFunction) {
     mode.eval = EvalMode.SYNC_PROMISE;
  }
  let resultMode: string = '';
  if (mode.eval !== EvalMode.SYNC_PROMISE) {
    resultMode = `result: { ${mode.resultTransfer}: true },`;
  }
  context.evalClosureSync(`global.${path} = function(...args) {
    return $0.apply${mode.eval}(
      undefined,
      args,
      {
        arguments: { ${mode.argTransfer}: true },
        ${resultMode}
      },
    );
  }`, [handler], { arguments: { reference: true } });
}

register('Date.now', async () => {
  console.log('Date.now activity started');
  await new Promise((resolve) => setTimeout(resolve, 200));
  return 123;
});
register('Math.random', () => .456);
register('console.log', async (...args: unknown[]) => {
  console.log('console.log activity started');
  await new Promise((resolve) => setTimeout(resolve, 200));
  console.log(...args);
}, { eval: EvalMode.IGNORED });

const timeoutIdsToTimeouts: Map<number, NodeJS.Timer> = new Map();
let lastTimeoutId = 0;

register('setTimeout', async (
  callback: ivm.Reference<Function>,
  msRef: ivm.Reference<number>,
  ...args: ivm.Reference<any>[]
) => {
  console.log('setTimeout activity started');
  const ms = msRef.copySync(); // Copy sync since the isolate executes setTimeout with EvalMode.SYNC
  await new Promise((resolve) => setTimeout(resolve, 200));
  const timeout = setTimeout(async () => {
    await callback.apply(undefined, args.map((arg) => arg.derefInto()), { arguments: { copy: true } });
  }, ms);
  const timeoutId = ++lastTimeoutId;
  timeoutIdsToTimeouts.set(timeoutId, timeout);
  return timeoutId;
}, {
  eval: EvalMode.SYNC,
  argTransfer: TransferMode.REFERENCE,
  resultTransfer: TransferMode.REFERENCE,
});

register('clearTimeout', (timeoutId: number) => {
  console.log('clearTimeout activity started');
  const timeout = timeoutIdsToTimeouts.get(timeoutId);
  if (timeout === undefined) {
    throw new Error('Invalid timeoutId');
  }
  clearTimeout(timeout);
  timeoutIdsToTimeouts.delete(timeoutId);
});

async function run() {
  const script = await isolate.compileScript(`
    const cb = (a) => void console.log(a);
    setTimeout((x, y) => void x(y), 500, cb, 'hey');
    const timeout = setTimeout((x, y) => void x(y), 500, cb, 'hey');
    clearTimeout(timeout);
    console.log(timeout);
    console.log(Date.now());
    console.log(Math.random());
  `);
  await script.run(context);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
