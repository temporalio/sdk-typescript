import 'abort-controller/polyfill'; // eslint-disable-line import/no-unassigned-import
import events from 'node:events';
import * as activity from '@temporalio/activity';
import {
  ActivityFunction,
  Logger,
  SdkComponent,
  defaultFailureConverter,
  defaultPayloadConverter,
} from '@temporalio/common';
import { ActivityInterceptorsFactory, DefaultLogger } from '@temporalio/worker';
import { withMetadata } from '@temporalio/worker/lib/logger';
import { Activity } from '@temporalio/worker/lib/activity';

export interface MockActivityEnvironmentOptions {
  interceptors?: ActivityInterceptorsFactory[];
  logger?: Logger;
}

/**
 * An execution environment for testing Activities.
 *
 * Mocks Activity {@link Context | activity.Context} and exposes hooks for cancellation and heartbeats.
 *
 * Note that the `Context` object used by this environment will be reused for all activities that are run in this
 * environment. Consequently, once `cancel()` is called, any further activity that gets executed in this environment
 * will immediately be in a cancelled state.
 */
export class MockActivityEnvironment extends events.EventEmitter {
  public cancel: (reason?: any) => void = () => undefined;
  public readonly context: activity.Context;
  private readonly activity: Activity;

  constructor(info?: Partial<activity.Info>, opts?: MockActivityEnvironmentOptions) {
    super();
    const heartbeatCallback = (details?: unknown) => this.emit('heartbeat', details);
    const loadedDataConverter = {
      payloadConverter: defaultPayloadConverter,
      payloadCodecs: [],
      failureConverter: defaultFailureConverter,
    };
    this.activity = new Activity(
      { ...defaultActivityInfo, ...info },
      undefined,
      loadedDataConverter,
      heartbeatCallback,
      withMetadata(opts?.logger ?? new DefaultLogger(), { sdkComponent: SdkComponent.worker }),
      opts?.interceptors ?? []
    );
    this.context = this.activity.context;
    this.cancel = this.activity.cancel;
  }

  /**
   * Run a function in Activity Context
   */
  public async run<F extends ActivityFunction>(fn: F, ...args: Parameters<F>): ReturnType<F> {
    return this.activity.runNoEncoding(fn as ActivityFunction<any, any>, { args, headers: {} }) as Promise<R>;
  }
}

/**
 * Used as the default activity info for Activities executed in the {@link MockActivityEnvironment}
 *
 * @hidden
 */
export const defaultActivityInfo: activity.Info = {
  attempt: 1,
  taskQueue: 'test',
  isLocal: false,
  taskToken: Buffer.from('test'),
  activityId: 'test',
  activityType: 'unknown',
  workflowType: 'test',
  base64TaskToken: Buffer.from('test').toString('base64'),
  heartbeatTimeoutMs: undefined,
  heartbeatDetails: undefined,
  activityNamespace: 'default',
  workflowNamespace: 'default',
  workflowExecution: { workflowId: 'test', runId: 'dead-beef' },
  scheduledTimestampMs: 1,
  startToCloseTimeoutMs: 1000,
  scheduleToCloseTimeoutMs: 1000,
  currentAttemptScheduledTimestampMs: 1,
  priority: undefined,
};
