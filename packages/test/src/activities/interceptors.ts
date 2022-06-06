import * as activity from '@temporalio/activity';
import { Connection } from '@temporalio/client';
import { ActivityExecuteInput, ActivityInboundCallsInterceptor, Next } from '@temporalio/worker';

export class ConnectionInjectorInterceptor implements ActivityInboundCallsInterceptor {
  constructor(public readonly connection: Connection) {}
  async execute(input: ActivityExecuteInput, next: Next<ActivityInboundCallsInterceptor, 'execute'>): Promise<unknown> {
    (activity.Context.current() as unknown as ContextWithConnection).connection = this.connection;
    return next(input);
  }
}

/**
 * Extend the basic Context with injected client connection
 */
export interface ContextWithConnection extends activity.Context {
  connection: Connection;
}

/**
 * Type "safe" helper to get a context with connection
 */
export function getContext(): ContextWithConnection {
  return activity.Context.current() as unknown as ContextWithConnection;
}
