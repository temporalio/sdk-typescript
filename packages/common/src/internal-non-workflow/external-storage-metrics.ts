/**
 * Accumulates external-payload-storage operation metrics over a single activation's store or
 * retrieve pass, to be reported to Core on the workflow activation completion.
 *
 * @module
 */
import Long from 'long';

import type { coresdk } from '@temporalio/proto';

/** A completed storage operation's wall-clock span, in monotonic milliseconds. */
type Interval = readonly [start: number, end: number];

/**
 * Collects the count, total size, participating drivers, and duration of external-storage
 * operations performed while processing one task, in one direction (all stores, or all retrieves).
 *
 * @internal
 * @experimental
 */
export class ExternalStorageMetricsAccumulator {
  private payloadCount = 0;
  private totalSizeBytes = 0;
  private readonly driverNames = new Set<string>();
  private readonly intervals: Interval[] = [];

  /**
   * Record one completed driver operation: `payloadCount` payloads totalling `sizeBytes`, which
   * ran over the monotonic-clock span `[startMs, endMs]`.
   */
  record(driverName: string, payloadCount: number, sizeBytes: number, startMs: number, endMs: number): void {
    this.payloadCount += payloadCount;
    this.totalSizeBytes += sizeBytes;
    this.driverNames.add(driverName);
    this.intervals.push([startMs, endMs]);
  }

  /**
   * The proto metrics, or `undefined` when no external storage occurred (so the completion field
   * is left unset).
   */
  toProto(): coresdk.common.IExternalStorageMetrics | undefined {
    if (this.payloadCount === 0) return undefined;
    // Wall-clock time storage was in flight: summing each operation's duration would
    // double-count operations that ran in parallel.
    const durationMs = unionLength(this.intervals);
    return {
      payloadCount: Long.fromNumber(this.payloadCount, true),
      totalSizeBytes: Long.fromNumber(this.totalSizeBytes, true),
      totalDuration: {
        seconds: Long.fromNumber(Math.floor(durationMs / 1000)),
        nanos: Math.round((durationMs % 1000) * 1e6),
      },
      driverNames: [...this.driverNames].sort(),
    };
  }
}

/** Total length of the union of the given intervals. */
function unionLength(intervals: readonly Interval[]): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let spanStart = sorted[0]![0];
  let spanEnd = sorted[0]![1];
  for (let i = 1; i < sorted.length; i++) {
    const [start, end] = sorted[i]!;
    if (start > spanEnd) {
      total += spanEnd - spanStart;
      spanStart = start;
      spanEnd = end;
    } else if (end > spanEnd) {
      spanEnd = end;
    }
  }
  return total + (spanEnd - spanStart);
}
