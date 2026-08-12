import type * as nexus from 'nexus-rpc';
import type { HandlerContext } from '../context';

/**
 * Builds a minimal {@link nexus.StartOperationContext} for driving a start handler directly, without
 * a live worker.
 */
export function makeStartContext(overrides: Partial<nexus.StartOperationContext> = {}): nexus.StartOperationContext {
  return {
    service: 'service',
    operation: 'operation',
    headers: {},
    abortSignal: new AbortController().signal,
    requestId: 'request-id',
    inboundLinks: [],
    outboundLinks: [],
    ...overrides,
  };
}

/**
 * Builds the handler context the worker would otherwise install, backed by the given stand-in client.
 * Only the fields the Workflow helpers read are populated.
 */
export function makeHandlerContext(client: HandlerContext['client']): HandlerContext {
  return {
    log: { trace() {}, debug() {}, info() {}, warn() {}, error() {} } as unknown as HandlerContext['log'],
    metrics: {} as HandlerContext['metrics'],
    client,
    namespace: 'ns',
    taskQueue: 'tq',
    endpoint: 'endpoint',
  };
}
