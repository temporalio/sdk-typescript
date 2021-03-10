import { ActivityFunction } from '@temporalio/workflow';

export class Activity {
  // TODO: get all of the atributes required for setting the ActivityContext
  constructor(protected readonly fn: ActivityFunction<any[], any>, protected readonly args: any[]) {}

  public async run(): Promise<any> {
    return this.fn(...this.args);
  }

  public async cancel(): Promise<void> {
    throw new Error();
  }
}
