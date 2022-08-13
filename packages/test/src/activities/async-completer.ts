import { Observer } from 'rxjs';
import { CompleteAsyncError, Context, Info } from '@temporalio/activity';

export interface Activities {
  completeAsync(): Promise<string>;
}

export function createActivities(observer: Observer<Info>): Activities {
  return {
    async completeAsync() {
      observer.next(Context.current().info);
      throw new CompleteAsyncError();
    },
  };
}
