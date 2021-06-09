import { AbortController } from 'abort-controller';
import { ActivityFunction, composeInterceptors } from '@temporalio/workflow';
import { DataConverter } from '@temporalio/workflow/lib/converter/data-converter';
import { coresdk } from '@temporalio/proto';
import { asyncLocalStorage } from '@temporalio/activity';
import { Context, CancellationError, Info } from '@temporalio/activity';
import {
  ActivityExecuteInput,
  ActivityInboundCallsInterceptor,
  ActivityInboundCallsInterceptorFactory,
} from './interceptors';

export class Activity {
  protected cancelRequested = false;
  public readonly context: Context;
  public cancel: (reason?: any) => void = () => undefined;
  public readonly abortController: AbortController = new AbortController();
  public readonly interceptors: {
    inbound: ActivityInboundCallsInterceptor[];
  };

  constructor(
    public readonly info: Info,
    public readonly fn: ActivityFunction<any[], any>,
    public readonly dataConverter: DataConverter,
    public readonly heartbeatCallback: Context['heartbeat'],
    interceptors?: {
      inbound?: ActivityInboundCallsInterceptorFactory[];
    }
  ) {
    const promise = new Promise<never>((_, reject) => {
      this.cancel = (reason?: any) => {
        this.cancelRequested = true;
        this.abortController.abort();
        reject(new CancellationError(reason));
      };
    });
    this.context = new Context(info, promise, this.abortController.signal, this.heartbeatCallback);
    // Prevent unhandled rejection
    promise.catch(() => undefined);
    this.interceptors = {
      inbound: (interceptors?.inbound ?? []).map((factory) => factory(this.context)),
    };
  }

  public run(input: ActivityExecuteInput): Promise<coresdk.activity_result.IActivityResult> {
    return asyncLocalStorage.run(this.context, async (): Promise<coresdk.activity_result.IActivityResult> => {
      try {
        const execute = composeInterceptors(this.interceptors.inbound, 'execute', ({ args }) => this.fn(...args));
        const result = await execute(input);
        if (this.cancelRequested) {
          return { canceled: {} };
        }
        return { completed: { result: this.dataConverter.toPayload(result) } };
      } catch (err) {
        if (this.cancelRequested) {
          return { canceled: {} };
        }
        return { failed: { failure: err?.message ? { message: err.message } : undefined } };
      }
    });
  }
}
