import { type AsyncLocalStorage } from 'async_hooks';
import * as otel from '@opentelemetry/api';

export class ContextManager implements otel.ContextManager {
  // The workflow sandbox provides AsyncLocalStorage through globalThis.
  protected storage: AsyncLocalStorage<otel.Context> = new (globalThis as any).AsyncLocalStorage();

  active(): otel.Context {
    return this.storage.getStore() || otel.ROOT_CONTEXT;
  }

  bind<T>(context: otel.Context, target: T): T {
    if (typeof target !== 'function') {
      throw new TypeError(`Only function binding is supported, got ${typeof target}`);
    }

    // Stolen from https://github.com/open-telemetry/opentelemetry-js/blob/main/packages/opentelemetry-context-async-hooks/src/AbstractAsyncHooksContextManager.ts
    const contextWrapper = (...args: unknown[]) => {
      return this.with(context, () => target.apply(this, args));
    };
    Object.defineProperty(contextWrapper, 'length', {
      enumerable: false,
      configurable: true,
      writable: false,
      value: target.length,
    });
    /**
     * It isn't possible to tell Typescript that contextWrapper is the same as T
     * so we forced to cast as any here.
     */
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return contextWrapper as any;
  }

  enable(): this {
    return this;
  }

  disable(): this {
    this.storage.disable();
    return this;
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    context: otel.Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    const cb = thisArg == null ? fn : fn.bind(thisArg);
    return this.storage.run(context, cb, ...args);
  }
}
