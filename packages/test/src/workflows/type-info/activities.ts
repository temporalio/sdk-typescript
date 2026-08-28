import type { Observer } from 'rxjs';
import type { Info } from '@temporalio/activity';
import { CompleteAsyncError, Context, setActivityOptions } from '@temporalio/activity';
import { activityTypeInfo } from './activity-type-info';
import type { Order } from './models';
import { assertOrder, Receipt } from './models';

export async function convertOrder(order: Order): Promise<Receipt> {
  assertOrder(order);
  return new Receipt(order.id, order.totalCents);
}

setActivityOptions({ typeInfo: activityTypeInfo.convertOrder }, convertOrder);

export function createAsyncOrderActivities(observer: Observer<Info>): { completeOrderAsync: typeof convertOrder } {
  async function completeOrderAsync(order: Order): Promise<Receipt> {
    assertOrder(order);
    observer.next(Context.current().info);
    throw new CompleteAsyncError();
  }

  setActivityOptions({ typeInfo: activityTypeInfo.convertOrder }, completeOrderAsync);
  return { completeOrderAsync };
}
