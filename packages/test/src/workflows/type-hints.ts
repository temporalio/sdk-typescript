import type { PayloadTypeHints } from '@temporalio/common';
import { continueAsNew, defineWorkflowOptions } from '@temporalio/workflow';

export class Order {
  constructor(
    readonly id: string,
    readonly totalCents: bigint,
    readonly remainingRuns = 0
  ) {}

  summary(): string {
    return `${this.id}:${this.totalCents}:${this.remainingRuns}`;
  }
}

export class Receipt {
  constructor(
    readonly orderId: string,
    readonly totalCents: bigint
  ) {}

  summary(): string {
    return `${this.orderId}:${this.totalCents}`;
  }
}

export const orderHint = {
  toIntermediate(value: Order): unknown {
    return { id: value.id, totalCents: value.totalCents.toString(), remainingRuns: value.remainingRuns };
  },
  fromIntermediate(value: any): Order {
    return new Order(value.id, BigInt(value.totalCents), value.remainingRuns ?? 0);
  },
};

export const receiptHint = {
  toIntermediate(value: Receipt): unknown {
    return { orderId: value.orderId, totalCents: value.totalCents.toString() };
  },
  fromIntermediate(value: any): Receipt {
    return new Receipt(value.orderId, BigInt(value.totalCents));
  },
};

export const workflowTypeHints: PayloadTypeHints = { inputTypes: [orderHint], outputType: receiptHint };

function assertOrder(order: Order): void {
  if (!(order instanceof Order)) {
    throw new Error('Expected Order input');
  }
  if (typeof order.totalCents !== 'bigint') {
    throw new Error('Expected Order.totalCents to be a bigint');
  }
}

function makeReceipt(order: Order): Receipt {
  assertOrder(order);
  return new Receipt(order.id, order.totalCents);
}

defineWorkflowOptions(workflowWithTypeHints, {
  staticOptions: { typeHints: workflowTypeHints },
});
export async function workflowWithTypeHints(order: Order): Promise<Receipt> {
  assertOrder(order);
  if (order.remainingRuns > 0) {
    await continueAsNew<typeof workflowWithTypeHints>(new Order(order.id, order.totalCents, order.remainingRuns - 1));
  }
  return makeReceipt(order);
}
