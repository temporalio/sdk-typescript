import type { PayloadTypeInfo, SignalTypeInfo, TypeInfo } from '@temporalio/common';
import {
  condition,
  defineQuery,
  defineSignal,
  defineUpdate,
  defineWorkflowOptions,
  getExternalWorkflowHandle,
  setHandler,
  startChild,
} from '@temporalio/workflow';
import { assertOrder, Order, orderTypeInfo, Receipt, workflowTypeInfo } from './models';

export const finishSignal = defineSignal('finish');

export const orderQueryTypeInfo: PayloadTypeInfo = {
  inputTypes: [orderTypeInfo],
  outputType: workflowTypeInfo.outputType,
};

const unexpectedQueryOutputType: TypeInfo<Receipt, never> = {
  transferTypeConverter: {
    toTransferType(): never {
      throw new Error('The retargeted Query must not use the original output TypeInfo');
    },
    fromTransferType(): Receipt {
      throw new Error('The retargeted Query must not use the original output TypeInfo');
    },
  },
};

const orderAliasQuery = defineQuery<Receipt, [Order]>('order-alias', {
  typeInfo: { inputTypes: [orderTypeInfo], outputType: unexpectedQueryOutputType },
});

export const orderQuery = defineQuery<Receipt, [Order]>('order', { typeInfo: orderQueryTypeInfo });

export async function queryTarget(): Promise<void> {
  let finished = false;
  setHandler(orderQuery, (order) => {
    assertOrder(order);
    return new Receipt(order.id, order.totalCents);
  });
  setHandler(orderAliasQuery, (order) => {
    assertOrder(order);
    return new Receipt(order.id, order.totalCents);
  });
  setHandler(finishSignal, () => {
    finished = true;
  });
  await condition(() => finished);
}

export const orderSignalTypeInfo: SignalTypeInfo = { inputTypes: [orderTypeInfo] };

export const orderSignal = defineSignal<[Order]>('order', { typeInfo: orderSignalTypeInfo });

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

export async function signalExternalTargetWithCallSiteTypeInfo(workflowId: string): Promise<void> {
  await getExternalWorkflowHandle(workflowId).signalWithOptions('order', {
    args: [new Order('order-1', 12345n)],
    typeInfo: orderSignalTypeInfo,
  });
}

export async function signalChildTarget(): Promise<string> {
  const child = await startChild(signalTarget);
  await child.signal(orderSignal, new Order('order-1', 12345n));
  return await child.result();
}

export async function signalChildTargetWithCallSiteTypeInfo(): Promise<string> {
  const child = await startChild(signalTarget);
  await child.signalWithOptions('order', {
    args: [new Order('order-1', 12345n)],
    typeInfo: orderSignalTypeInfo,
  });
  return await child.result();
}

defineWorkflowOptions(workflowWithSignalStart, {
  staticOptions: { typeInfo: workflowTypeInfo },
});
export async function workflowWithSignalStart(order: Order): Promise<Receipt> {
  assertOrder(order);
  let finished = false;
  setHandler(finishSignal, () => {
    finished = true;
  });
  await condition(() => finished);
  return new Receipt(order.id, order.totalCents);
}

export const finishUpdate = defineUpdate('finish');

defineWorkflowOptions(workflowWithUpdateStart, {
  staticOptions: { typeInfo: workflowTypeInfo },
});
export async function workflowWithUpdateStart(order: Order): Promise<Receipt> {
  assertOrder(order);
  let finished = false;
  setHandler(finishUpdate, () => {
    finished = true;
  });
  await condition(() => finished);
  return new Receipt(order.id, order.totalCents);
}
