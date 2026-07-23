import type { PayloadTypeInfo, TypeInfo } from '@temporalio/common';
import {
  condition,
  continueAsNew,
  defineSignal,
  defineUpdate,
  defineWorkflowOptions,
  executeChild,
  makeContinueAsNewFunc,
  setHandler,
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
  hint: { converter: 'json' },
  mapper: {
    toIntermediate(value: Order): unknown {
      return { id: value.id, totalCents: value.totalCents.toString(), remainingRuns: value.remainingRuns };
    },
    fromIntermediate(value: unknown): Order {
      const dto = value as OrderDto;
      return new Order(dto.id, BigInt(dto.totalCents), dto.remainingRuns ?? 0);
    },
  },
};

export const receiptTypeInfo: TypeInfo<Receipt, ReceiptDto> = {
  hint: { converter: 'json' },
  mapper: {
    toIntermediate(value: Receipt): unknown {
      return { orderId: value.orderId, totalCents: value.totalCents.toString() };
    },
    fromIntermediate(value: unknown): Receipt {
      const dto = value as ReceiptDto;
      return new Receipt(dto.orderId, BigInt(dto.totalCents));
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
