import { Connection, WorkflowClient, WorkflowFailedError } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import * as activities from './activities';
import { testSuiteWorkflow } from './workflows';
import type { TestSuiteInput, TestSuiteResult } from './types';

const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';

// Env vars to forward to AVA child processes
const FORWARDED_ENV_VARS = [
  'RUN_INTEGRATION_TESTS',
  'REUSE_V8_CONTEXT',
  'TEMPORAL_CLOUD_MTLS_TEST_TARGET_HOST',
  'TEMPORAL_CLOUD_MTLS_TEST_NAMESPACE',
  'TEMPORAL_CLOUD_MTLS_TEST_CLIENT_CERT',
  'TEMPORAL_CLOUD_MTLS_TEST_CLIENT_KEY',
  'TEMPORAL_CLOUD_API_KEY_TEST_TARGET_HOST',
  'TEMPORAL_CLOUD_API_KEY_TEST_NAMESPACE',
  'TEMPORAL_CLOUD_API_KEY_TEST_API_KEY',
  'TEMPORAL_CLOUD_OPS_TEST_TARGET_HOST',
  'TEMPORAL_CLOUD_OPS_TEST_NAMESPACE',
  'TEMPORAL_CLOUD_OPS_TEST_API_KEY',
  'TEMPORAL_CLOUD_OPS_TEST_API_VERSION',
];

function collectEnv(): Record<string, string> {
  return Object.fromEntries(
    FORWARDED_ENV_VARS.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]!])
  );
}

function printResults(result: TestSuiteResult): void {
  console.log('\n=== Test Suite Results ===');
  console.log(`Total files: ${result.totalFiles}`);
  console.log(`Passed: ${result.passed.length}`);
  console.log(`Failed: ${result.failed.length}`);
  console.log(`Retries used: ${result.retriesUsed}`);

  if (result.flakes.length > 0) {
    console.log(`\nFlaky tests (${result.flakes.length}):`);
    for (const flake of result.flakes) {
      console.log(`  - ${flake.file} (passed on attempt ${flake.attemptsToPass})`);
    }
  }

  if (result.failed.length > 0) {
    console.log(`\nFailed tests:`);
    for (const file of result.failed) {
      console.log(`  - ${file}`);
    }
  }
}

function printError(err: unknown): void {
  console.error('\n=== Test Suite Failed ===');

  if (err instanceof WorkflowFailedError && err.cause) {
    console.error(`Reason: ${err.cause.message}`);
    if (err.cause.cause instanceof Error) {
      console.error(`Root cause: ${err.cause.cause.message}`);
    }
  } else if (err instanceof Error) {
    console.error(`Error: ${err.message}`);
  } else {
    console.error(err);
  }
}

async function main() {
  const maxRetries = process.env.TEST_MAX_RETRIES ? parseInt(process.env.TEST_MAX_RETRIES, 10) : 3;

  const input: TestSuiteInput = {
    maxRetries,
    env: collectEnv(),
  };

  const nativeConnection = await NativeConnection.connect({ address: TEMPORAL_ADDRESS });
  const worker = await Worker.create({
    connection: nativeConnection,
    taskQueue: 'test-suite',
    workflowsPath: require.resolve('./workflows'),
    activities,
    maxConcurrentActivityTaskExecutions: 1,
  });

  const connection = await Connection.connect({ address: TEMPORAL_ADDRESS });
  const client = new WorkflowClient({ connection });

  console.log(`Starting test suite workflow (maxRetries=${maxRetries})...`);

  try {
    const result = await worker.runUntil(
      client.execute(testSuiteWorkflow, {
        workflowId: `test-suite-${Date.now()}`,
        taskQueue: 'test-suite',
        args: [input],
        workflowExecutionTimeout: '30m',
      })
    );
    printResults(result);
  } catch (err) {
    printError(err);
    process.exit(1);
  }
}

main().then(
  () => void process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
