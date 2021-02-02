import {
  Workflow,
  WorkflowReturnType,
  WorkflowSignalType,
  WorkflowQueryType,
} from '../workflow-lib/commonjs/interfaces'; 

type EnsurePromise<F> = F extends Promise<any> ? F : Promise<F>;

/// Takes a function type F and converts it to an async version if it isn't one already
type AsyncOnly<F extends (...args: any[]) => any> = (...args: Parameters<F>) => EnsurePromise<ReturnType<F>>;

export type WorkflowClient<T extends Workflow> = {
  (...args: Parameters<T['main']>): EnsurePromise<WorkflowReturnType>;

  signal: T extends Record<'signals', Record<string, WorkflowSignalType>> ? {
    [P in keyof T['signals']]: AsyncOnly<T['signals'][P]>
  } : undefined;

  query: T extends Record<'queries', Record<string, WorkflowQueryType>> ? {
    [P in keyof T['queries']]: AsyncOnly<T['queries'][P]>
  } : undefined;
}

/// Example of how to create a WorkflowClient stub
export function workflow<T extends Workflow>(): WorkflowClient<T> {
  const ret = (...args: any) => void console.log('called main', ...args);
  ret.signal = new Proxy({}, {
    get(_, p) {
      return (...args: any[]) => void console.log('signal', p, ...args);
    }
  });
  ret.query = new Proxy({}, {
    get(_, p) {
      return (...args: any[]) => void console.log('query', p, ...args);
    }
  });
  return ret as any;
}
