import { asyncLocalStorage, Context, Info } from '@temporalio/activity';
import { CancelledFailure, ensureTemporalFailure, FAILURE_SOURCE, LoadedDataConverter } from '@temporalio/common';
import { encodeErrorToFailure, encodeToPayload } from '@temporalio/internal-non-workflow-common';
import { ActivityFunction, composeInterceptors } from '@temporalio/internal-workflow-common';
import { coresdk } from '@temporalio/proto';
import { AbortController } from 'abort-controller';
import {
  ActivityExecuteInput,
  ActivityInboundCallsInterceptor,
  ActivityInboundCallsInterceptorFactory,
} from './interceptors';

export class Activity {
  protected cancelRequested = false;
  public readonly context: Context;
  public cancel: (resolveAsFailure: boolean, reason?: string) => void = () => undefined;
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
      this.cancel = (resolveAsFailure: boolean, reason?: string) => {
        if (!resolveAsFailure) {
          this.cancelRequested = true;
        }
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
        if (this.cancelRequested) {
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
            failure: await encodeErrorToFailure(this.dataConverter, ensureTemporalFailure(err)),
          },
        };
      }
    });
  }
}
