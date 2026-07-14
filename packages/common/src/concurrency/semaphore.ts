/**
 * A simple counting semaphore. `release` hands a permit directly to the longest-waiting acquirer if
 * any, otherwise returns it to the pool.
 *
 * @internal
 */
export class Semaphore {
  private permits: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return;
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter();
    } else {
      this.permits += 1;
    }
  }
}
