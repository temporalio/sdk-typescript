import { setActivityOptions } from '@temporalio/activity';
import { assertOrder, Order, Receipt, workflowTypeInfo } from './models';

export async function convertOrder(order: Order): Promise<Receipt> {
  assertOrder(order);
  return new Receipt(order.id, order.totalCents);
}

setActivityOptions({ typeInfo: workflowTypeInfo }, convertOrder);

export async function convertOrderWithoutTypeInfo(order: unknown): Promise<string> {
  if (order instanceof Order) {
    throw new Error('Activity without TypeInfo must not receive an Order instance');
  }
  return (order as { id: string }).id;
}

export const notAnActivity = 'not-an-activity';
