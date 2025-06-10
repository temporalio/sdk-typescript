import { Heap } from 'heap-js';
import { SdkComponent } from '@temporalio/common';
import { native } from '@temporalio/core-bridge';
import { DefaultLogger, LogEntry, Logger, LogTimestamp } from './logger';

/**
 * A log collector that accepts log entries either through the TS `Logger` interface (e.g. used by
 * the Worker, and backing Workflows and Activities Context logging) or by pushing from the native
 * layer. Logs are buffered for a short period of time, then sorted and emitted to a downstream
 * logger, in the right order.
 *
 * @internal
 * @hidden
 */
export class NativeLogCollector {
  /**
   * The Logger instance ti be used to send logs to this collector
   */
  public readonly logger: Logger;

  /**
   * The downstream logger to which this collector reemits logs.
   */
  protected readonly downstream: Logger;

  protected buffer = new Heap<LogEntry>((a, b) => Number(a.timestampNanos - b.timestampNanos));

  constructor(downstream: Logger) {
    this.logger = new DefaultLogger('TRACE', (entry) => this.buffer.add(entry));
    this.downstream = downstream;
    this.receive = this.receive.bind(this);
  }

  /**
   * Accept logs pushed from the native layer.
   *
   * Called from the native layer; this function is not allowed to throw.
   */
  public receive(entries: native.JsonString<native.LogEntry>[]): void {
    try {
      for (const entry of entries) {
        const log = this.convertFromNativeLogEntry(entry);
        if (log) {
          this.buffer.add(log);
        }
      }
      this.flush();
    } catch (_e) {
      // We're not allowed to throw from here, and conversion errors have already been handled in
      // convertFromNativeLogEntry(), so an error at this point almost certainly indicates a problem
      // with the downstream logger. Just swallow it, there's really nothing else we can do.
    }
  }

  private convertFromNativeLogEntry(entry: native.JsonString<native.LogEntry>): LogEntry | undefined {
    try {
      const log = JSON.parse(entry) as native.LogEntry;
      const timestampNanos = BigInt(log.timestamp);
      return {
        message: log.message,
        timestampNanos,
        level: log.level,
        meta: {
          [LogTimestamp]: timestampNanos,
          sdkComponent: SdkComponent.core,
          target: log.target,
          spanContexts: log.spanContexts,
          ...log.fields,
        },
      };
    } catch (e) {
      this.downstream.error(`Error converting native log entry: ${e}`, {
        error: e,
        entry,
      });
      return undefined;
    }
  }

  /**
   * Flush all buffered logs into the logger supplied to the constructor/
   */
  flush(): void {
    for (const entry of this.buffer) {
      this.downstream.log(entry.level, entry.message, {
        [LogTimestamp]: entry.timestampNanos,
        ...entry.meta,
      });
    }
    this.buffer.clear();
  }
}
