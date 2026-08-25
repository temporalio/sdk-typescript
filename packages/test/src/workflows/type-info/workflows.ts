import { continueAsNew, defineWorkflowOptions, executeChild, makeContinueAsNewFunc } from '@temporalio/workflow';
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
