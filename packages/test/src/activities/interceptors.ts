import * as activity from '@temporalio/activity';
import { ConnectionLike } from '@temporalio/client';
import { defaultDataConverter, LoadedDataConverter } from '@temporalio/common';
import {
  ActivityExecuteInput,
  ActivityInboundCallsInterceptor,
  ActivityInterceptorsFactory,
  Next,
} from '@temporalio/worker';

export class ConnectionInjectorInterceptor implements ActivityInboundCallsInterceptor {
  public static createFactory(
    connection: ConnectionLike,
    dataConverter = defaultDataConverter
  ): ActivityInterceptorsFactory {
    return (_ctx: activity.Context) => ({
      inbound: [new ConnectionInjectorInterceptor(connection, dataConverter)],
    });
  }

  constructor(public readonly connection: ConnectionLike, public readonly dataConverter = defaultDataConverter) {}
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
  connection: ConnectionLike;
  dataConverter: LoadedDataConverter;
}

/**
 * Type "safe" helper to get a context with connection
 */
export function getContext(): Context {
  return activity.Context.current() as unknown as Context;
}
