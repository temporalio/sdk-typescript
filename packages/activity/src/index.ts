import { AbortSignal } from 'abort-controller';
import { Context as ContextLike } from './types';
import { asyncLocalStorage } from './internals';
export { CancellationError } from './types';

export class Context {
  protected cancel: (reason?: any) => void = () => undefined;

  constructor(public readonly cancelled: Promise<never>, public readonly cancellationSignal: AbortSignal) {}

  public static current(): ContextLike {
    const store = asyncLocalStorage.getStore();
    if (store === undefined) {
      throw new Error('Activity context not initialized');
    }
    return store;
  }
}
