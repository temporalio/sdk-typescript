import { Observer } from 'rxjs';
import { ActivityInterface, CompleteAsyncError, Context, Info } from '@temporalio/activity';

export interface Activities extends ActivityInterface {
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
