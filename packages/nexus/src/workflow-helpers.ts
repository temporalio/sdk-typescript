import * as nexus from 'nexus-rpc';
import type {
  Workflow,
  WorkflowResultType,
  WithWorkflowArgs,
  SignalDefinition,
  UpdateDefinition,
} from '@temporalio/common';
import type { Replace } from '@temporalio/common/lib/type-helpers';
import type {
  Client,
  WorkflowStartOptions as ClientWorkflowStartOptions,
  WorkflowSignalWithStartOptions as ClientWorkflowSignalWithStartOptions,
} from '@temporalio/client';
import { WorkflowUpdateStage, type WorkflowUpdateOptions } from '@temporalio/client';
import { type temporal } from '@temporalio/proto';
import type {
  InternalWorkflowHandle,
  InternalWorkflowSignalOptions,
  InternalWorkflowStartOptions,
  InternalWorkflowUpdateOptions,
} from '@temporalio/client/lib/internal';
import {
  InternalWorkflowSignalOptionsSymbol,
  InternalWorkflowStartOptionsSymbol,
  InternalWorkflowUpdateOptionsSymbol,
} from '@temporalio/client/lib/internal';
import {
  convertCommonLinkToNexusLink,
  convertNexusLinkToTemporalLink,
  convertTemporalLinkToNexusLink,
} from './link-converter';
import {
  assertUpdateWorkflowOperationToken,
  assertWorkflowRunOperationToken,
  generateUpdateWorkflowOperationToken,
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
  readonly runId?: string;

  signal<Args extends any[] = [], Name extends string = string>(
    def: SignalDefinition<Args, Name> | string,
    ...args: Args
  ): Promise<void>;

  /**
   * Sends an Update to this Workflow as the backing operation for the current Nexus Operation.
   *
   * The Update request is augmented with the Nexus Operation's request ID (for deduplication), its
   * request links, and a completion callback carrying the operation token, so the Update's
   * completion is delivered back to the Nexus caller.
   *
   * Only asynchronous, `ACCEPTED`-stage Updates are supported: this method returns once the Update
   * is accepted, yielding an asynchronous {@link TemporalOperationResult} whose completion is
   * delivered via the callback. If the Update has already completed by the time it is accepted (for
   * example a retried request with the same Update ID, or an Update that completes immediately), a
   * synchronous result is returned instead; if that completed Update failed (e.g. validation
   * rejection, which is non-retryable), it surfaces as a failed Nexus Operation.
   *
   * @experimental Nexus support in Temporal SDK is experimental.
   */
  update<Ret, Args extends any[] = [], Name extends string = string>(
    def: UpdateDefinition<Ret, Args, Name> | string,
    options?: NexusUpdateWorkflowOptions<Args>
  ): Promise<TemporalOperationResult<Ret>>;

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
  if (internalOptions.responseLink != null) {
    pushResponseLink(ctx, internalOptions.responseLink);
  }

  return createWorkflowHandle(ctx, handle.workflowId, handle.firstExecutionRunId);
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
 * NexusOperation history event back to the callee Workflow's event. Callers only invoke this when the
 * server returned a response link; older servers (or CHASM signal response links disabled) leave it
 * unset, in which case there is nothing to push.
 */
function pushResponseLink(ctx: nexus.StartOperationContext, responseLink: temporal.api.common.v1.ILink) {
  try {
    ctx.outboundLinks.push(convertTemporalLinkToNexusLink(responseLink));
  } catch (error) {
    log.warn('failed to convert temporal link to Nexus link', { error });
  }
}

/**
 * Wraps the start of an async backing operation with a single-slot reservation guard. Handles minted
 * by {@link TemporalNexusClientImpl.getWorkflowHandle} pass the client instance's guard so that their
 * `update()` shares the reservation with `startWorkflow`; the standalone {@link startWorkflow} helper
 * (WorkflowRun operations) has no client-scoped guard and passes {@link passThroughReservation}.
 */
type AsyncOperationStartReservation = <T>(fn: () => Promise<T>) => Promise<T>;
const passThroughReservation: AsyncOperationStartReservation = (fn) => fn();

function createWorkflowHandle<T extends Workflow>(
  ctx: nexus.StartOperationContext,
  workflowId: string,
  runId?: string,
  reserve: AsyncOperationStartReservation = passThroughReservation
): WorkflowHandle<WorkflowResultType<T>> {
  return {
    workflowId,
    runId,

    async signal<Args extends any[] = [], Name extends string = string>(
      def: SignalDefinition<Args, Name> | string,
      ...args: Args
    ): Promise<void> {
      const { client } = getHandlerContext();
      const links = requestLinksToTemporalLinks(ctx);

      // Signal through a regular WorkflowHandle rather than a dedicated client method, so the Nexus
      // link-forwarding plumbing stays off the public WorkflowClient surface. We attach the request
      // links to the handle via the SDK-internal symbol; the signal handler reads them and writes the
      // server's response link back onto the same payload.
      const handle = client.workflow.getHandle(this.workflowId, this.runId) as InternalWorkflowHandle;
      const internalOptions: InternalWorkflowSignalOptions[typeof InternalWorkflowSignalOptionsSymbol] = {
        links,
      };
      handle[InternalWorkflowSignalOptionsSymbol] = internalOptions;
      await handle.signal(def, ...args);
      if (internalOptions.responseLink != null) {
        pushResponseLink(ctx, internalOptions.responseLink);
      }
    },

    update<Ret, Args extends any[] = [], Name extends string = string>(
      def: UpdateDefinition<Ret, Args, Name> | string,
      options?: NexusUpdateWorkflowOptions<Args>
    ): Promise<TemporalOperationResult<Ret>> {
      return updateWorkflowOperation<Ret, Args>(ctx, this.workflowId, this.runId, def, options, reserve);
    },
  } as WorkflowHandle<WorkflowResultType<T>>;
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
  const internalOptions: InternalWorkflowStartOptions[typeof InternalWorkflowStartOptionsSymbol] = {
    links,
  };

  const { taskQueue: userSpecifiedTaskQueue, ...rest } = workflowOptions;
  const signalWithStartOptions = {
    ...rest,
    taskQueue: userSpecifiedTaskQueue || taskQueue,
    [InternalWorkflowStartOptionsSymbol]: internalOptions,
  } as unknown as WithWorkflowArgs<T, ClientWorkflowSignalWithStartOptions<SignalArgs>>;

  const handle = await client.workflow.signalWithStart(workflowTypeOrFunc, signalWithStartOptions);
  if (internalOptions.responseLink != null) {
    pushResponseLink(ctx, internalOptions.responseLink);
  }

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
 * Options for {@link WorkflowHandle.update}. The target Workflow (workflow and run IDs) is carried by
 * the {@link WorkflowHandle}, and the Update definition or name is passed as the method's first
 * argument, so only the Update ID and arguments are supplied here.
 *
 * @experimental Nexus support in Temporal SDK is experimental.
 */
export interface NexusUpdateWorkflowOptions<Args extends any[] = []> {
  /**
   * The Update ID, a unique-per-Workflow-Execution identifier for this Update.
   *
   * If unset, the Nexus request ID is used as the Update ID. This protects against a retried Nexus
   * request (e.g. after a network failure) spawning a duplicate Update.
   */
  readonly updateId?: string;

  /**
   * Arguments to pass to the Update handler.
   */
  readonly args?: Args;
}

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
   * Create a Nexus-aware handle to an existing Workflow.
   *
   * - If only `workflowId` is passed, and there are multiple Workflow Executions with that ID, the handle will refer to
   *   the most recent one.
   * - If `workflowId` and `runId` are passed, the handle will refer to the specific Workflow Execution with that Run
   *   ID.
   *
   * This method does not validate `workflowId`. If there is no Workflow Execution with the given `workflowId`, handle
   * methods like `handle.signal()` will throw a {@link WorkflowNotFoundError} error.
   *
   * @experimental Nexus support in Temporal SDK is experimental.
   */
  getWorkflowHandle<T extends Workflow>(workflowId: string, runId?: string): WorkflowHandle<WorkflowResultType<T>>;

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
  // At most one async backing operation may back a single Nexus Operation handler invocation. This
  // client is instantiated once per invocation (see TemporalOperationHandler.start), so this flag is
  // naturally scoped to the invocation without any module-level state. It is shared between
  // startWorkflow and the update() method of handles minted by getWorkflowHandle, mirroring
  // sdk-python's per-invocation `_started_async` on its Nexus client.
  private asyncOperationStarted = false;

  constructor(private readonly startOperationContext: TemporalStartOperationContext) {}

  /**
   * Reserves the single async-backing-operation slot for this invocation, runs `fn`, and releases the
   * reservation only if `fn` throws. A successful `fn` keeps the reservation set for the rest of the
   * invocation — including when a Workflow Update resolves synchronously — so the flag is predictably
   * set after any successful backing-operation attempt (matching sdk-python). Declared as an arrow
   * field so it can be passed as the reservation guard to {@link createWorkflowHandle}.
   */
  private readonly withAsyncOperationStartReservation = async <T>(fn: () => Promise<T>): Promise<T> => {
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
  };

  /**
   * The Temporal Client for the active Nexus Operation.
   *
   * @experimental Nexus support in Temporal SDK is experimental.
   */
  public get client(): Client {
    return getClient();
  }

  /**
   * Create a Nexus-aware handle to an existing Workflow.
   *
   * - If only `workflowId` is passed, and there are multiple Workflow Executions with that ID, the handle will refer to
   *   the most recent one.
   * - If `workflowId` and `runId` are passed, the handle will refer to the specific Workflow Execution with that Run
   *   ID.
   *
   * This method does not validate `workflowId`. If there is no Workflow Execution with the given `workflowId`, handle
   * methods like `handle.signal()` will throw a {@link WorkflowNotFoundError} error.
   *
   * @experimental Nexus support in Temporal SDK is experimental.
   */
  public getWorkflowHandle<T extends Workflow>(
    workflowId: string,
    runId?: string
  ): WorkflowHandle<WorkflowResultType<T>> {
    return createWorkflowHandle(this.startOperationContext, workflowId, runId, this.withAsyncOperationStartReservation);
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
   * Signals a Workflow, starting it first if it is not already running.
   *
   * @experimental Nexus support in Temporal SDK is experimental.
   */
  public async signalWithStartWorkflow<T extends Workflow, SignalArgs extends any[] = []>(
    workflowTypeOrFunc: string | T,
    workflowOptions: WithWorkflowArgs<T, WorkflowSignalWithStartOptions<SignalArgs>>
  ): Promise<void> {
    await signalWithStartWorkflow(this.startOperationContext, workflowTypeOrFunc, workflowOptions);
  }
}

/**
 * Sends an Update to a Workflow as the async backing operation for the current Nexus Operation.
 * Shared implementation behind {@link WorkflowHandle.update}; the target Workflow's `workflowId` and
 * `runId` are supplied by the handle.
 */
async function updateWorkflowOperation<Ret, Args extends any[]>(
  ctx: nexus.StartOperationContext,
  workflowId: string,
  runId: string | undefined,
  def: UpdateDefinition<Ret, Args> | string,
  options: NexusUpdateWorkflowOptions<Args> | undefined,
  reserve: AsyncOperationStartReservation
): Promise<TemporalOperationResult<Ret>> {
  if (!ctx.callbackUrl) {
    throw new nexus.HandlerError(
      nexus.HandlerErrorType.BAD_REQUEST,
      'A callback URL is required for async UpdateWorkflow operation invocations'
    );
  }

  // If no Update ID is provided, use the Nexus request ID. This protects against a retried Nexus
  // request (same request ID) spawning a duplicate Update.
  const updateId = options?.updateId || ctx.requestId;

  return await reserve(async () => {
    const { client, namespace } = getHandlerContext();
    // Token attached to the completion callback so the server can correlate the Update's
    // completion back to this operation even if it races the operation-start recording. The run ID
    // is not yet resolved at this point (the Update may target the latest run); the operation token
    // returned to the caller is regenerated below with the run ID the server resolves.
    const callbackToken = generateUpdateWorkflowOperationToken(namespace, workflowId, runId ?? '', updateId);

    const links = requestLinksToTemporalLinks(ctx);
    const callbackHeaders = {
      ...ctx.callbackHeaders,
      'nexus-operation-token': callbackToken,
    };
    const internalOptions: NonNullable<InternalWorkflowUpdateOptions[typeof InternalWorkflowUpdateOptionsSymbol]> = {
      requestId: ctx.requestId,
      links,
      completionCallbacks: [
        {
          nexus: { url: ctx.callbackUrl, header: callbackHeaders },
          links, // included for older servers; newer servers dedupe them.
        },
      ],
    };

    // Typed as a local variable rather than an inline literal so the SDK-internal symbol can be
    // attached: excess-property checks don't apply to variables, so the symbol is accepted without
    // an `any` cast while `args` stays type-checked against the Update definition.
    const startUpdateOptions: WorkflowUpdateOptions & {
      args?: Args;
      waitForStage: typeof WorkflowUpdateStage.ACCEPTED;
    } & InternalWorkflowUpdateOptions = {
      args: options?.args,
      updateId,
      waitForStage: WorkflowUpdateStage.ACCEPTED,
      [InternalWorkflowUpdateOptionsSymbol]: internalOptions,
    };

    // `InternalWorkflowHandle` exposes a single, non-overloaded `startUpdate` (the public one is
    // overloaded to discriminate empty vs non-empty argument tuples, which a generic
    // `Args extends any[]` satisfies neither of) that also accepts the internal update options.
    const wfHandle = client.workflow.getHandle(workflowId, runId) as InternalWorkflowHandle;
    const handle = await wfHandle.startUpdate<Ret, Args>(def, startUpdateOptions);

    // The server resolves the Update against a concrete run (the requested run, or the latest run
    // when none was pinned) and returns its ID. Use that resolved run ID in the operation token so
    // the token — and any cancellation later addressed through it — targets the actual run.
    const resolvedRunId = handle.workflowRunId ?? runId ?? '';

    if (internalOptions.responseLink != null) {
      // Attach the link the server returned (a WorkflowEvent link on success, or a Workflow link
      // when there is no history event, e.g. validation failure) as a handler link.
      try {
        ctx.outboundLinks.push(convertCommonLinkToNexusLink(internalOptions.responseLink));
      } catch (err) {
        log.warn('failed to convert UpdateWorkflow response link to Nexus link', { error: err });
      }
    }

    if (internalOptions.outcome != null) {
      // The Update already reached a terminal outcome (e.g. a retried request with the same Update
      // ID, or an immediate completion). Return a synchronous result; if it failed (validation
      // rejection is non-retryable), surface it as a failed Nexus operation.
      try {
        const result = (await handle.result()) as Ret;
        return TemporalOperationResult.sync(result);
      } catch (err) {
        // Throwing releases the reservation via withAsyncOperationStartReservation; on a synchronous
        // success the reservation is intentionally kept set for the rest of the handler invocation.
        throw new nexus.OperationError('failed', (err as Error).message, { cause: err as Error });
      }
    }

    return TemporalOperationResult.async<Ret>(
      generateUpdateWorkflowOperationToken(namespace, workflowId, resolvedRunId, updateId)
    );
  });
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
 * Options passed to a {@link TemporalOperationHandlerOptions.cancelWorkflowUpdate} handler describing
 * the Workflow Update to cancel.
 *
 * @experimental Nexus support in Temporal SDK is experimental.
 */
export interface CancelWorkflowUpdateOptions {
  /**
   * The ID of the workflow whose Update backs the Nexus Operation that is being canceled.
   */
  readonly workflowId: string;

  /**
   * The Run ID extracted from the operation token. May be empty if the run was not pinned.
   */
  readonly runId: string;

  /**
   * The ID of the Update to cancel.
   */
  readonly updateId: string;
}

/**
 * Options for customizing a {@link TemporalOperationHandler}.
 *
 * @experimental Nexus support in Temporal SDK is experimental.
 */
export interface TemporalOperationHandlerOptions {
  /**
   * Handler invoked to cancel a workflow-run-backed operation. Defaults to canceling the workflow.
   */
  cancelWorkflowRun?: (ctx: TemporalCancelOperationContext, options: CancelWorkflowRunOptions) => Promise<void>;

  /**
   * Handler invoked to cancel an UpdateWorkflow-backed operation.
   *
   * There is no meaningful default behavior for canceling a Workflow Update, so if this is not
   * provided, canceling such an operation fails with a `NOT_IMPLEMENTED` Nexus handler error.
   */
  cancelWorkflowUpdate?: (ctx: TemporalCancelOperationContext, options: CancelWorkflowUpdateOptions) => Promise<void>;
}

/**
 * A Nexus Operation implementation for operations that interact with Temporal.
 *
 * @experimental Nexus support in Temporal SDK is experimental.
 */
export class TemporalOperationHandler<I, O> implements nexus.OperationHandler<I, O> {
  private readonly startHandler: TemporalOperationStartHandler<I, O>;
  private readonly cancelWorkflowRunHandler: NonNullable<TemporalOperationHandlerOptions['cancelWorkflowRun']>;
  private readonly cancelWorkflowUpdateHandler: NonNullable<TemporalOperationHandlerOptions['cancelWorkflowUpdate']>;

  constructor(options: { start: TemporalOperationStartHandler<I, O> } & TemporalOperationHandlerOptions) {
    this.startHandler = options.start;
    this.cancelWorkflowRunHandler = options.cancelWorkflowRun ?? defaultCancelWorkflowRun;
    this.cancelWorkflowUpdateHandler = options.cancelWorkflowUpdate ?? defaultCancelWorkflowUpdate;
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
      case OperationTokenType.UPDATE_WORKFLOW:
        try {
          assertUpdateWorkflowOperationToken(opToken);
        } catch (err) {
          throw new nexus.HandlerError(nexus.HandlerErrorType.BAD_REQUEST, 'invalid update workflow operation token', {
            cause: err,
          });
        }
        await this.cancelWorkflowUpdateHandler(ctx, {
          workflowId: opToken.wid,
          runId: opToken.rid ?? '',
          updateId: opToken.uid,
        });
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

async function defaultCancelWorkflowUpdate(
  _ctx: TemporalCancelOperationContext,
  _options: CancelWorkflowUpdateOptions
): Promise<never> {
  // There is no default way to cancel a Workflow Update; users must supply a cancelWorkflowUpdate
  // handler if their operation needs to support cancellation.
  throw new nexus.HandlerError(nexus.HandlerErrorType.NOT_IMPLEMENTED, 'cannot cancel an UpdateWorkflow operation');
}
