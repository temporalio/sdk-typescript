import { CancellationScope, workflowInfo, getRandomStream, currentUpdateInfo } from '@temporalio/workflow';
import { UpdateScope } from '@temporalio/workflow/internal/vmless';

const importedRunId = workflowInfo().runId;
const importedTime = Date.now();
const values: number[] = [];
let calls = 0;

export async function vmlessOwnership(): Promise<unknown> {
  const runId = workflowInfo().runId;
  const scope = new CancellationScope();
  return scope.run(async () => {
    const random = getRandomStream('ownership');
    return UpdateScope.updateWithInfo(runId, 'ownership', () =>
      random.with(async () => {
        const expected = Math.random();
        for (let i = 0; i < 100; i++) await Promise.resolve();
        values.push(++calls);
        return {
          importedRunId,
          importedTime,
          runId,
          continuedRunId: workflowInfo().runId,
          time: Date.now(),
          values: [...values],
          scopeRetained: CancellationScope.current() === scope,
          updateId: currentUpdateInfo()?.id,
          expected,
          nextRandom: Math.random(),
        };
      })
    );
  });
}
