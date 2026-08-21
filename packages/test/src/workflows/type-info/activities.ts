import { setActivityOptions } from '@temporalio/activity';
import { activityTypeInfo } from './activity-type-info';
import type { Order } from './models';
import { assertOrder, Receipt } from './models';

export async function convertOrder(order: Order): Promise<Receipt> {
  assertOrder(order);
  return new Receipt(order.id, order.totalCents);
}

setActivityOptions({ typeInfo: activityTypeInfo.convertOrder }, convertOrder);
