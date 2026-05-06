import { nextPreloadedCounterValue } from './preload-shared-counter-helper';

export async function preloadSharedCounter(): Promise<number> {
  return nextPreloadedCounterValue();
}
