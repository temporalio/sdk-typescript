import assert from 'assert';
import * as nexus from 'nexus-rpc';
import { ApplicationFailure, CancelledFailure, NexusOperationFailure, SdkComponent } from '@temporalio/common';
import * as workflow from '@temporalio/workflow';
import { assertOrder, assertReceipt, Order, orderTypeInfo, Receipt, receiptTypeInfo } from './type-info/models';

////////////////////////////////////////////////////////////////////////////////////////////////////
// Service definitions

export const syncOpService = nexus.service('testService', {
  testSyncOp: nexus.operation<string, string>(),
});

export const blockingOpService = nexus.service('blockingService', {
  blockingOp: nexus.operation<void, void>(),
});

export const errorOpService = nexus.service('errorService', {
  op: nexus.operation<string, string>(),
});

export const asyncOpService = nexus.service('asyncService', {
  asyncOp: nexus.operation<string, string>(),
});

export const loggerService = nexus.service('loggerTestService', {
  loggerOp: nexus.operation<string, string>(),
});

export const getClientService = nexus.service('getClientTestService', {
  getClientOp: nexus.operation<void, boolean>(),
});

export const operationInfoService = nexus.service('operationInfoTestService', {
  operationInfoOp: nexus.operation<void, { namespace: string; taskQueue: string; endpoint: string }>(),
});

export const cancelErrorService = nexus.service('cancelErrorService', {
  cancelThrowsAppFailure: nexus.operation<void, void>(),
  cancelThrowsHandlerError: nexus.operation<void, void>(),
});

export const requestDeadlineService = nexus.service('requestDeadlineService', {
  checkDeadlineOnStart: nexus.operation<void, boolean>(),
  checkDeadlineOnCancel: nexus.operation<void, void>(),
});

export const linkCallbackService = nexus.service('linkCallbackService', {
  startTargetWorkflow: nexus.operation<void, void>(),
});

export const nonExistentService = nexus.service('nonExistentService', {
  op: nexus.operation<string, string>(),
});

export const multiOpService = nexus.service('multiOpService', {
  syncOp: nexus.operation<string, string>({ name: 'my-sync-op' }),
  asyncOp: nexus.operation<string, string>(),
});

export type InputA = { a: string };

export type InputB = { b: string };

export const clientOperationTypeSafetyCheckerService = nexus.service('typeSafetyService', {
  implicit: nexus.operation<InputA, InputA>(),
  explicit: nexus.operation<InputB, InputB>({ name: 'my-custom-operation-name' }),
});

export const typeInfoService = nexus.service('typeInfoService', {
  convert: nexus.operation<Order, Receipt>({
    inputType: orderTypeInfo,
    outputType: receiptTypeInfo,
  }),
});

export const typeInfoServiceWithoutMetadata = nexus.service('typeInfoService', {
  convert: nexus.operation<Order, Receipt>(),
});

////////////////////////////////////////////////////////////////////////////////////////////////////
// Caller workflows

export async function syncOpCaller(endpoint: string): Promise<string> {
  const client = workflow.createNexusServiceClient({ endpoint, service: syncOpService });
  return await client.executeOperation('testSyncOp', 'hello');
}

export async function cancelSyncOpCaller(endpoint: string): Promise<void> {
  const client = workflow.createNexusServiceClient({ endpoint, service: blockingOpService });
  return await client.executeOperation('blockingOp', undefined, {
    cancellationType: 'TRY_CANCEL',
  });
}

export async function errorOpCaller(endpoint: string, outcome: string): Promise<string> {
  const client = workflow.createNexusServiceClient({ endpoint, service: errorOpService });
  return await client.executeOperation('op', outcome);
}

export async function asyncOpCaller(endpoint: string): Promise<string> {
  const client = workflow.createNexusServiceClient({ endpoint, service: asyncOpService });
  return await client.executeOperation('asyncOp', 'hello');
}

export async function loggerOpCaller(endpoint: string): Promise<string> {
  const client = workflow.createNexusServiceClient({ endpoint, service: loggerService });
  return await client.executeOperation('loggerOp', 'hello');
}

export async function getClientCaller(endpoint: string): Promise<boolean> {
  const client = workflow.createNexusServiceClient({ endpoint, service: getClientService });
  return await client.executeOperation('getClientOp', undefined);
}

export async function typeInfoCaller(endpoint: string, useDefinition: boolean): Promise<Receipt> {
  const client = workflow.createNexusServiceClient({ endpoint, service: typeInfoService });
  let result: Receipt;
  if (useDefinition) {
    result = await client.executeOperation(typeInfoService.operations.convert, new Order('order-1', 123n));
  } else {
    result = await client.executeOperation('convert', new Order('order-1', 123n));
  }
  assertReceipt(result);
  return result;
}

export async function interceptorTypeInfoCaller(endpoint: string): Promise<Receipt> {
  const client = workflow.createNexusServiceClient({ endpoint, service: typeInfoServiceWithoutMetadata });
  const result = await client.executeOperation('convert', new Order('order-1', 123n));
  assertReceipt(result);
  return result;
}

export async function operationInfoCaller(
  endpoint: string
): Promise<{ namespace: string; taskQueue: string; endpoint: string }> {
  const client = workflow.createNexusServiceClient({ endpoint, service: operationInfoService });
  return await client.executeOperation('operationInfoOp', undefined);
}

export async function linkCallbackCaller(endpoint: string): Promise<void> {
  const client = workflow.createNexusServiceClient({ endpoint, service: linkCallbackService });
  return await client.executeOperation('startTargetWorkflow', undefined);
}

export async function cancelAppFailureCaller(endpoint: string): Promise<void> {
  const client = workflow.createNexusServiceClient({ endpoint, service: cancelErrorService });
  try {
    await client.executeOperation('cancelThrowsAppFailure', undefined, {
      cancellationType: 'WAIT_CANCELLATION_REQUESTED',
    });
  } catch (err) {
    if (workflow.isCancellation(err)) return;
    throw err;
  }
}

export async function cancelHandlerErrorCaller(endpoint: string): Promise<void> {
  const client = workflow.createNexusServiceClient({ endpoint, service: cancelErrorService });
  try {
    await client.executeOperation('cancelThrowsHandlerError', undefined, {
      cancellationType: 'WAIT_CANCELLATION_REQUESTED',
    });
  } catch (err) {
    if (workflow.isCancellation(err)) return;
    throw err;
  }
}

export async function requestDeadlineStartCaller(endpoint: string): Promise<boolean> {
  const client = workflow.createNexusServiceClient({ endpoint, service: requestDeadlineService });
  return await client.executeOperation('checkDeadlineOnStart', undefined);
}

export async function requestDeadlineCancelCaller(endpoint: string): Promise<void> {
  const client = workflow.createNexusServiceClient({ endpoint, service: requestDeadlineService });
  try {
    await client.executeOperation('checkDeadlineOnCancel', undefined, {
      cancellationType: 'WAIT_CANCELLATION_REQUESTED',
    });
  } catch (err) {
    if (workflow.isCancellation(err)) return;
    throw err;
  }
}

export async function multiOpCaller(
  endpoint: string,
  op: keyof typeof multiOpService.operations,
  action: string,
  cancellationType?: workflow.NexusOperationCancellationType
): Promise<string> {
  const client = workflow.createNexusServiceClient({
    endpoint,
    service: multiOpService,
  });
  return await workflow.CancellationScope.cancellable(async () => {
    const handle = await client.startOperation(op, action, { cancellationType });
    if (action === 'waitForCancel') {
      workflow.CancellationScope.current().cancel();
    }
    return await handle.result();
  });
}

export async function callNonExistentService(endpoint: string): Promise<string> {
  const client = workflow.createNexusServiceClient({
    endpoint,
    service: nonExistentService,
  });
  return await client.executeOperation('op', 'hello');
}

export async function clientOperationTypeSafetyCheckerWorkflow(endpoint: string): Promise<void> {
  const Service = clientOperationTypeSafetyCheckerService;
  const operations = Service.operations;
  const client = workflow.createNexusServiceClient({
    endpoint,
    service: Service,
  });

  // That's quite exhaustive, but we can't generalize these without risking compromising
  // the validity of the compiler's type safety checks that we specifically want to test here.

  // Case 1: Provide resolved OperationDefinition object, with correct input type
  // There should be no compilation error, and it should execute successfully.
  {
    const wha = await client.startOperation(operations.implicit, { a: 'a' });
    assert(((await wha.result()) satisfies InputA).a === 'a');

    const whb = await client.startOperation(operations.explicit, { b: 'b' });
    assert(((await whb.result()) satisfies InputB).b === 'b');
  }

  // Case 2: Provide the operation _property name_, with correct input type
  //
  // The _property name_ is the name of the property used to specify the operation in the
  // `ServiceDefinition` object, which may differ from the value of the `name` property
  // if one was explicitly specified on the OperationDefinition object).
  // There should be no compilation error, and it should execute successfully.
  {
    const wha = await client.startOperation('implicit', { a: 'a' });
    assert(((await wha.result()) satisfies InputA).a === 'a');

    const whb = await client.startOperation('explicit', { b: 'b' });
    assert(((await whb.result()) satisfies InputB).b === 'b');
  }

  // Case 3: Provide resolved OperationDefinition object, with _incorrect_ input type.
  // Compiler should complain, and if forced to execute anyway, should result in a HandlerError.
  {
    // @ts-expect-error - Incompatible input type
    const wha = await client.startOperation(operations.implicit, { x: 'x' });
    assert(((await wha.result()) satisfies InputA as any).x === 'x');

    // @ts-expect-error - Incompatible input type
    const whb = await client.startOperation(operations.explicit, { x: 'x' });
    assert(((await whb.result()) satisfies InputB as any).x === 'x');
  }

  // Case 4: Provide the operation _property name_, with _incorrect_ input type.
  // Compiler should complain, and if forced to execute anyway, should result in a HandlerError.
  {
    // @ts-expect-error - Incompatible input type
    const wha = await client.startOperation(operations.implicit, { x: 'x' });
    assert(((await wha.result()) satisfies InputA as any).x === 'x');

    // @ts-expect-error - Incompatible input type
    const whb = await client.startOperation(operations.explicit, { x: 'x' });
    assert(((await whb.result()) satisfies InputB as any).x === 'x');
  }

  // Case 5: Non-existent operation name
  // Compiler should complain, and if forced to execute anyway, handler will throw a HandlerError.
  {
    try {
      // @ts-expect-error - Incorrect operation name
      await client.startOperation('non-existent', { x: 'x' });
    } catch (err) {
      assert(err instanceof NexusOperationFailure, `Expected a NexusOperationFailure, got ${err}`);
      assert(err.cause instanceof nexus.HandlerError, `Expected cause to be a HandlerError, got ${err.cause}`);
      assert(err.cause.type === 'NOT_FOUND', `Expected a NOT_FOUND error, got ${err.cause.type}`);
    }
  }
}

////////////////////////////////////////////////////////////////////////////////////////////////////
// Target workflows

export async function echoWorkflow(input: string): Promise<string> {
  return input;
}

export async function blockingTargetWorkflow(): Promise<void> {
  await workflow.condition(() => false);
}

export async function multiOpHandler(action: string): Promise<string> {
  if (action === 'failWorkflow') {
    throw ApplicationFailure.create({
      nonRetryable: true,
      message: 'test asked to fail',
      type: 'IntentionalError',
      details: ['a detail'],
    });
  }
  if (action === 'waitForCancel') {
    await workflow.CancellationScope.current().cancelRequested;
  }
  return action;
}
