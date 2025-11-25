import { WorkflowInterceptors } from '@temporalio/workflow';

const getOuterGlobal = globalThis.constructor.constructor;

export async function initAndResetFlag(): Promise<boolean> {
  getOuterGlobal(`globalThis.__dispose_ran__ = false`)();
  return checkDisposeRan();
}

export async function checkDisposeRan(): Promise<boolean> {
  return getOuterGlobal(`return globalThis.__dispose_ran__ === true`)();
}

export const interceptors = (): WorkflowInterceptors => ({
  internals: [
    {
      dispose(input, next) {
        getOuterGlobal(`globalThis.__dispose_ran__ = true`)();
        return next(input);
      },
    },
  ],
});
