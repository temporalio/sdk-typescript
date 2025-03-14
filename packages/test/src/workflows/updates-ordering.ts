import { defineUpdate, setDefaultUpdateHandler, setHandler } from '@temporalio/workflow';

const updateA = defineUpdate<ProcessedUpdate, [number]>('updateA');
const updateB = defineUpdate<ProcessedUpdate, [number]>('updateB');
const updateC = defineUpdate<ProcessedUpdate, [number]>('updateC');

interface ProcessedUpdate {
  handler: string;
  updateName?: string;
  args: unknown[];
}

/*
    There's a surprising amount going on with the workflow below. Let's simplify it to just updateA and updateB 
    (no updateC or the default) and walk through it.

    1. setHandler for updateA
    - this is all synchronous code until we run `UpdateScope.updateWithInfo(updateId, name, doUpdateImpl)`, 
      which calls `doUpdateImpl` which is promise/async, so...
    2. queue doUpdateImpl for A on node event queue: [doUpdateImplA]
    3. continue running the workflow code (currently running code, we aren't awaiting the promise)
    4. setHandler for updateB
    - same deal as A
    5. queue doUpdateImpl for B on node event queue: [doUpdateImplA, doUpdateImplB]
    6. finished workflow code, go through the event queue
    7. doUpdateImplA
    - synchronous until we get to `execute`, which means we've accepted the update, command ordering [acceptA]
    8. `execute` returns a promise, add it to the node event queue: [doUpdateImplB, executeA]
    9. doUpdateImplB
    - same deal as A, command ordering [acceptA, acceptB]
    - `execute` returns promise, node event queue [executeA, executeB]
    10. execute update A, node event queue [executeB], command ordering [acceptA, acceptB, executeA]
    11. execute update B, node event queue [] (empty), command ordering [acceptA, acceptB, executeA, executeB]

    The only additional complexity with the workflow below is that once the default handler is registered, buffered updates for C will be
    dispatched to the default handler. So in this scenario: C1, C2 -> default registered -> C registered, both C1 and C2 will be dispatched
    to the default handler.
*/
export async function updatesOrdering(): Promise<void> {
  setHandler(updateA, (...args: any[]) => {
    return { handler: 'updateA', args };
  });
  setHandler(updateB, (...args: any[]) => {
    return { handler: 'updateB', args };
  });
  setDefaultUpdateHandler((updateName, ...args: any[]) => {
    return { handler: 'default', updateName, args };
  });
  setHandler(updateC, (...args: any[]) => {
    return { handler: 'updateC', args };
  });
}

export async function updatesAreReentrant(): Promise<void> {
  function handlerA(...args: any[]) {
    setHandler(updateA, undefined);
    setHandler(updateB, handlerB);
    return { handler: 'updateA', args };
  }
  function handlerB(...args: any[]) {
    setHandler(updateB, undefined);
    setHandler(updateC, handlerC);
    return { handler: 'updateB', args };
  }
  function handlerC(...args: any[]) {
    setHandler(updateC, undefined);
    setDefaultUpdateHandler(defaultHandler);
    return { handler: 'updateC', args };
  }
  function defaultHandler(updateName: string, ...args: any[]) {
    setDefaultUpdateHandler(undefined);
    setHandler(updateA, handlerA);
    return { handler: 'default', updateName, args };
  }

  setHandler(updateA, handlerA);
}
