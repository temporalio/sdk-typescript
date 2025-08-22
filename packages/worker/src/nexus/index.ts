import * as nexus from 'nexus-rpc';

import {
  CancelledFailure,
  IllegalStateError,
  LoadedDataConverter,
  Payload,
  SdkComponent,
  LoggerWithComposedMetadata,
  MetricMeter,
  MetricMeterWithComposedTags,
  MetricTags,
} from '@temporalio/common';
import { temporal, coresdk } from '@temporalio/proto';
import { asyncLocalStorage } from '@temporalio/nexus/lib/context';
import { encodeToPayload } from '@temporalio/common/lib/internal-non-workflow';
import { isAbortError } from '@temporalio/common/lib/type-helpers';
import { composeInterceptors } from '@temporalio/common/lib/interceptors';
import { Client } from '@temporalio/client';
import { Logger } from '../logger';
import { NexusInboundCallsInterceptor, NexusInterceptorsFactory, NexusOutboundCallsInterceptor } from '../interceptors';
import {
  coerceToHandlerError,
  decodePayloadIntoLazyValue,
  handlerErrorToProto,
  operationErrorToProto,
} from './conversions';

const UNINITIALIZED = Symbol();

export class NexusHandler {
  /**
   * Logger bound to `sdkComponent: worker`, with metadata from this Nexus task.
   * This is the logger to use for all log messages emitted by the Nexus
   * worker. Note this is not exactly the same thing as the Nexus context
   * logger, which is bound to `sdkComponent: nexus`.
   */
  private readonly logger: Logger;

  /**
   * Metric Meter with tags from this Nexus task, including tags from interceptors.
   */
  private readonly metricMeter: MetricMeter;

  /**
   * List of interceptors for this Nexus task.
   */
  private readonly interceptors: { inbound: NexusInboundCallsInterceptor[]; outbound: NexusOutboundCallsInterceptor[] };

  constructor(
    public readonly taskToken: Uint8Array,
    public readonly namespace: string,
    public readonly taskQueue: string,
    public readonly context: nexus.OperationContext,
    public readonly client: Client,
    public readonly abortController: AbortController,
    public readonly serviceRegistry: nexus.ServiceRegistry,
    public readonly dataConverter: LoadedDataConverter,
    workerLogger: Logger,
    workerMetricMeter: MetricMeter,
    interceptors: NexusInterceptorsFactory[]
  ) {
    this.logger = LoggerWithComposedMetadata.compose(workerLogger, this.getLogAttributes.bind(this));
    this.metricMeter = MetricMeterWithComposedTags.compose(workerMetricMeter, this.getMetricTags.bind(this));

    this.interceptors = { inbound: [], outbound: [] };
    interceptors
      .map((factory) => factory(this.context))
      .forEach(({ inbound, outbound }) => {
        if (inbound) this.interceptors.inbound.push(inbound);
        if (outbound) this.interceptors.outbound.push(outbound);
      });
  }

  public getLogAttributes(): Record<string, unknown> {
    const logAttributes = {
      namespace: this.namespace,
      taskQueue: this.taskQueue,
      service: this.context.service,
      operation: this.context.operation,
    };
    // In case some interceptor uses the logger while initializing...
    if (this.interceptors == null) return logAttributes;
    return composeInterceptors(this.interceptors.outbound, 'getLogAttributes', (a) => a)(logAttributes);
  }

  protected getMetricTags(): MetricTags {
    const baseTags = {
      namespace: this.namespace,
      taskQueue: this.taskQueue,
      service: this.context.service,
      operation: this.context.operation,
    };
    // In case some interceptors use the metric meter while initializing...
    if (this.interceptors == null) return baseTags;
    return composeInterceptors(this.interceptors.outbound, 'getMetricTags', (a) => a)(baseTags);
  }

  protected async startOperation(
    ctx: nexus.StartOperationContext,
    payload: Payload | undefined
  ): Promise<coresdk.nexus.INexusTaskCompletion> {
    try {
      const input = await decodePayloadIntoLazyValue(this.dataConverter, payload);

      const result = await this.invokeUserCode(
        'startOperation',
        this.serviceRegistry.start.bind(this.serviceRegistry, ctx, input)
      );

      if (result.isAsync) {
        return {
          taskToken: this.taskToken,
          completed: {
            startOperation: {
              asyncSuccess: {
                operationToken: result.token,
                links: ctx.outboundLinks.map(nexusLinkToProtoLink),
              },
            },
          },
        };
      } else {
        return {
          taskToken: this.taskToken,
          completed: {
            startOperation: {
              syncSuccess: {
                payload: await encodeToPayload(this.dataConverter, result.value),
                links: ctx.outboundLinks.map(nexusLinkToProtoLink),
              },
            },
          },
        };
      }
    } catch (err) {
      if (err instanceof nexus.OperationError) {
        return {
          taskToken: this.taskToken,
          completed: {
            startOperation: {
              operationError: await operationErrorToProto(this.dataConverter, err),
            },
          },
        };
      }
      return {
        taskToken: this.taskToken,
        error: await handlerErrorToProto(this.dataConverter, coerceToHandlerError(err)),
      };
    }
  }

  protected async cancelOperation(
    ctx: nexus.CancelOperationContext,
    token: string
  ): Promise<coresdk.nexus.INexusTaskCompletion> {
    try {
      await this.invokeUserCode('cancelOperation', this.serviceRegistry.cancel.bind(this.serviceRegistry, ctx, token));
      return {
        taskToken: this.taskToken,
        completed: {
          cancelOperation: {},
        },
      };
    } catch (err) {
      return {
        taskToken: this.taskToken,
        error: await handlerErrorToProto(this.dataConverter, coerceToHandlerError(err)),
      };
    }
  }

  protected async invokeUserCode<R>(method: string, fn: () => Promise<R>): Promise<R> {
    let error: any = UNINITIALIZED; // In case someone decides to throw undefined...
    const startTime = process.hrtime.bigint();
    this.logger.debug('Nexus handler started', { method });
    try {
      return await fn();
    } catch (err: any) {
      error = err;
      throw err;
    } finally {
      const durationNanos = process.hrtime.bigint() - startTime;
      const durationMs = Number(durationNanos / 1_000_000n);

      if (error === UNINITIALIZED) {
        this.logger.debug('Nexus handler invocation completed', { method, durationMs });
      } else if ((error instanceof CancelledFailure || isAbortError(error)) && this.abortController.signal.aborted) {
        this.logger.debug('Nexus handler invocation completed as cancelled', { method, durationMs });
      } else {
        this.logger.warn('Nexus handler invocation failed', { method, error, durationMs });
      }
    }
  }

  /**
   * Actually executes the Operation.
   *
   * Any call up to this function and including this one will be trimmed out of stack traces.
   */
  protected async execute(
    task: temporal.api.workflowservice.v1.IPollNexusTaskQueueResponse
  ): Promise<coresdk.nexus.INexusTaskCompletion> {
    if (task.request?.startOperation != null) {
      const variant = task.request?.startOperation;
      return await this.startOperation(
        {
          ...this.context,
          requestId: variant.requestId ?? undefined,
          inboundLinks: (variant.links ?? []).map(protoLinkToNexusLink),
          callbackUrl: variant.callback ?? undefined,
          callbackHeaders: variant.callbackHeader ?? undefined,
          outboundLinks: [],
        },
        variant.payload ?? undefined
      );
    } else if (task.request?.cancelOperation != null) {
      const variant = task.request?.cancelOperation;
      if (variant.operationToken == null) {
        throw new nexus.HandlerError('BAD_REQUEST', 'Request missing Operation token');
      }
      return await this.cancelOperation(
        {
          ...this.context,
        },
        variant.operationToken
      );
    } else {
      throw new nexus.HandlerError('NOT_IMPLEMENTED', 'Request method not implemented');
    }
  }

  public async run(
    task: temporal.api.workflowservice.v1.IPollNexusTaskQueueResponse
  ): Promise<coresdk.nexus.INexusTaskCompletion> {
    // Ensure that client calls made with the worker's client in this handler's context are tied to the abort signal.
    // TODO: Actually support canceling requests backed by NativeConnection. Once it does, this functionality should be tested.
    return await this.client.withAbortSignal(this.abortController.signal, async () => {
      return await asyncLocalStorage.run(
        {
          client: this.client,
          namespace: this.namespace,
          taskQueue: this.taskQueue,
          log: LoggerWithComposedMetadata.compose(this.logger, { sdkComponent: SdkComponent.nexus }),
          metrics: this.metricMeter,
        },
        this.execute.bind(this, task)
      );
    });
  }
}

export function constructNexusOperationContext(
  request: temporal.api.nexus.v1.IRequest | null | undefined,
  abortSignal: AbortSignal
): nexus.OperationContext {
  const base = {
    abortSignal,
    headers: headersProxy(request?.header),
  };

  if (request?.startOperation != null) {
    const op = request.startOperation;
    if (op?.service == null) {
      throw new IllegalStateError('expected request service to not be empty');
    }
    if (op?.operation == null) {
      throw new IllegalStateError('expected request service to not be empty');
    }
    return { ...base, service: op.service, operation: op.operation };
  }
  if (request?.cancelOperation != null) {
    const op = request.cancelOperation;
    if (op?.service == null) {
      throw new IllegalStateError('expected request service to not be empty');
    }
    if (op?.operation == null) {
      throw new IllegalStateError('expected request service to not be empty');
    }
    return { ...base, service: op.service, operation: op.operation };
  }
  throw new nexus.HandlerError('NOT_IMPLEMENTED', 'Request method not implemented');
}

// TODO: That utility should be moved to the nexus-rpc package.
function headersProxy(initializer?: Record<string, string> | null): Record<string, string> {
  const headers: Record<string, string> = initializer
    ? Object.fromEntries(Object.entries(initializer).map(([k, v]) => [k.toLowerCase(), v]))
    : {};
  return new Proxy(headers, {
    get(target, p) {
      if (typeof p !== 'string') {
        throw new TypeError('header keys must be strings');
      }
      return target[p.toLowerCase()];
    },
    set(target, p, newValue) {
      if (typeof p !== 'string') {
        throw new TypeError('header keys must be strings');
      }
      if (typeof newValue !== 'string') {
        throw new TypeError('header values must be strings');
      }
      target[p.toLowerCase()] = newValue;
      return true;
    },
  });
}

function protoLinkToNexusLink(plink: temporal.api.nexus.v1.ILink): nexus.Link {
  if (!plink.url) {
    throw new nexus.HandlerError('BAD_REQUEST', 'empty link URL');
  }
  if (!plink.type) {
    throw new nexus.HandlerError('BAD_REQUEST', 'empty link type');
  }
  return {
    url: new URL(plink.url),
    type: plink.type,
  };
}

function nexusLinkToProtoLink(nlink: nexus.Link): temporal.api.nexus.v1.ILink {
  return {
    url: nlink.url.toString(),
    type: nlink.type,
  };
}
