import { newWorker, workerPoll, PollResult } from '../native';
import { Observable } from 'rxjs';
import { groupBy, mergeMap, mergeScan } from 'rxjs/operators';
// import { mapWithState } from './rxutils';
import { Workflow } from './engine';
import * as stdlib from './stdlib';

async function run() {
  const worker = newWorker("tasks");

  await new Observable<PollResult>((subscriber) => {
    workerPoll(worker, (err, result) => {
      if (err && err.message === 'EOF') {
        subscriber.complete();
        return;
      }
      if (result === undefined) {
        subscriber.error(err);
        return;
      }
      subscriber.next(result);
      return () => {}; // TODO: shutdown worker if no subscribers
    });
  })
    .pipe(
      groupBy(({ workflowID }) => workflowID),
      mergeMap((group$) => {
        return group$.pipe(
          mergeScan(async (workflow: Workflow | undefined, task) => {
            if (workflow === undefined) {
              workflow = await Workflow.create(group$.key);
              await stdlib.install(workflow);
            }
            console.log(task);
            switch (task.type) {
              case 'StartWorkflow': {
                // TODO: get script name from task params
                const scriptName = process.argv[process.argv.length - 1];
                const commands = await workflow.runMain(scriptName);
                console.log(commands[0]);
                break;
              }
              case 'CompleteTimer': {
                const commands = await workflow.trigger(task);
                console.log(commands[0]);
                break;
              }
              default:
                // ignore
            }
            return workflow;
          }, undefined, 1 /* concurrency */))
      })
    )
    .toPromise();
}

run().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
