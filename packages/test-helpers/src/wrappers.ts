import {
  ExistingServerTestWorkflowEnvironmentOptions,
  LocalTestWorkflowEnvironmentOptions,
  TestWorkflowEnvironment as RealTestWorkflowEnvironment,
  TimeSkippingTestWorkflowEnvironmentOptions,
} from '@temporalio/testing';
import * as worker from '@temporalio/worker';
import { Worker as RealWorker, WorkerOptions } from '@temporalio/worker';
import { inWorkflowContext } from '@temporalio/workflow';
import { REUSE_V8_CONTEXT, TESTS_CLI_VERSION, TESTS_TIME_SKIPPING_SERVER_VERSION } from './flags';

// Hack around Worker and TestWorkflowEnvironment not being available in workflow context
if (inWorkflowContext()) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  worker.Worker = class {}; // eslint-disable-line import/namespace

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  RealTestWorkflowEnvironment = class {}; // eslint-disable-line import/namespace
}

/**
 * Worker wrapper that defaults to REUSE_V8_CONTEXT from environment.
 */
export class Worker extends worker.Worker {
  static async create(options: WorkerOptions): Promise<worker.Worker> {
    return RealWorker.create({ ...options, reuseV8Context: options.reuseV8Context ?? REUSE_V8_CONTEXT });
  }
}

/**
 * A custom version of TestWorkflowEnvironment for our own testing use, that
 * allows specifying the version of the CLI and Time Skipping Server binaries
 * through environment variables.
 */
export class TestWorkflowEnvironment extends RealTestWorkflowEnvironment {
  static async createLocal(opts?: LocalTestWorkflowEnvironmentOptions): Promise<TestWorkflowEnvironment> {
    return RealTestWorkflowEnvironment.createLocal({
      ...opts,
      ...(TESTS_CLI_VERSION
        ? {
            server: {
              ...opts?.server,
              executable: {
                ...opts?.server?.executable,
                type: 'cached-download',
                version: TESTS_CLI_VERSION,
              },
            },
          }
        : undefined),
    });
  }

  static async createTimeSkipping(opts?: TimeSkippingTestWorkflowEnvironmentOptions): Promise<TestWorkflowEnvironment> {
    return RealTestWorkflowEnvironment.createTimeSkipping({
      ...opts,
      ...(TESTS_TIME_SKIPPING_SERVER_VERSION
        ? {
            server: {
              ...opts?.server,
              executable: {
                ...opts?.server?.executable,
                type: 'cached-download',
                version: TESTS_TIME_SKIPPING_SERVER_VERSION,
              },
            },
          }
        : undefined),
    });
  }

  static async createFromExistingServer(
    opts?: ExistingServerTestWorkflowEnvironmentOptions
  ): Promise<TestWorkflowEnvironment> {
    return RealTestWorkflowEnvironment.createFromExistingServer(opts);
  }
}
