import * as nexus from 'nexus-rpc';
import type { Workflow, WorkflowResultType, WithWorkflowArgs } from '@temporalio/common';
import type { Replace } from '@temporalio/common/lib/type-helpers';
import type {
  Client,
  WorkflowStartOptions as ClientWorkflowStartOptions,
  WorkflowSignalWithStartOptions as ClientWorkflowSignalWithStartOptions,
} from '@temporalio/client';
import { type temporal } from '@temporalio/proto';
import type {
  InternalWorkflowHandle,
  InternalWorkflowSignalOptions,
  InternalWorkflowStartOptions,
} from '@temporalio/client/lib/internal';
import { InternalWorkflowSignalOptionsSymbol, InternalWorkflowStartOptionsSymbol } from '@temporalio/client/lib/internal';
import { convertNexusLinkToTemporalLink, convertTemporalLinkToNexusLink } from './link-converter';
import {
  assertWorkflowRunOperationToken,
  generateWorkflowRunOperationToken,
  loadOperationToken,
  loadWorkflowRunOperationToken,
  OperationTokenType,
} from './token';
import {
  getClient,
  getHandlerContext,
  log,
  type TemporalCancelOperationContext,
  type TemporalStartOperationContext,
} from './context';

declare const isNexusWorkflowHandle: unique symbol;
declare const workflowResultType: unique symbol;

/**
 * A handle to a running workflow that is returned by the {@link startWorkflow} helper.
 * This handle should be returned by {@link WorkflowRunOperationStartHandler} implementations.
 *
 * The type parameter `T` carries the workflow's result type for downstream type inference in
 * {@link WorkflowRunOperationHandler}. It is encoded in the {@link workflowResultType} brand so
 * that `WorkflowHandle<string>` and `WorkflowHandle<number>` are structurally distinct.
 *
 * @experimental Nexus support in Temporal SDK is experimental.
 */
export interface WorkflowHandle<T> {
  readonly workflowId: string;
  readonly runId: string;

  /**
   * Virtual type brand to maintain a distinction between {@link WorkflowHandle} provided by the
   * {@link startWorkflow} helper (which will have attached links, request ID, completion URL, etc)
   * and the `WorkflowHandle` type returned by the {@link WorkflowClient.start}.
   *
   * @internal
   * @hidden
   *
   * @experimental Nexus support in Temporal SDK is experimental.
   */
  readonly [isNexusWorkflowHandle]: typeof isNexusWorkflowHandle;

  /**
   * Type brand that carries the workflow's result type, making `WorkflowHandle<X>` structurally
   * distinct from `WorkflowHandle<Y>` so TypeScript can catch type mismatches.
   *
   * @internal
   * @hidden
   *
   * @experimental Nexus support in Temporal SDK is experimental.
   */
  readonly [workflowResultType]: T;
}

/**
 * Options for starting a workflow using {@link startWorkflow}, this type is identical to the
 * client's `WorkflowStartOptions` with the exception that `taskQueue` is optional and defaults
 * to the current worker's task queue.
 *
 * @experimental Nexus support in Temporal SDK is experimental.
 */
export type WorkflowStartOptions<T extends Workflow> = Replace<ClientWorkflowStartOptions<T>, { taskQueue?: string }>;

/**
 * Starts a workflow run for a {@link WorkflowRunOperationStartHandler}, linking the execution chain
 * to a Nexus Operation (subsequent runs started from continue-as-new and retries). Automatically
 * propagates the callback, request ID, and request and response links from the Nexus options to the
 * Workflow.
 *
 * @experimental Nexus support in Temporal SDK is experimental.
 */
export async function startWorkflow<T extends Workflow>(
  ctx: nexus.StartOperationContext,
  workflowTypeOrFunc: string | T,
  workflowOptions: WorkflowStartOptions<T>
): Promise<WorkflowHandle<WorkflowResultType<T>>> {
  const { client, taskQueue } = getHandlerContext();
  const links = requestLinksToTemporalLinks(ctx);
  const internalOptions: InternalWorkflowStartOptions[typeof InternalWorkflowStartOptionsSymbol] = {
    links,
    requestId: ctx.requestId,
  };

  internalOptions.onConflictOptions = {
    attachLinks: true,
    attachCompletionCallbacks: true,
    attachRequestId: true,
  };

  // Add nexus-operation-token header to solve for race between Workflow completion
  // and Nexus Operation start recording
  const callbackHeaders = {
    ...ctx.callbackHeaders,
    'nexus-operation-token': generateWorkflowRunOperationToken(client.options.namespace, workflowOptions.workflowId),
  };

  if (ctx.callbackUrl) {
    internalOptions.completionCallbacks = [
      {
        nexus: { url: ctx.callbackUrl, header: callbackHeaders },
        links, // pass in links here as well for older servers, newer servers dedupe them.
      },
    ];
  }

  const { taskQueue: userSpecifiedTaskQueue, ...rest } = workflowOptions;
  const startOptions: ClientWorkflowStartOptions = {
    ...rest,
    taskQueue: userSpecifiedTaskQueue || taskQueue,
    [InternalWorkflowStartOptionsSymbol]: internalOptions,
  };

  const handle = await client.workflow.start(workflowTypeOrFunc, startOptions);
  pushResponseLink(ctx, internalOptions.responseLink);

  return {
    workflowId: handle.workflowId,
    runId: handle.firstExecutionRunId,
  } as WorkflowHandle<WorkflowResultType<T>>;
}

/**
 * Converts the request links carried on the operation start context into Temporal links so
 * they can be forwarded onto an outgoing Workflow RPC (signal, signalWithStart, start). Links that
 * fail to convert are logged and dropped.
 */
function requestLinksToTemporalLinks(ctx: nexus.StartOperationContext): temporal.api.common.v1.ILink[] {
  const links = Array<temporal.api.common.v1.ILink>();
  if (ctx.inboundLinks?.length > 0) {
    for (const l of ctx.inboundLinks) {
      try {
        links.push(convertNexusLinkToTemporalLink(l));
      } catch (error) {
        log.warn('failed to convert Nexus link to Workflow event link', { error });
      }
    }
  }
  return links;
}

/**
 * Pushes a response link returned by an outbound Workflow RPC onto the operation's outbound links so
 * the Nexus task handler attaches it to the StartOperationResponse, linking the caller Workflow's
 * NexusOperation history event back to the callee Workflow's event. No-op when the server did not
 * return a response link (older servers, or CHASM signal response links disabled).
 */
function pushResponseLink(
  ctx: nexus.StartOperationContext,
  responseLink: temporal.api.common.v1.ILink | undefined
): void {
  if (responseLink == null) {
    return;
  }
  try {
    ctx.outboundLinks.push(convertTemporalLinkToNexusLink(responseLink));
  } catch (error) {
    log.warn('failed to convert temporal link to Nexus link', { error });
  }
}

/**
 * Sends a Signal to a Workflow as part of a Nexus Operation, forwarding the request links onto
 * the Signal request and propagating the response link the server returns (when supported) so the
 * caller Workflow's NexusOperation history event links to the WorkflowExecutionSignaled event on
 * the callee.
 *
 * @experimental Nexus support in Temporal SDK is experimental.
 */
export async function signalWorkflow(
  ctx: nexus.StartOperationContext,
  workflowId: string,
  signalName: string,
  args: unknown[] = []
): Promise<void> {
  const { client } = getHandlerContext();
  const links = requestLinksToTemporalLinks(ctx);

  // Signal through a regular WorkflowHandle rather than a dedicated client method, so the Nexus
  // link-forwarding plumbing stays off the public WorkflowClient surface. We attach the request
  // links to the handle via the SDK-internal symbol; the signal handler reads them and writes the
  // server's response link back onto the same payload.
  const handle = client.workflow.getHandle(workflowId) as InternalWorkflowHandle;
  const internalOptions: NonNullable<InternalWorkflowSignalOptions[typeof InternalWorkflowSignalOptionsSymbol]> = {
    links,
  };
  handle[InternalWorkflowSignalOptionsSymbol] = internalOptions;
  await handle.signal(signalName, ...args);
  pushResponseLink(ctx, internalOptions.responseLink);
}

/**
 * Options for {@link signalWithStartWorkflow}, identical to the client's `WorkflowSignalWithStartOptions`
 * except that `taskQueue` is optional and defaults to the current worker's task queue.
 *
 * @experimental Nexus support in Temporal SDK is experimental.
 */
export type WorkflowSignalWithStartOptions<SignalArgs extends any[] = []> = Replace<
  ClientWorkflowSignalWithStartOptions<SignalArgs>,
  { taskQueue?: string }
>;

/**
 * Signals a Workflow, starting it first if it is not already running, as part of a Nexus Operation.
 * Forwards the inbound Nexus links onto both the WorkflowExecutionStarted and
 * WorkflowExecutionSignaled events and propagates the response link the server returns (when
 * supported) so the caller Workflow's NexusOperation history event links to the callee's signal
 * event.
 *
 * @experimental Nexus support in Temporal SDK is experimental.
 */
export async function signalWithStartWorkflow<T extends Workflow, SignalArgs extends any[] = []>(
  ctx: nexus.StartOperationContext,
  workflowTypeOrFunc: string | T,
  workflowOptions: WithWorkflowArgs<T, WorkflowSignalWithStartOptions<SignalArgs>>
): Promise<WorkflowHandle<WorkflowResultType<T>>> {
  const { client, taskQueue } = getHandlerContext();
  const links = requestLinksToTemporalLinks(ctx);
  const internalOptions: NonNullable<InternalWorkflowStartOptions[typeof InternalWorkflowStartOptionsSymbol]> = {
    links,
  };

  const { taskQueue: userSpecifiedTaskQueue, ...rest } = workflowOptions;
  const signalWithStartOptions = {
    ...rest,
    taskQueue: userSpecifiedTaskQueue || taskQueue,
    [InternalWorkflowStartOptionsSymbol]: internalOptions,
  } as unknown as WithWorkflowArgs<T, ClientWorkflowSignalWithStartOptions<SignalArgs>>;

  const handle = await client.workflow.signalWithStart(workflowTypeOrFunc, signalWithStartOptions);
  pushResponseLink(ctx, internalOptions.signalResponseLink);

  return {
    workflowId: handle.workflowId,
    runId: handle.signaledRunId,
  } as WorkflowHandle<WorkflowResultType<T>>;
}

/**
 * A handler function for the {@link WorkflowRunOperationHandler} constructor.
 *
 * @experimental Nexus support in Temporal SDK is experimental.
 */
export type WorkflowRunOperationStartHandler<I, O> = (
  ctx: nexus.StartOperationContext,
  input: I
) => Promise<WorkflowHandle<O>>;

/**
 * A Nexus Operation implementation that is backed by a Workflow run.
 *
 * @experimental Nexus support in Temporal SDK is experimental.
 */
export class WorkflowRunOperationHandler<I, O> implements nexus.OperationHandler<I, O> {
  constructor(readonly handler: WorkflowRunOperationStartHandler<I, O>) {}

  async start(ctx: nexus.StartOperationContext, input: I): Promise<nexus.HandlerStartOperationResult<O>> {
    const { namespace } = getHandlerContext();
    const handle = await this.handler(ctx, input);
    return nexus.HandlerStartOperationResult.async(generateWorkflowRunOperationToken(namespace, handle.workflowId));
  }

  async cancel(_ctx: nexus.CancelOperationContext, token: string): Promise<void> {
    const decoded = loadWorkflowRunOperationToken(token);
    await getClient().workflow.getHandle(decoded.wid).cancel();
  }
}

/**
 * Module-private brand and payload key for {@link TemporalOperationResult}.
 */
const operationResult: unique symbol = Symbol('temporal_nexus_TemporalOperationResult');

/**
 * A result produced by a {@link TemporalOperationHandler}. Construct via
 * {@link TemporalOperationResult.sync} or {@link TemporalOperationResult.async}.

 * @experimental Nexus support in Temporal SDK is experimental.
 */
export interface TemporalOperationResult<T> {
  readonly [operationResult]: nexus.HandlerStartOperationResult<T>;
}

export const TemporalOperationResult = {
  sync<T>(value: T): TemporalOperationResult<T> {
    return {
      [operationResult]: nexus.HandlerStartOperationResult.sync(value),
    };
  },

  async<T = unknown>(token: string): TemporalOperationResult<T> {
    return {
      [operationResult]: nexus.HandlerStartOperationResult.async(token),
    };
  },
};

/**
 * A Nexus-aware Temporal Client for use inside {@link TemporalOperationHandler} implementations.
 *
 * @experimental Nexus support in Temporal SDK is experimental.
 */
export interface TemporalNexusClient {
  /**
   * The Temporal Client for the active Nexus Operation.
   *
   * @experimental Nexus support in Temporal SDK is experimental.
   */
  readonly client: Client;

  /**
   * Starts a workflow run as the asynchronous backing operation for the current Nexus Operation.
   *
   * @experimental Nexus support in Temporal SDK is experimental.
   */
  startWorkflow<T extends Workflow>(
    workflowTypeOrFunc: string | T,
    workflowOptions: WorkflowStartOptions<T>
  ): Promise<TemporalOperationResult<WorkflowResultType<T>>>;

  /**
   * Sends a Signal to a Workflow, forwarding the Nexus Operation's request links onto the Signal
   * request and propagating the response link the server returns (when supported).
   *
   * @experimental Nexus support in Temporal SDK is experimental.
   */
  signalWorkflow(workflowId: string, signalName: string, args?: unknown[]): Promise<void>;

  /**
   * Signals a Workflow, starting it first if it is not already running, forwarding the Nexus
   * Operation's request links and propagating the response link the server returns (when supported).
   *
   * @experimental Nexus support in Temporal SDK is experimental.
   */
  signalWithStartWorkflow<T extends Workflow, SignalArgs extends any[] = []>(
    workflowTypeOrFunc: string | T,
    workflowOptions: WithWorkflowArgs<T, WorkflowSignalWithStartOptions<SignalArgs>>
  ): Promise<void>;
}

class TemporalNexusClientImpl implements TemporalNexusClient {
  private asyncOperationStarted = false;

  constructor(private readonly startOperationContext: TemporalStartOperationContext) {}

  /**
   * The Temporal Client for the active Nexus Operation.
   *
   * @experimental Nexus support in Temporal SDK is experimental.
   */
  public get client(): Client {
    return getClient();
  }

  /**
   * Starts a workflow run as the asynchronous backing operation for the current Nexus Operation.
   *
   * @experimental Nexus support in Temporal SDK is experimental.
   */
  public async startWorkflow<T extends Workflow>(
    workflowTypeOrFunc: string | T,
    workflowOptions: WorkflowStartOptions<T>
  ): Promise<TemporalOperationResult<WorkflowResultType<T>>> {
    return await this.withAsyncOperationStartReservation(async () => {
      const handle = await startWorkflow(this.startOperationContext, workflowTypeOrFunc, workflowOptions);
      const { namespace } = getHandlerContext();
      return TemporalOperationResult.async(generateWorkflowRunOperationToken(namespace, handle.workflowId));
    });
  }

  /**
   * Sends a Signal to a Workflow, forwarding the Nexus Operation's request links and propagating the
   * response link the server returns (when supported).
   *
   * @experimental Nexus support in Temporal SDK is experimental.
   */
  public async signalWorkflow(workflowId: string, signalName: string, args: unknown[] = []): Promise<void> {
    await signalWorkflow(this.startOperationContext, workflowId, signalName, args);
  }

  /**
   * Signals a Workflow, starting it first if it is not already running, forwarding the Nexus
   * Operation's request links and propagating the response link the server returns (when supported).
   *
   * @experimental Nexus support in Temporal SDK is experimental.
   */
  public async signalWithStartWorkflow<T extends Workflow, SignalArgs extends any[] = []>(
    workflowTypeOrFunc: string | T,
    workflowOptions: WithWorkflowArgs<T, WorkflowSignalWithStartOptions<SignalArgs>>
  ): Promise<void> {
    await signalWithStartWorkflow(this.startOperationContext, workflowTypeOrFunc, workflowOptions);
  }

  private async withAsyncOperationStartReservation<T>(fn: () => Promise<T>): Promise<T> {
    if (this.asyncOperationStarted) {
      throw new nexus.HandlerError(
        'BAD_REQUEST',
        'Only one async operation can be started per operation handler invocation. Use TemporalNexusClient.client for additional workflow interactions'
      );
    }

    this.asyncOperationStarted = true;
    try {
      return await fn();
    } catch (err) {
      this.asyncOperationStarted = false;
      throw err;
    }
  }
}

/**
 * A handler function for the {@link TemporalOperationHandler} constructor.
 *
 * @experimental Nexus support in Temporal SDK is experimental.
 */
export type TemporalOperationStartHandler<I, O> = (
  ctx: TemporalStartOperationContext,
  client: TemporalNexusClient,
  input: I
) => Promise<TemporalOperationResult<O>>;

/**
 * Options passed to a {@link TemporalOperationHandlerOptions.cancelWorkflowRun} handler describing
 * the workflow run to cancel.
 *
 * @experimental Nexus support in Temporal SDK is experimental.
 */
export interface CancelWorkflowRunOptions {
  /**
   * The ID of the workflow backing the Nexus Operation that is being canceled.
   */
  readonly workflowId: string;
}

/**
 * Options for customizing a {@link TemporalOperationHandler}.
 *
 * @experimental Nexus support in Temporal SDK is experimental.
 */
export interface TemporalOperationHandlerOptions {
  cancelWorkflowRun?: (ctx: TemporalCancelOperationContext, options: CancelWorkflowRunOptions) => Promise<void>;
}

/**
 * A Nexus Operation implementation for operations that interact with Temporal.
 *
 * @experimental Nexus support in Temporal SDK is experimental.
 */
export class TemporalOperationHandler<I, O> implements nexus.OperationHandler<I, O> {
  private readonly startHandler: TemporalOperationStartHandler<I, O>;
  private readonly cancelWorkflowRunHandler: NonNullable<TemporalOperationHandlerOptions['cancelWorkflowRun']>;

  constructor(options: { start: TemporalOperationStartHandler<I, O> } & TemporalOperationHandlerOptions) {
    this.startHandler = options.start;
    this.cancelWorkflowRunHandler = options.cancelWorkflowRun ?? defaultCancelWorkflowRun;
  }

  async start(ctx: nexus.StartOperationContext, input: I): Promise<nexus.HandlerStartOperationResult<O>> {
    const result = await this.startHandler(ctx, new TemporalNexusClientImpl(ctx), input);
    return result[operationResult];
  }

  async cancel(ctx: nexus.CancelOperationContext, token: string): Promise<void> {
    let opToken;
    try {
      opToken = loadOperationToken(token);
    } catch (err) {
      throw new nexus.HandlerError(nexus.HandlerErrorType.BAD_REQUEST, 'invalid operation token', { cause: err });
    }

    switch (opToken.t) {
      case OperationTokenType.WORKFLOW_RUN:
        try {
          assertWorkflowRunOperationToken(opToken);
        } catch (err) {
          throw new nexus.HandlerError(nexus.HandlerErrorType.BAD_REQUEST, 'invalid workflow run operation token', {
            cause: err,
          });
        }
        await this.cancelWorkflowRunHandler(ctx, { workflowId: opToken.wid });
        return;
      default:
        throw new nexus.HandlerError(
          nexus.HandlerErrorType.BAD_REQUEST,
          `Unsupported operation token type: ${opToken.t}`
        );
    }
  }
}

async function defaultCancelWorkflowRun(_ctx: TemporalCancelOperationContext, options: CancelWorkflowRunOptions) {
  await getClient().workflow.getHandle(options.workflowId).cancel();
}
