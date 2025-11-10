import 'abort-controller/polyfill'; // eslint-disable-line import/no-unassigned-import
import events from 'node:events';
import * as activity from '@temporalio/activity';
import {
  ActivityFunction,
  Logger,
  SdkComponent,
  defaultFailureConverter,
  defaultPayloadConverter,
  MetricMeter,
  noopMetricMeter,
  ActivityCancellationDetails,
} from '@temporalio/common';
import { LoggerWithComposedMetadata } from '@temporalio/common/lib/logger';
import { Client } from '@temporalio/client';
import { ActivityInterceptorsFactory, DefaultLogger } from '@temporalio/worker';
import { Activity, CancelReason } from '@temporalio/worker/lib/activity';

export interface MockActivityEnvironmentOptions {
  interceptors?: ActivityInterceptorsFactory[];
  logger?: Logger;
  metricMeter?: MetricMeter;
  client?: Client;
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
  public cancel: (reason?: CancelReason, details?: ActivityCancellationDetails) => void = () => undefined;
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
      opts?.client,
      LoggerWithComposedMetadata.compose(opts?.logger ?? new DefaultLogger(), { sdkComponent: SdkComponent.worker }),
      opts?.metricMeter ?? noopMetricMeter,
      opts?.interceptors ?? []
    );
    this.context = this.activity.context;
    this.cancel = (reason?: CancelReason, details?: ActivityCancellationDetails) => {
      // Default to CANCELLED if nothing provided.
      const r = reason ?? 'CANCELLED';
      const d = details ?? new ActivityCancellationDetails({ cancelRequested: true });
      this.activity.cancel(r, d);
    };
  }

  /**
   * Run a function in Activity Context
   */
  public async run<P extends any[], R, F extends ActivityFunction<P, R>>(fn: F, ...args: P): Promise<R> {
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
  workflowExecution: { workflowId: 'test', runId: '00000000-0000-0000-0000-000000000000' },
  scheduledTimestampMs: 1,
  startToCloseTimeoutMs: 1000,
  scheduleToCloseTimeoutMs: 1000,
  currentAttemptScheduledTimestampMs: 1,
  priority: undefined,
  retryPolicy: undefined,
};
