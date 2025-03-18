import { Heap } from 'heap-js';
import { SdkComponent } from '@temporalio/common';
import { native } from '@temporalio/core-bridge';
import { DefaultLogger, LogEntry, Logger, LogTimestamp } from './logger';

/**
 * A logger that buffers logs from both Node.js and Rust Core and emits logs in the right order.
 *
 * @internal
 */
export class NativeLogCollector {
  public readonly logger: Logger;
  protected buffer = new Heap<LogEntry>((a, b) => Number(a.timestampNanos - b.timestampNanos));

  constructor(protected readonly next: Logger) {
    this.logger = new DefaultLogger('TRACE', (entry) => this.buffer.add(entry));
    this.receive = this.receive.bind(this);
  }

  /**
   * Receive logs pushed from the native layer.
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
    } catch (e) {
      console.error('Error in NativeLogCollector.receive()', e);
    }
  }

  private convertFromNativeLogEntry(entry: native.JsonString<native.LogEntry>): LogEntry | undefined {
    try {
      const log = JSON.parse(entry) as native.LogEntry;
      const timestampNanos = BigInt(log.timestamp);
      return {
        level: log.level,
        message: log.message,
        meta: {
          [LogTimestamp]: timestampNanos,
          sdkComponent: SdkComponent.core,
          ...log.fields,
        },
        timestampNanos,
      };
    } catch (e) {
      console.error('Error in NativeLogCollector.convertFromNativeLogEntry()', e, entry);
      return undefined;
    }
  }

  /**
   * Flush all buffered logs into the logger supplied to the constructor
   */
  flush(): void {
    for (const entry of this.buffer) {
      this.next.log(entry.level, entry.message, {
        [LogTimestamp]: entry.timestampNanos,
        ...entry.meta,
      });
    }
    this.buffer.clear();
  }
}
