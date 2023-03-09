import 'abort-controller/polyfill'; // eslint-disable-line import/no-unassigned-import
import { asyncLocalStorage, Context, Info } from '@temporalio/activity';
import {
  ActivityFunction,
  ApplicationFailure,
  CancelledFailure,
  ensureApplicationFailure,
  FAILURE_SOURCE,
  LoadedDataConverter,
} from '@temporalio/common';
import { encodeErrorToFailure, encodeToPayload } from '@temporalio/common/lib/internal-non-workflow';
import { composeInterceptors } from '@temporalio/common/lib/interceptors';
import { coresdk } from '@temporalio/proto';
import {
  ActivityExecuteInput,
  ActivityInboundCallsInterceptor,
  ActivityInboundCallsInterceptorFactory,
} from './interceptors';

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
  };

  constructor(
    public readonly info: Info,
    public readonly fn: ActivityFunction<any[], any>,
    public readonly dataConverter: LoadedDataConverter,
    public readonly heartbeatCallback: Context['heartbeat'],
    interceptors?: {
      inbound?: ActivityInboundCallsInterceptorFactory[];
    }
  ) {
    const promise = new Promise<never>((_, reject) => {
      this.cancel = (reason: CancelReason) => {
        this.cancelReason = reason;
        this.abortController.abort();
        reject(new CancelledFailure(reason));
      };
    });
    this.context = new Context(info, promise, this.abortController.signal, this.heartbeatCallback);
    // Prevent unhandled rejection
    promise.catch(() => undefined);
    this.interceptors = {
      inbound: (interceptors?.inbound ?? []).map((factory) => factory(this.context)),
    };
  }

  /**
   * Actually executes the function.
   *
   * Exist mostly for cutting it out of the stack trace for failures.
   */
  protected async execute({ args }: ActivityExecuteInput): Promise<coresdk.activity_result.IActivityExecutionResult> {
    return await this.fn(...args);
  }

  public run(input: ActivityExecuteInput): Promise<coresdk.activity_result.IActivityExecutionResult> {
    return asyncLocalStorage.run(this.context, async (): Promise<coresdk.activity_result.IActivityExecutionResult> => {
      try {
        const execute = composeInterceptors(this.interceptors.inbound, 'execute', (inp) => this.execute(inp));
        const result = await execute(input);
        return { completed: { result: await encodeToPayload(this.dataConverter, result) } };
      } catch (err) {
        if (err instanceof Error && err.name === 'CompleteAsyncError') {
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
          } else if (err instanceof Error && err.name === 'AbortError') {
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
}
