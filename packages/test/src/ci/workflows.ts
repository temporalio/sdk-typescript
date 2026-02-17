import { log, proxyActivities, defineQuery, setHandler, ApplicationFailure } from '@temporalio/workflow';
import type * as activities from './activities';
import type { TestFile, TestSuiteInput, TestSuiteResult, FlakyTest } from './types';

const { discoverTests, runTests, alertFlakes } = proxyActivities<typeof activities>({
  startToCloseTimeout: '25m',
  // Each test file should complete within 5 minutes; if no heartbeat arrives
  // within this window the activity is considered stuck.
  heartbeatTimeout: '1m',
  retry: {
    // Allow retries since the activity heartbeats with checkpoint data
    // and can resume from the last completed file.
    maximumAttempts: 3,
  },
});

export interface TestSuiteProgress {
  attempt: number;
  maxRetries: number;
  remainingFiles: number;
  totalFiles: number;
  passed: TestFile[];
  failed: TestFile[];
  flakes: FlakyTest[];
}

export const progressQuery = defineQuery<TestSuiteProgress>('progress');

export async function testSuiteWorkflow(input: TestSuiteInput = {}): Promise<TestSuiteResult> {
  const maxRetries = input.maxRetries ?? 3;
  let testsToRun = input.files ?? (await discoverTests());
  const totalFiles = testsToRun.length;
  const allPassed: TestFile[] = [];
  const flakes: FlakyTest[] = [];
  // Track how many attempts each file has had
  const attemptCounts = new Map<TestFile, number>();
  let retriesUsed = 0;
  let currentFailed: TestFile[] = [];

  setHandler(progressQuery, () => ({
    attempt: retriesUsed,
    maxRetries,
    remainingFiles: testsToRun.length,
    totalFiles,
    passed: allPassed,
    failed: currentFailed,
    flakes,
  }));

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (testsToRun.length === 0) break;

    if (attempt > 0) {
      log.info(`Retry ${attempt}/${maxRetries}: re-running ${testsToRun.length} failed file(s)`, {
        files: testsToRun,
      });
    } else {
      log.info(`Running ${testsToRun.length} test file(s)`);
    }

    for (const file of testsToRun) {
      attemptCounts.set(file, (attemptCounts.get(file) ?? 0) + 1);
    }

    const result = await runTests(testsToRun, input.env);

    log.info(`Attempt ${attempt}: ${result.passed.length} passed, ${result.failed.length} failed`);

    for (const file of result.passed) {
      allPassed.push(file);
      const attempts = attemptCounts.get(file) ?? 1;
      if (attempts > 1) {
        flakes.push({ file, attemptsToPass: attempts });
      }
    }

    currentFailed = result.failed;
    testsToRun = result.failed;

    if (testsToRun.length > 0 && attempt < maxRetries) {
      retriesUsed++;
    }
  }

  if (flakes.length > 0) {
    await alertFlakes(flakes);
  }

  if (currentFailed.length > 0) {
    throw ApplicationFailure.nonRetryable(
      `${currentFailed.length} test file(s) failed after ${retriesUsed} retries: ${currentFailed.join(', ')}`
    );
  }

  return {
    totalFiles,
    passed: allPassed,
    failed: [],
    flakes,
    retriesUsed,
  };
}
