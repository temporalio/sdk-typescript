import { spawnSync } from 'node:child_process';
import test from 'ava';
import { bundleWorkflowCode, DefaultLogger } from '@temporalio/worker';
import { parseWorkflowCode } from '@temporalio/worker/internal';

test('VM-less source maps preserve the original throw location with Node source maps enabled', async (t) => {
  const bundle = parseWorkflowCode(
    (
      await bundleWorkflowCode({
        workflowsPath: require.resolve('./workflows/vmless-source-map'),
        workflowExecutionMode: 'vmless',
        logger: new DefaultLogger('ERROR'),
      })
    ).code
  );
  const child = spawnSync(process.execPath, ['--enable-source-maps', require.resolve('./vmless-process')], {
    input: JSON.stringify({
      bundle,
      scenario: 'mappedFailure',
      options: {
        info: { runId: 'test', workflowId: 'test', namespace: 'default', unsafe: {} },
        now: 1000,
        randomnessSeed: [1, 2, 3],
        showStackTraceSources: false,
      },
    }),
    encoding: 'utf8',
    timeout: 10000,
    killSignal: 'SIGKILL',
  });
  t.is(child.status, 0, child.stderr);
  const completion = JSON.parse(child.stdout.trim().split('\n')[1]!);
  t.is(completion.failed?.failure?.message, 'source-map failure');
  t.regex(completion.failed?.failure?.stackTrace ?? '', /vmless-source-map\.ts:2:\d+/);
});

for (const scenario of [
  'busyLoop',
  'microtaskLoop',
  'unowned',
  'rejectUnobserved',
  'catchThrows',
  'lateAwait',
  'disposed',
  'late-detached',
]) {
  test.serial(`VM-less ${scenario} stays observable in a disposable process`, async (t) => {
    const bundle = parseWorkflowCode(
      (
        await bundleWorkflowCode({
          workflowsPath: require.resolve('./workflows/vmless-execution'),
          workflowExecutionMode: 'vmless',
          logger: new DefaultLogger('ERROR'),
        })
      ).code
    );
    const child = spawnSync(process.execPath, [require.resolve('./vmless-process')], {
      input: JSON.stringify({
        bundle,
        scenario,
        options: {
          info: { runId: 'test', workflowId: 'test', namespace: 'default', unsafe: {} },
          now: 1000,
          randomnessSeed: [1, 2, 3],
          showStackTraceSources: false,
        },
      }),
      encoding: 'utf8',
      timeout: 5000,
      killSignal: 'SIGKILL',
    });
    if (scenario === 'busyLoop' || scenario === 'microtaskLoop') {
      t.is((child.error as NodeJS.ErrnoException | undefined)?.code, 'ETIMEDOUT', scenario);
      t.regex(child.stdout, /ACTIVATING/, scenario);
    } else {
      t.falsy(child.error, child.stderr);
      t.not(child.status, 0, scenario);
      t.regex(
        child.stderr,
        scenario === 'unowned'
          ? /unowned rejection/
          : scenario === 'rejectUnobserved'
            ? /unobserved/
            : scenario === 'catchThrows'
              ? /catch handler failed/
              : scenario === 'lateAwait'
                ? /observed too late/
                : /delayed rejection/,
        scenario
      );
      if (scenario === 'disposed') t.regex(child.stdout, /DISPOSED/);
      if (scenario === 'late-detached') t.regex(child.stdout, /BETWEEN_ACTIVATIONS/);
    }
  });
}
