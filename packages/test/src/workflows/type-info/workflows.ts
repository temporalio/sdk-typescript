import {
  continueAsNew,
  defineWorkflowOptions,
  executeChild,
  makeContinueAsNewFunc,
  proxyActivities,
  proxyLocalActivities,
} from '@temporalio/workflow';
import type * as activities from './activities';
import { assertOrder, assertReceipt, Order, Receipt, workflowTypeInfo } from './models';

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

const executeChildWithoutTypeChecking = executeChild as unknown as (
  workflow: typeof workflowWithTypeInfo,
  options: { args: [Order]; typeInfo: typeof workflowTypeInfo }
) => Promise<unknown>;

defineWorkflowOptions(parentWorkflowChildDefinition, {
  staticOptions: { typeInfo: workflowTypeInfo },
});
export async function parentWorkflowChildDefinition(order: Order): Promise<Receipt> {
  assertOrder(order);
  const receipt = await executeChild(workflowWithTypeInfo, { args: [order] });
  assertReceipt(receipt);
  return receipt;
}

defineWorkflowOptions(parentWorkflowChildString, {
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

defineWorkflowOptions(parentWorkflowChildDefinitionInvalidCallSiteTypeInfo, {
  workflowDefinitionOptions: { failureExceptionTypes: [TypeError] },
  staticOptions: { typeInfo: workflowTypeInfo },
});
export async function parentWorkflowChildDefinitionInvalidCallSiteTypeInfo(order: Order): Promise<void> {
  const options = {
    args: [order] as [Order],
    typeInfo: workflowTypeInfo,
  };
  await executeChildWithoutTypeChecking(workflowWithTypeInfo, options);
}

defineWorkflowOptions(continueAsNewToWorkflowWithTypeInfo, {
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

defineWorkflowOptions(continueAsNewWithInterceptorTypeInfo, {
  staticOptions: { typeInfo: workflowTypeInfo },
});
export async function continueAsNewWithInterceptorTypeInfo(order: Order): Promise<Receipt> {
  assertOrder(order);
  const continueAsTypedWorkflow = makeContinueAsNewFunc<typeof workflowWithTypeInfo>({
    workflowType: 'workflowWithTypeInfo',
  });
  return await continueAsTypedWorkflow(order);
}

const typedActivities = proxyActivities<typeof activities>({
  startToCloseTimeout: '1 minute',
  activityTypeInfo: { convertOrder: workflowTypeInfo },
});

const typedLocalActivities = proxyLocalActivities<typeof activities>({
  startToCloseTimeout: '1 minute',
  activityTypeInfo: { convertOrder: workflowTypeInfo },
});

defineWorkflowOptions(workflowWithTypedActivity, {
  staticOptions: { typeInfo: workflowTypeInfo },
});
export async function workflowWithTypedActivity(order: Order): Promise<Receipt> {
  assertOrder(order);
  const receipt = await typedActivities.convertOrder(order);
  assertReceipt(receipt);
  return receipt;
}

defineWorkflowOptions(workflowWithTypedLocalActivity, {
  staticOptions: { typeInfo: workflowTypeInfo },
});
export async function workflowWithTypedLocalActivity(order: Order): Promise<Receipt> {
  assertOrder(order);
  const receipt = await typedLocalActivities.convertOrder(order);
  assertReceipt(receipt);
  return receipt;
}

const activityWithoutTypeInfo = proxyActivities<typeof activities>({ startToCloseTimeout: '1 minute' });

defineWorkflowOptions(workflowWithActivityWithoutTypeInfo, {
  staticOptions: { typeInfo: { inputTypes: [workflowTypeInfo.inputTypes![0]] } },
});
export async function workflowWithActivityWithoutTypeInfo(order: Order): Promise<string> {
  assertOrder(order);
  return await activityWithoutTypeInfo.convertOrderWithoutTypeInfo(order);
}

const interceptorTypedActivities = proxyActivities<typeof activities>({ startToCloseTimeout: '1 minute' });
const interceptorTypedLocalActivities = proxyLocalActivities<typeof activities>({ startToCloseTimeout: '1 minute' });

defineWorkflowOptions(workflowWithInterceptorTypedActivity, {
  staticOptions: { typeInfo: workflowTypeInfo },
});
export async function workflowWithInterceptorTypedActivity(order: Order): Promise<Receipt> {
  assertOrder(order);
  const receipt = await interceptorTypedActivities.convertOrder(order);
  assertReceipt(receipt);
  return receipt;
}

defineWorkflowOptions(workflowWithInterceptorTypedLocalActivity, {
  staticOptions: { typeInfo: workflowTypeInfo },
});
export async function workflowWithInterceptorTypedLocalActivity(order: Order): Promise<Receipt> {
  assertOrder(order);
  const receipt = await interceptorTypedLocalActivities.convertOrder(order);
  assertReceipt(receipt);
  return receipt;
}

interface DefaultActivities {
  convertOrderThroughDefault(order: Order): Promise<Receipt>;
}

const defaultTypedActivities = proxyActivities<DefaultActivities>({
  startToCloseTimeout: '1 minute',
  activityTypeInfo: { convertOrderThroughDefault: workflowTypeInfo },
});

defineWorkflowOptions(workflowWithDefaultTypedActivity, {
  staticOptions: { typeInfo: workflowTypeInfo },
});
export async function workflowWithDefaultTypedActivity(order: Order): Promise<Receipt> {
  assertOrder(order);
  const receipt = await defaultTypedActivities.convertOrderThroughDefault(order);
  assertReceipt(receipt);
  return receipt;
}
