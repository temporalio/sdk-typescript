import { inWorkflowContext } from '@temporalio/workflow';

export function isSet(env: string | undefined, def: boolean): boolean {
  if (env === undefined) return def;
  env = env.toLocaleLowerCase();
  return env === '1' || env === 't' || env === 'true';
}

export const RUN_INTEGRATION_TESTS = inWorkflowContext() || isSet(process.env.RUN_INTEGRATION_TESTS, true);
export const REUSE_V8_CONTEXT = inWorkflowContext() || isSet(process.env.REUSE_V8_CONTEXT, true);
export const RUN_TIME_SKIPPING_TESTS =
  inWorkflowContext() || !(process.platform === 'linux' && process.arch === 'arm64');

export const TESTS_CLI_VERSION = inWorkflowContext() ? '' : process.env.TESTS_CLI_VERSION;

export const TESTS_TIME_SKIPPING_SERVER_VERSION = inWorkflowContext()
  ? ''
  : process.env.TESTS_TIME_SKIPPING_SERVER_VERSION;
