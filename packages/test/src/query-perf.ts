import arg from 'arg';
import * as Rx from 'rxjs';
import * as op from 'rxjs/operators';
import { WorkflowClient } from '@temporalio/client';

async function main() {
  const args = arg({ '--visibility-query': String, '--workflow-query': String, '--concurrency': Number });
  if (!(args['--visibility-query'] && args['--workflow-query'])) {
    throw new Error(`Usage ${process.argv[1]} --visiblity-query QUERY --workflow-query QUERY`);
  }

  const client = new WorkflowClient();
  const { executions } = await client.workflowService.listWorkflowExecutions({
    namespace: 'default',
    query: args['--visibility-query'],
  });
  // TODO: pagination and limit

  const query = args['--workflow-query'];
  const workflowIds = executions.map(({ execution }) => execution!.workflowId!);

  const durations = await Rx.firstValueFrom(
    Rx.from(workflowIds).pipe(
      op.mergeMap(async (workflowId) => {
        const t0 = process.hrtime.bigint();
        await client.getHandle(workflowId).query(query);
        const duration = process.hrtime.bigint() - t0;
        return Number(duration / 1_000_000n); // convert to ms
      }, args['--concurrency']),
      op.toArray(),
      op.map((arr) => arr.sort((a, b) => a - b))
    )
  );
  console.log('queries made', durations.length);
  console.log('avg', durations.reduce((acc, curr) => acc + curr, 0) / durations.length);
  console.log('p50', durations[Math.round(durations.length / 2)]);
  console.log('p95', durations[Math.round((durations.length / 100) * 95)]);
  console.log('p99', durations[Math.round((durations.length / 100) * 99)]);
}

main().then(
  () => void process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
