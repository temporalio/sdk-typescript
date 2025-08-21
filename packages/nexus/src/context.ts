import { AsyncLocalStorage } from 'node:async_hooks';
import { Logger, LogLevel, LogMetadata, MetricMeter } from '@temporalio/common';
import { Client } from '@temporalio/client';

// Context Storage /////////////////////////////////////////////////////////////////////////////////

// Make it safe to use @temporalio/nexus with multiple versions installed.
const asyncLocalStorageSymbol = Symbol.for('__temporal_nexus_context_storage__');
if (!(globalThis as any)[asyncLocalStorageSymbol]) {
  (globalThis as any)[asyncLocalStorageSymbol] = new AsyncLocalStorage<HandlerContext>();
}
export const asyncLocalStorage: AsyncLocalStorage<HandlerContext> = (globalThis as any)[asyncLocalStorageSymbol];

export function getHandlerContext(): HandlerContext {
  const ctx = asyncLocalStorage.getStore();
  if (ctx == null) {
    throw new ReferenceError('Not in a Nexus handler context');
  }
  return ctx;
}

/**
 * Context used internally in the SDK to propagate information from the worker to the Temporal Nexus helpers.
 *
 * @internal
 * @hidden
 */
export interface HandlerContext {
  log: Logger;
  metrics: MetricMeter;
  client: Client;
  namespace: string;
  taskQueue: string;
}

// Basic APIs //////////////////////////////////////////////////////////////////////////////////////

/**
 * A logger for use in Nexus Handler scope.
 *
 * This defaults to the `Runtime`'s Logger (see {@link Runtime.logger}). Attributes from the
 * current Nexus handler context are automatically included as metadata on every log entries. An
 * extra `sdkComponent` metadata attribute is also added, with value `nexus`; this can be used
 * for fine-grained filtering of log entries further downstream.
 *
 * To customize log attributes, register a {@link nexus.NexusOutboundCallsInterceptor} that
 * intercepts the `getLogAttributes()` method.
 *
 * @experimental Nexus support in Temporal SDK is experimental.
 */
export const log: Logger = {
  log(level: LogLevel, message: string, meta?: LogMetadata): any {
    return getHandlerContext().log.log(level, message, meta);
  },
  trace(message: string, meta?: LogMetadata): any {
    return getHandlerContext().log.trace(message, meta);
  },
  debug(message: string, meta?: LogMetadata): any {
    return getHandlerContext().log.debug(message, meta);
  },
  info(message: string, meta?: LogMetadata): any {
    return getHandlerContext().log.info(message, meta);
  },
  warn(message: string, meta?: LogMetadata): any {
    return getHandlerContext().log.warn(message, meta);
  },
  error(message: string, meta?: LogMetadata): any {
    return getHandlerContext().log.error(message, meta);
  },
};

/**
 * A metric meter for use in Nexus handler scope, with Nexus handler-specific tags.
 *
 * To add custom tags, register a {@link nexus.NexusOutboundCallsInterceptor} that
 * intercepts the `getMetricTags()` method.
 *
 * @experimental Nexus support in Temporal SDK is experimental.
 */
export const metricMeter: MetricMeter = {
  createCounter(name, unit, description) {
    return getHandlerContext().metrics.createCounter(name, unit, description);
  },
  createHistogram(name, valueType = 'int', unit, description) {
    return getHandlerContext().metrics.createHistogram(name, valueType, unit, description);
  },
  createGauge(name, valueType = 'int', unit, description) {
    return getHandlerContext().metrics.createGauge(name, valueType, unit, description);
  },
  withTags(tags) {
    return getHandlerContext().metrics.withTags(tags);
  },
};

/**
 * Returns a client to be used in a Nexus Operation's context, this Client is powered by the same
 * NativeConnection that the worker was created with.
 *
 * @experimental Nexus support in Temporal SDK is experimental.
 */
export function getClient(): Client {
  return getHandlerContext().client;
}
