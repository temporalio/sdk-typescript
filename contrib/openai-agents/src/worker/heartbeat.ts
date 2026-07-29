import { heartbeat, activityInfo } from '@temporalio/activity';

/**
 * Starts a recurring heartbeat loop driven by the active Activity's
 * `heartbeatTimeoutMs`. The loop fires immediately, then re-schedules
 * itself at `heartbeatTimeoutMs / 2` to keep well clear of the timeout.
 *
 * Returns a `stop` function that cancels the loop. If the Activity has no
 * `heartbeatTimeoutMs` configured, no heartbeats are sent and `stop` is a no-op.
 *
 * Heartbeat errors are swallowed: the Activity may already be cancelled, in
 * which case the next `heartbeat()` call would throw and we don't want that
 * to mask the Activity's primary work.
 */
export function startAdaptiveHeartbeat(): () => void {
  const info = activityInfo();
  if (!info.heartbeatTimeoutMs || info.heartbeatTimeoutMs <= 0) {
    return () => {};
  }

  const interval = info.heartbeatTimeoutMs / 2;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = () => {
    if (stopped) return;
    try {
      heartbeat();
    } catch {
      // Activity might be cancelled — ignore heartbeat errors
    }
    timer = setTimeout(tick, interval);
  };

  // Fire immediately so slow startup doesn't blow the timeout, then loop.
  tick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
