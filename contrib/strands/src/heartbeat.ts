import { Context } from '@temporalio/activity';

/**
 * Wraps an async function so it heartbeats at half the activity's
 * heartbeat timeout for the duration of the call. No-op when the
 * activity has no heartbeat timeout configured.
 */
export function autoHeartbeat<Args extends unknown[], Ret>(
  fn: (...args: Args) => Promise<Ret>
): (...args: Args) => Promise<Ret> {
  return async function autoHeartbeatWrapper(this: unknown, ...args: Args): Promise<Ret> {
    const heartbeatTimeoutMs = Context.current().info.heartbeatTimeoutMs;
    let timer: NodeJS.Timeout | undefined;
    if (heartbeatTimeoutMs && heartbeatTimeoutMs > 0) {
      const interval = heartbeatTimeoutMs / 2;
      timer = setInterval(() => Context.current().heartbeat(), interval);
    }
    try {
      return await fn.apply(this, args);
    } finally {
      if (timer !== undefined) clearInterval(timer);
    }
  };
}
