import type { PayloadTypeInfo, TypeInfo } from '@temporalio/common';
import {
  condition,
  continueAsNew,
  defineSignal,
  defineUpdate,
  defineWorkflowOptions,
  executeChild,
  getExternalWorkflowHandle,
  makeContinueAsNewFunc,
  setHandler,
  startChild,
} from '@temporalio/workflow';

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

interface OrderDto {
  id: string;
  totalCents: string;
  remainingRuns: number;
}

interface ReceiptDto {
  orderId: string;
  totalCents: string;
}

export const orderTypeInfo: TypeInfo<Order, OrderDto> = {
  transferTypeConverter: {
    toTransferType(value: Order): OrderDto {
      return { id: value.id, totalCents: value.totalCents.toString(), remainingRuns: value.remainingRuns };
    },
    fromTransferType(value: OrderDto): Order {
      return new Order(value.id, BigInt(value.totalCents), value.remainingRuns ?? 0);
    },
  },
};

export const receiptTypeInfo: TypeInfo<Receipt, ReceiptDto> = {
  transferTypeConverter: {
    toTransferType(value: Receipt): ReceiptDto {
      return { orderId: value.orderId, totalCents: value.totalCents.toString() };
    },
    fromTransferType(value: ReceiptDto): Receipt {
      return new Receipt(value.orderId, BigInt(value.totalCents));
    },
  },
};

export const workflowTypeInfo: PayloadTypeInfo = {
  inputTypes: [orderTypeInfo],
  outputType: receiptTypeInfo,
};

function assertOrder(order: Order): void {
  if (!(order instanceof Order)) {
    throw new Error('Expected Order input');
  }
  if (typeof order.totalCents !== 'bigint') {
    throw new Error('Expected Order.totalCents to be a bigint');
  }
}

function assertReceipt(receipt: Receipt): void {
  if (!(receipt instanceof Receipt)) {
    throw new Error('Expected Receipt result');
  }
  if (typeof receipt.totalCents !== 'bigint') {
    throw new Error('Expected Receipt.totalCents to be a bigint');
  }
}

defineWorkflowOptions(workflowWithTypeInfo, {
  staticOptions: { typeInfo: workflowTypeInfo },
});
export async function workflowWithTypeInfo(order: Order): Promise<Receipt> {
  assertOrder(order);
  if (order.remainingRuns > 0) {
    await continueAsNew(new Order(order.id, order.totalCents, order.remainingRuns - 1));
  }
  return new Receipt(order.id, order.totalCents);
}

export async function parentWorkflowChildDefinition(order: Order): Promise<Receipt> {
  assertOrder(order);
  const receipt = await executeChild(workflowWithTypeInfo, { args: [order] });
  assertReceipt(receipt);
  return receipt;
}
defineWorkflowOptions(parentWorkflowChildDefinition, {
  staticOptions: { typeInfo: workflowTypeInfo },
});

export async function parentWorkflowChildString(order: Order): Promise<Receipt> {
  assertOrder(order);
  const receipt = await executeChild('workflowWithTypeInfo', {
    args: [order],
    typeInfo: workflowTypeInfo,
  });
  assertReceipt(receipt);
  return receipt;
}
defineWorkflowOptions(parentWorkflowChildString, {
  staticOptions: { typeInfo: workflowTypeInfo },
});

export async function parentWorkflowChildDefinitionInvalidCallSiteTypeInfo(order: Order): Promise<void> {
  await executeChild(workflowWithTypeInfo, {
    args: [order],
    typeInfo: workflowTypeInfo,
  });
}
defineWorkflowOptions(parentWorkflowChildDefinitionInvalidCallSiteTypeInfo, {
  workflowDefinitionOptions: { failureExceptionTypes: [TypeError] },
  staticOptions: { typeInfo: workflowTypeInfo },
});

export async function continueAsNewToWorkflowWithTypeInfo(order: Order): Promise<Receipt> {
  assertOrder(order);
  const continueAsTypedWorkflow = makeContinueAsNewFunc<typeof workflowWithTypeInfo>({
    workflowType: 'workflowWithTypeInfo',
    typeInfo: { inputTypes: workflowTypeInfo.inputTypes },
  });
  return await continueAsTypedWorkflow(order);
}
defineWorkflowOptions(continueAsNewToWorkflowWithTypeInfo, {
  staticOptions: { typeInfo: workflowTypeInfo },
});

export const finishSignal = defineSignal('finish');

export const orderSignal = defineSignal<[Order]>('order', {
  typeInfo: { inputTypes: [orderTypeInfo] },
});

export async function signalTarget(): Promise<string> {
  let summary: string | undefined;
  setHandler(orderSignal, (order) => {
    assertOrder(order);
    summary = order.summary();
  });
  await condition(() => summary !== undefined);
  if (summary === undefined) {
    throw new Error('Signal handler did not set a summary');
  }
  return summary;
}

export async function signalExternalTarget(workflowId: string): Promise<void> {
  await getExternalWorkflowHandle(workflowId).signal(orderSignal, new Order('order-1', 12345n));
}

export async function signalChildTarget(): Promise<string> {
  const child = await startChild(signalTarget);
  await child.signal(orderSignal, new Order('order-1', 12345n));
  return await child.result();
}

export async function workflowWithSignalStart(order: Order): Promise<Receipt> {
  assertOrder(order);
  let finished = false;
  setHandler(finishSignal, () => {
    finished = true;
  });
  await condition(() => finished);
  return new Receipt(order.id, order.totalCents);
}
defineWorkflowOptions(workflowWithSignalStart, {
  staticOptions: { typeInfo: workflowTypeInfo },
});

export const finishUpdate = defineUpdate('finish');

export async function workflowWithUpdateStart(order: Order): Promise<Receipt> {
  assertOrder(order);
  let finished = false;
  setHandler(finishUpdate, () => {
    finished = true;
  });
  await condition(() => finished);
  return new Receipt(order.id, order.totalCents);
}
defineWorkflowOptions(workflowWithUpdateStart, {
  staticOptions: { typeInfo: workflowTypeInfo },
});
