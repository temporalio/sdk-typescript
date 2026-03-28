export type TestFile = string;

export interface TestBatchResult {
  passed: TestFile[];
  failed: TestFile[];
  failureDetails: Record<TestFile, string[]>;
}

export interface FlakyTest {
  file: TestFile;
  attemptsToPass: number;
}

export interface TestSuiteResult {
  totalFiles: number;
  passed: TestFile[];
  failed: TestFile[];
  flakes: FlakyTest[];
  retriesUsed: number;
}

export interface TestSuiteInput {
  maxRetries?: number;
  files?: TestFile[];
  env?: Record<string, string>;
}
