import {
  continueAsNew,
  defineWorkflowOptions,
  executeChild,
  makeContinueAsNewFunc,
  proxyActivities,
  proxyLocalActivities,
} from '@temporalio/workflow';
import type { ActivityOptions } from '@temporalio/common';
import type * as activities from './activities';
import { activityTypeInfo } from './activity-type-info';
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

const boundedActivityOptions = {
  startToCloseTimeout: '1 minute',
  retry: { maximumAttempts: 1 },
} satisfies ActivityOptions;

const typeInfoActivityWorkflowConfig = {
  workflowDefinitionOptions: { failureExceptionTypes: [Error] },
  staticOptions: { typeInfo: workflowTypeInfo },
};

const typedActivities = proxyActivities<Pick<typeof activities, 'convertOrder'>>({
  ...boundedActivityOptions,
  activityTypeInfo,
});

const typedLocalActivities = proxyLocalActivities<Pick<typeof activities, 'convertOrder'>>({
  ...boundedActivityOptions,
  activityTypeInfo,
});

defineWorkflowOptions(workflowWithTypedActivity, typeInfoActivityWorkflowConfig);
export async function workflowWithTypedActivity(order: Order): Promise<Receipt> {
  assertOrder(order);
  const receipt = await typedActivities.convertOrder.executeWithOptions({ startToCloseTimeout: '30 seconds' }, [order]);
  assertReceipt(receipt);
  return receipt;
}

defineWorkflowOptions(workflowWithTypedLocalActivity, typeInfoActivityWorkflowConfig);
export async function workflowWithTypedLocalActivity(order: Order): Promise<Receipt> {
  assertOrder(order);
  const receipt = await typedLocalActivities.convertOrder.executeWithOptions({ startToCloseTimeout: '30 seconds' }, [
    order,
  ]);
  assertReceipt(receipt);
  return receipt;
}

// These proxies intentionally omit TypeInfo so the outbound interceptor is the only metadata source.
const activitiesConfiguredByInterceptor =
  proxyActivities<Pick<typeof activities, 'convertOrder'>>(boundedActivityOptions);
const localActivitiesConfiguredByInterceptor =
  proxyLocalActivities<Pick<typeof activities, 'convertOrder'>>(boundedActivityOptions);

defineWorkflowOptions(workflowWithInterceptorTypedActivity, typeInfoActivityWorkflowConfig);
export async function workflowWithInterceptorTypedActivity(order: Order): Promise<Receipt> {
  assertOrder(order);
  const receipt = await activitiesConfiguredByInterceptor.convertOrder(order);
  assertReceipt(receipt);
  return receipt;
}

defineWorkflowOptions(workflowWithInterceptorTypedLocalActivity, typeInfoActivityWorkflowConfig);
export async function workflowWithInterceptorTypedLocalActivity(order: Order): Promise<Receipt> {
  assertOrder(order);
  const receipt = await localActivitiesConfiguredByInterceptor.convertOrder(order);
  assertReceipt(receipt);
  return receipt;
}
