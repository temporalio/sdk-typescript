/**
 * Test the lifecycle of the Runtime singleton.
 * Tests run serially because Runtime is a singleton.
 */
import { Runtime } from '@temporalio/worker';
import { RUN_INTEGRATION_TESTS, test } from './helpers';

if (RUN_INTEGRATION_TESTS) {
  test.serial('Runtime can be created and disposed', async (t) => {
    await Runtime.instance().shutdown();
    t.pass();
  });
}
