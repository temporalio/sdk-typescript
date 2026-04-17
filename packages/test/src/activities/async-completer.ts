import type { Observer } from 'rxjs';
import type { Info } from '@temporalio/activity';
import { CompleteAsyncError, Context } from '@temporalio/activity';

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
