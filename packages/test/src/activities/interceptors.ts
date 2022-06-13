import * as activity from '@temporalio/activity';
import { Connection } from '@temporalio/client';
import { defaultDataConverter, LoadedDataConverter } from '@temporalio/common';
import { ActivityExecuteInput, ActivityInboundCallsInterceptor, Next } from '@temporalio/worker';

export class ConnectionInjectorInterceptor implements ActivityInboundCallsInterceptor {
  constructor(public readonly connection: Connection, public readonly dataConverter = defaultDataConverter) {}
  async execute(input: ActivityExecuteInput, next: Next<ActivityInboundCallsInterceptor, 'execute'>): Promise<unknown> {
    Object.assign(activity.Context.current(), {
      connection: this.connection,
      dataConverter: this.dataConverter,
    });
    return next(input);
  }
}

/**
 * Extend the basic activity Context
 */
export interface Context extends activity.Context {
  connection: Connection;
  dataConverter: LoadedDataConverter;
}

/**
 * Type "safe" helper to get a context with connection
 */
export function getContext(): Context {
  return activity.Context.current() as unknown as Context;
}
