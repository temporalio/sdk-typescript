/**
 * Test the lifecycle of the Runtime singleton.
 * Tests run serially because Runtime is a singleton.
 */
import { Runtime } from '@temporalio/worker';
import * as wf from '@temporalio/workflow';
import { RUN_INTEGRATION_TESTS, test } from './helpers';

if (RUN_INTEGRATION_TESTS) {
  test.serial('Runtime can be created and disposed', async (t) => {
    await Runtime.instance().shutdown();
    t.pass();
  });
}

export async function log5Times(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    wf.log.info(`workflow log ${i}`);
    await wf.sleep(1);
  }
}
