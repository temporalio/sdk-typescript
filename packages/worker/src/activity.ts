import { AbortController } from 'abort-controller';
import { ActivityFunction } from '@temporalio/workflow';
import { DataConverter } from '@temporalio/workflow/commonjs/converter/data-converter';
import { coresdk } from '@temporalio/proto';
import { asyncLocalStorage } from '@temporalio/activity/lib/internals';
import { Context, CancellationError } from '@temporalio/activity';

export class Activity {
  protected cancelRequested = false;
  public readonly context;
  public cancel: (reason?: any) => void = () => undefined;
  public readonly abortController: AbortController = new AbortController();

  // TODO: get all of the atributes required for setting the ActivityContext
  constructor(
    protected readonly fn: ActivityFunction<any[], any>,
    protected readonly args: any[],
    public readonly dataConverter: DataConverter,
    public readonly heartbeatCallback: Context['heartbeat']
  ) {
    const promise = new Promise<never>((_, reject) => {
      this.cancel = (reason?: any) => {
        this.cancelRequested = true;
        this.abortController.abort();
        reject(new CancellationError(reason));
      };
    });
    this.context = new Context(promise, this.abortController.signal, this.heartbeatCallback);
    promise.catch(() => undefined);
  }

  public async run(): Promise<coresdk.IActivityResult> {
    // Type of AsyncLocalStorage.run is incorrect, it returns the internal promise
    return asyncLocalStorage.run(
      this.context,
      async (): Promise<coresdk.IActivityResult> => {
        try {
          const result = await this.fn(...this.args);
          if (this.cancelRequested) {
            return { canceled: {} };
          }
          console.log('completed activity', { result });
          return { completed: { result: this.dataConverter.toPayloads(result) } };
        } catch (err) {
          if (this.cancelRequested) {
            return { canceled: {} };
          }
          return { failed: { failure: err?.message ? { message: err.message } : undefined } };
        }
      }
    ) as any;
  }
}
