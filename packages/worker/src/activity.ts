import { ActivityFunction } from '@temporalio/workflow';
import { DataConverter } from '@temporalio/workflow/commonjs/converter/data-converter';
import { coresdk } from '@temporalio/proto';
import { asyncLocalStorage } from '@temporalio/activity/lib/internals';
import { Context, CancellationError } from '@temporalio/activity';

export class Activity {
  public readonly context;
  public cancel: (reason?: any) => void = () => undefined;

  // TODO: get all of the atributes required for setting the ActivityContext
  constructor(
    protected readonly fn: ActivityFunction<any[], any>,
    protected readonly args: any[],
    public readonly dataConverter: DataConverter
  ) {
    this.context = new Context(
      new Promise<never>((_, reject) => {
        this.cancel = (reason?: any) => reject(new CancellationError(reason));
      })
    );
  }

  public async run(): Promise<coresdk.IActivityResult> {
    return asyncLocalStorage.run(
      this.context,
      async (): Promise<coresdk.IActivityResult> => {
        try {
          return { completed: { result: this.dataConverter.toPayloads(await this.fn(...this.args)) } };
        } catch (err) {
          if (err instanceof CancellationError) {
            return { canceled: {} };
          }
          return { failed: { failure: err?.message ? { message: err.message } : undefined } };
        }
      }
    ) as any;
  }
}
