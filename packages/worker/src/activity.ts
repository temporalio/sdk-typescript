import 'abort-controller/polyfill'; // eslint-disable-line import/no-unassigned-import
import { asyncLocalStorage, CompleteAsyncError, Context, Info } from '@temporalio/activity';
import {
  ActivityCancellationDetails,
  ActivityFunction,
  ApplicationFailure,
  ApplicationFailureCategory,
  CancelledFailure,
  ensureApplicationFailure,
  FAILURE_SOURCE,
  IllegalStateError,
  LoadedDataConverter,
  MetricMeter,
  MetricTags,
  SdkComponent,
} from '@temporalio/common';
import { encodeErrorToFailure, encodeToPayload } from '@temporalio/common/lib/internal-non-workflow';
import { composeInterceptors } from '@temporalio/common/lib/interceptors';
import { isAbortError } from '@temporalio/common/lib/type-helpers';
import { Logger, LoggerWithComposedMetadata } from '@temporalio/common/lib/logger';
import { MetricMeterWithComposedTags } from '@temporalio/common/lib/metrics';
import { Client } from '@temporalio/client';
import { coresdk } from '@temporalio/proto';
import { ActivityCancellationDetailsHolder } from '@temporalio/common/lib/activity-cancellation-details';
import {
  ActivityExecuteInput,
  ActivityInboundCallsInterceptor,
  ActivityInterceptorsFactory,
  ActivityOutboundCallsInterceptor,
} from './interceptors';

const UNINITIALIZED = Symbol('UNINITIALIZED');

export type CancelReason =
  | keyof typeof coresdk.activity_task.ActivityCancelReason
  | 'WORKER_SHUTDOWN'
  | 'HEARTBEAT_DETAILS_CONVERSION_FAILED';

export class Activity {
  protected cancelReason?: CancelReason;
  protected cancellationDetails: ActivityCancellationDetailsHolder;
  public readonly context: Context;
  public cancel: (reason: CancelReason, details: ActivityCancellationDetails) => void = () => undefined;
  public readonly abortController: AbortController = new AbortController();

  /**
   * Logger bound to `sdkComponent: worker`, with metadata from this activity.
   * This is the logger to use for all log messages emitted by the activity
   * worker. Note this is not exactly the same thing as the activity context
   * logger, which is bound to `sdkComponent: activity`.
   */
  private readonly workerLogger;

  /**
   * Metric Meter with tags from this activity, including tags from interceptors.
   */
  private readonly metricMeter;

  public readonly interceptors: {
    inbound: ActivityInboundCallsInterceptor[];
    outbound: ActivityOutboundCallsInterceptor[];
  };

  constructor(
    public readonly info: Info,
    public readonly fn: ActivityFunction<any[], any> | undefined,
    public readonly dataConverter: LoadedDataConverter,
    public readonly heartbeatCallback: Context['heartbeat'],
    private readonly _client: Client | undefined, // May be undefined in the case of MockActivityEnvironment
    workerLogger: Logger,
    workerMetricMeter: MetricMeter,
    interceptors: ActivityInterceptorsFactory[]
  ) {
    this.workerLogger = LoggerWithComposedMetadata.compose(workerLogger, this.getLogAttributes.bind(this));
    this.metricMeter = MetricMeterWithComposedTags.compose(workerMetricMeter, this.getMetricTags.bind(this));
    this.cancellationDetails = {};
    const promise = new Promise<never>((_, reject) => {
      this.cancel = (reason: CancelReason, details: ActivityCancellationDetails) => {
        this.cancelReason = reason;
        this.cancellationDetails.details = details;
        const err = new CancelledFailure(reason);
        this.abortController.abort(err);
        reject(err);
      };
    });
    this.context = new Context(
      info,
      promise,
      this.abortController.signal,
      this.heartbeatCallback,
      this._client,
      // This is the activity context logger, to be used exclusively from user code
      LoggerWithComposedMetadata.compose(this.workerLogger, { sdkComponent: SdkComponent.activity }),
      this.metricMeter,
      this.cancellationDetails
    );
    // Prevent unhandled rejection
    promise.catch(() => undefined);
    this.interceptors = { inbound: [], outbound: [] };
    interceptors
      .map((factory) => factory(this.context))
      .forEach(({ inbound, outbound }) => {
        if (inbound) this.interceptors.inbound.push(inbound);
        if (outbound) this.interceptors.outbound.push(outbound);
      });
  }

  protected getLogAttributes(): Record<string, unknown> {
    const logAttributes = activityLogAttributes(this.info);
    // In case some interceptor uses the logger while initializing...
    if (this.interceptors == null) return logAttributes;
    return composeInterceptors(this.interceptors.outbound, 'getLogAttributes', (a) => a)(logAttributes);
  }

  protected getMetricTags(): MetricTags {
    const baseTags = {
      namespace: this.info.workflowNamespace,
      taskQueue: this.info.taskQueue,
      activityType: this.info.activityType,
    };
    // In case some interceptors use the metric meter while initializing...
    if (this.interceptors == null) return baseTags;
    return composeInterceptors(this.interceptors.outbound, 'getMetricTags', (a) => a)(baseTags);
  }

  /**
   * Actually executes the function.
   *
   * Any call up to this function and including this one will be trimmed out of stack traces.
   */
  protected async execute(fn: ActivityFunction<any[], any>, input: ActivityExecuteInput): Promise<unknown> {
    let error: any = UNINITIALIZED; // In case someone decides to throw undefined...
    const startTime = process.hrtime.bigint();
    this.workerLogger.debug('Activity started');
    try {
      const executeNextHandler = ({ args }: any) => fn(...args);
      const executeWithInterceptors = composeInterceptors(this.interceptors.inbound, 'execute', executeNextHandler);
      return await executeWithInterceptors(input);
    } catch (err: any) {
      error = err;
      throw err;
    } finally {
      const durationNanos = process.hrtime.bigint() - startTime;
      const durationMs = Number(durationNanos / 1_000_000n);

      if (error === UNINITIALIZED) {
        this.workerLogger.debug('Activity completed', { durationMs });
      } else if (
        (error instanceof CancelledFailure || isAbortError(error)) &&
        this.context.cancellationSignal.aborted
      ) {
        if (this.context.cancellationDetails?.cancelRequested) {
          this.workerLogger.debug('Activity completed as cancelled', { durationMs });
        } else if (this.context.cancellationDetails?.reset) {
          this.workerLogger.debug('Activity reset', { durationMs });
        } else if (this.context.cancellationDetails?.paused) {
          this.workerLogger.debug('Activity paused', { durationMs });
        } else {
          // Fallback log - completed as cancelled.
          this.workerLogger.debug('Activity completed as cancelled', { durationMs });
        }
      } else if (error instanceof CompleteAsyncError) {
        this.workerLogger.debug('Activity will complete asynchronously', { durationMs });
      } else {
        if (error instanceof ApplicationFailure && error.category === ApplicationFailureCategory.BENIGN) {
          // Downgrade log level to DEBUG for benign application errors.
          this.workerLogger.debug('Activity failed', { error, durationMs });
        } else {
          this.workerLogger.warn('Activity failed', { error, durationMs });
        }
      }
    }
  }

  // Ensure that client calls made with the worker's client in this handler's context are tied
  // to the abort signal. The fact that client can be undefined (i.e. in a MockActivityEnvironment)
  // makes this a bit more complex.
  private executeWithClient(fn: ActivityFunction<any[], any>, input: ActivityExecuteInput): Promise<unknown> {
    if (this._client) {
      return this._client.withAbortSignal(this.abortController.signal, () => {
        return this.execute(fn, input);
      });
    } else {
      return this.execute(fn, input);
    }
  }

  public run(input: ActivityExecuteInput): Promise<coresdk.activity_result.IActivityExecutionResult> {
    return asyncLocalStorage.run(this.context, async (): Promise<coresdk.activity_result.IActivityExecutionResult> => {
      try {
        if (this.fn === undefined) throw new IllegalStateError('Activity function is not defined');
        const result = await this.executeWithClient(this.fn, input);
        return { completed: { result: await encodeToPayload(this.dataConverter, result) } };
      } catch (err) {
        if (err instanceof CompleteAsyncError) {
          return { willCompleteAsync: {} };
        }
        if (this.cancelReason === 'HEARTBEAT_DETAILS_CONVERSION_FAILED') {
          // Ignore actual failure, it is likely a CancelledFailure but server
          // expects activity to only fail with ApplicationFailure
          return {
            failed: {
              failure: await encodeErrorToFailure(
                this.dataConverter,
                ApplicationFailure.retryable(this.cancelReason, 'CancelledFailure')
              ),
            },
          };
        } else if (this.cancelReason) {
          // Either a CancelledFailure that we threw or AbortError from AbortController
          if (err instanceof CancelledFailure) {
            // If cancel due to activity pause or reset, emit an application failure.
            if (this.context.cancellationDetails?.reset) {
              return {
                failed: {
                  failure: await encodeErrorToFailure(
                    this.dataConverter,
                    new ApplicationFailure('Activity reset', 'ActivityReset')
                  ),
                },
              };
            } else if (this.context.cancellationDetails?.paused) {
              return {
                failed: {
                  failure: await encodeErrorToFailure(
                    this.dataConverter,
                    new ApplicationFailure('Activity paused', 'ActivityPause')
                  ),
                },
              };
            } else {
              const failure = await encodeErrorToFailure(this.dataConverter, err);
              failure.stackTrace = undefined;
              return { cancelled: { failure } };
            }
          } else if (isAbortError(err)) {
            return { cancelled: { failure: { source: FAILURE_SOURCE, canceledFailureInfo: {} } } };
          }
        }
        return {
          failed: {
            failure: await encodeErrorToFailure(this.dataConverter, ensureApplicationFailure(err)),
          },
        };
      }
    });
  }

  public runNoEncoding(fn: ActivityFunction<any[], any>, input: ActivityExecuteInput): Promise<unknown> {
    if (this.fn !== undefined) throw new IllegalStateError('Activity function is defined');
    return asyncLocalStorage.run(this.context, () => this.executeWithClient(fn, input));
  }
}

/**
 * Returns a map of attributes to be set on log messages for a given Activity
 */
export function activityLogAttributes(info: Info): Record<string, unknown> {
  return {
    isLocal: info.isLocal,
    attempt: info.attempt,
    namespace: info.workflowNamespace,
    taskToken: info.base64TaskToken,
    workflowId: info.workflowExecution.workflowId,
    workflowRunId: info.workflowExecution.runId,
    workflowType: info.workflowType,
    activityId: info.activityId,
    activityType: info.activityType,
    taskQueue: info.taskQueue,
  };
}
