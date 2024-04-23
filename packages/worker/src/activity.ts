import 'abort-controller/polyfill'; // eslint-disable-line import/no-unassigned-import
import { asyncLocalStorage, CompleteAsyncError, Context, Info } from '@temporalio/activity';
import {
  ActivityFunction,
  ApplicationFailure,
  CancelledFailure,
  ensureApplicationFailure,
  FAILURE_SOURCE,
  IllegalStateError,
  LoadedDataConverter,
} from '@temporalio/common';
import { encodeErrorToFailure, encodeToPayload } from '@temporalio/common/lib/internal-non-workflow';
import { composeInterceptors } from '@temporalio/common/lib/interceptors';
import { isAbortError } from '@temporalio/common/lib/type-helpers';
import { coresdk } from '@temporalio/proto';
import {
  ActivityExecuteInput,
  ActivityInboundCallsInterceptor,
  ActivityInterceptorsFactory,
  ActivityOutboundCallsInterceptor,
} from './interceptors';
import { Runtime } from './runtime';
import { Logger } from './logger';

const UNINITIALIZED = Symbol('UNINITIALIZED');

export type CancelReason =
  | keyof typeof coresdk.activity_task.ActivityCancelReason
  | 'WORKER_SHUTDOWN'
  | 'HEARTBEAT_DETAILS_CONVERSION_FAILED';

export class Activity {
  protected cancelReason?: CancelReason;
  public readonly context: Context;
  public cancel: (reason: CancelReason) => void = () => undefined;
  public readonly abortController: AbortController = new AbortController();
  public readonly interceptors: {
    inbound: ActivityInboundCallsInterceptor[];
    outbound: ActivityOutboundCallsInterceptor[];
  };

  constructor(
    public readonly info: Info,
    public readonly fn: ActivityFunction<any[], any> | undefined,
    public readonly dataConverter: LoadedDataConverter,
    public readonly heartbeatCallback: Context['heartbeat'],
    interceptors: ActivityInterceptorsFactory[]
  ) {
    const promise = new Promise<never>((_, reject) => {
      this.cancel = (reason: CancelReason) => {
        this.cancelReason = reason;
        this.abortController.abort();
        reject(new CancelledFailure(reason));
      };
    });
    this.context = new Context(
      info,
      promise,
      this.abortController.signal,
      this.heartbeatCallback,
      this.makeActivityLogger()
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

  protected makeActivityLogger(): Logger {
    const parentLogger = Runtime.instance().logger;
    return {
      log: (level, message, attrs) => {
        return parentLogger.log(level, message, { ...this.getLogAttributes(), ...attrs });
      },
      trace: (message, attrs) => {
        return parentLogger.trace(message, { ...this.getLogAttributes(), ...attrs });
      },
      debug: (message, attrs) => {
        return parentLogger.debug(message, { ...this.getLogAttributes(), ...attrs });
      },
      info: (message, attrs) => {
        return parentLogger.info(message, { ...this.getLogAttributes(), ...attrs });
      },
      warn: (message, attrs) => {
        return parentLogger.warn(message, { ...this.getLogAttributes(), ...attrs });
      },
      error: (message, attrs) => {
        return parentLogger.error(message, { ...this.getLogAttributes(), ...attrs });
      },
    };
  }

  /**
   * Actually executes the function.
   *
   * Any call up to this function and including this one will be trimmed out of stack traces.
   */
  protected async execute(fn: ActivityFunction<any[], any>, input: ActivityExecuteInput): Promise<unknown> {
    let error: any = UNINITIALIZED; // In case someone decides to throw undefined...
    const startTime = process.hrtime.bigint();
    this.context.log.debug('Activity started');
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
        this.context.log.debug('Activity completed', { durationMs });
      } else if (
        (error instanceof CancelledFailure || isAbortError(error)) &&
        this.context.cancellationSignal.aborted
      ) {
        this.context.log.debug('Activity completed as cancelled', { durationMs });
      } else if (error instanceof CompleteAsyncError) {
        this.context.log.debug('Activity will complete asynchronously', { durationMs });
      } else {
        this.context.log.warn('Activity failed', { error, durationMs });
      }
    }
  }

  public run(input: ActivityExecuteInput): Promise<coresdk.activity_result.IActivityExecutionResult> {
    return asyncLocalStorage.run(this.context, async (): Promise<coresdk.activity_result.IActivityExecutionResult> => {
      try {
        if (this.fn === undefined) throw new IllegalStateError('Activity function is not defined');
        const result = await this.execute(this.fn, input);
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
            const failure = await encodeErrorToFailure(this.dataConverter, err);
            failure.stackTrace = undefined;
            return { cancelled: { failure } };
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
    return asyncLocalStorage.run(this.context, () => this.execute(fn, input));
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
