import type { Info } from '@temporalio/activity';
import { CompleteAsyncError, Context, setActivityOptions } from '@temporalio/activity';
import type { Observer } from 'rxjs';
import { assertOrder, Order, Receipt, workflowTypeInfo } from './models';

export async function convertOrder(order: Order): Promise<Receipt> {
  assertOrder(order);
  return new Receipt(order.id, order.totalCents);
}

setActivityOptions({ typeInfo: workflowTypeInfo }, convertOrder);

export interface AsyncOrderActivities {
  completeOrderAsync(order: Order): Promise<Receipt>;
}

export function createAsyncOrderActivities(observer: Observer<Info>): AsyncOrderActivities {
  async function completeOrderAsync(order: Order): Promise<Receipt> {
    assertOrder(order);
    observer.next(Context.current().info);
    throw new CompleteAsyncError();
  }

  setActivityOptions({ typeInfo: workflowTypeInfo }, completeOrderAsync);
  return { completeOrderAsync };
}

export async function convertOrderWithoutTypeInfo(order: unknown): Promise<string> {
  if (order instanceof Order) {
    throw new Error('Activity without TypeInfo must not receive an Order instance');
  }
  return (order as { id: string }).id;
}

export const notAnActivity = 'not-an-activity';
