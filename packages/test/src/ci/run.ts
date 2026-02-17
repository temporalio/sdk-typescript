import { Connection, WorkflowClient } from '@temporalio/client';
import { testSuiteWorkflow } from './workflows';
import type { TestSuiteInput, TestSuiteResult } from './types';

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
  const env: Record<string, string> = {};
  for (const key of FORWARDED_ENV_VARS) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
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

async function main() {
  const connection = await Connection.connect({ address: 'localhost:7233' });
  const client = new WorkflowClient({ connection });

  const maxRetries = process.env.TEST_MAX_RETRIES ? parseInt(process.env.TEST_MAX_RETRIES, 10) : 3;

  const input: TestSuiteInput = {
    maxRetries,
    env: collectEnv(),
  };

  console.log(`Starting test suite workflow (maxRetries=${maxRetries})...`);

  try {
    const result = await client.execute(testSuiteWorkflow, {
      workflowId: `test-suite-${Date.now()}`,
      taskQueue: 'test-suite',
      args: [input],
      workflowExecutionTimeout: '30m',
    });
    printResults(result);
  } catch (err) {
    console.error('Test suite workflow failed:', err);
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
