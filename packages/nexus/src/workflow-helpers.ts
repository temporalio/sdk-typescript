import * as nexus from 'nexus-rpc';
import type { Workflow, WorkflowResultType } from '@temporalio/common';
import type { Replace } from '@temporalio/common/lib/type-helpers';
import type {
  ActivityHandle,
  ActivityName,
  ActivityOptions as ClientActivityOptions,
  ActivityOptionsFor as ClientActivityOptionsFor,
  ActivityResult,
  Client,
  WorkflowStartOptions as ClientWorkflowStartOptions,
} from '@temporalio/client';
import { type temporal } from '@temporalio/proto';
import type { InternalActivityStartOptions, InternalNexusStartOptions } from '@temporalio/client/lib/internal';
import { InternalNexusStartOptionsSymbol } from '@temporalio/client/lib/internal';
import { convertNexusLinkToTemporalLink, convertTemporalLinkToNexusLink } from './link-converter';
import {
  assertActivityOperationToken,
  assertWorkflowRunOperationToken,
  generateWorkflowRunOperationToken,
  generateActivityOperationToken,
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

async function startWithNexusOptions<T>(
  ctx: nexus.StartOperationContext,
  handler: (opts: InternalNexusStartOptions[typeof InternalNexusStartOptionsSymbol]) => Promise<T>
) {
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

  const internalOptions: InternalNexusStartOptions[typeof InternalNexusStartOptionsSymbol] = {
    links,
    requestId: ctx.requestId,
    onConflictOptions: {
      attachLinks: true,
      attachCompletionCallbacks: true,
      attachRequestId: true,
    },
  };

  if (ctx.callbackUrl) {
    internalOptions.completionCallbacks = [
      {
        nexus: { url: ctx.callbackUrl, header: ctx.callbackHeaders },
        links, // pass in links here as well for older servers, newer servers dedupe them.
      },
    ];
  }

  const result = await handler(internalOptions);
  if (internalOptions.backLink != null) {
    try {
      ctx.outboundLinks.push(convertTemporalLinkToNexusLink(internalOptions.backLink));
    } catch (error) {
      log.warn('failed to convert temporal link to Nexus link', { error });
    }
  }

  return result;
}

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
 * propagates the callback, request ID, and back and forward links from the Nexus options to the
 * Workflow.
 *
 * @experimental Nexus support in Temporal SDK is experimental.
 */
export async function startWorkflow<T extends Workflow>(
  ctx: nexus.StartOperationContext,
  workflowTypeOrFunc: string | T,
  workflowOptions: WorkflowStartOptions<T>
): Promise<WorkflowHandle<WorkflowResultType<T>>> {
  return await startWithNexusOptions(ctx, async (internalOptions) => {
    const { client, taskQueue } = getHandlerContext();

    const { taskQueue: userSpecifiedTaskQueue, ...rest } = workflowOptions;
    const startOptions: ClientWorkflowStartOptions = {
      ...rest,
      taskQueue: userSpecifiedTaskQueue || taskQueue,
      [InternalNexusStartOptionsSymbol]: internalOptions,
    };

    const handle = await client.workflow.start(workflowTypeOrFunc, startOptions);

    return {
      workflowId: handle.workflowId,
      runId: handle.firstExecutionRunId,
    } as WorkflowHandle<WorkflowResultType<T>>;
  });
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
 * Options for starting an untyped activity using {@link TemporalNexusClient.startActivity}, this type is identical to the
 * client's `ActivityOptions` with the exception that `taskQueue` is optional and defaults
 * to the current worker's task queue.
 *
 * @experimental Nexus support in Temporal SDK is experimental.
 */
export type ActivityOptions = Replace<ClientActivityOptions, { taskQueue?: string }>;

/**
 * Options for starting a typed activity using {@link NexusTypedActivityClient.startActivity}, this type is identical to the
 * client's `ActivityOptionsFor` with the exception that `taskQueue` is optional and defaults
 * to the current worker's task queue.
 *
 * @experimental Nexus support in Temporal SDK is experimental.
 */
export type ActivityOptionsFor<T, N extends ActivityName<T>> = Replace<
  ClientActivityOptionsFor<T, N>,
  { taskQueue?: string }
>;

/**
 * Starts an activity for a {@link TemporalNexusClient.startActivity}, linking the execution chain
 * to a Nexus Operation. Automatically propagates the callback, request ID, and back and forward
 * links from the Nexus options to the Activity.
 *
 * @experimental Nexus support in Temporal SDK is experimental.
 */
async function startActivity<R>(
  ctx: TemporalStartOperationContext,
  activity: string,
  activityOptions: ActivityOptions
): Promise<ActivityHandle<R>> {
  return await startWithNexusOptions(ctx, async (internalOptions) => {
    const { client, taskQueue } = getHandlerContext();

    const { taskQueue: userSpecifiedTaskQueue, ...rest } = activityOptions;
    const startOptions: InternalActivityStartOptions = {
      ...rest,
      taskQueue: userSpecifiedTaskQueue || taskQueue,
      [InternalNexusStartOptionsSymbol]: internalOptions,
    };

    try {
      return await client.activity.start<R>(activity, startOptions);
    } catch (err) {
      // ActivityClient.validateActivityOptions throws TypeError if there are bad options specified.
      // e.g. missing startToCloseTimeout or scheduleToCloseTimeout
      // If uncaught, causes Nexus operations to retry until timeout or circuit breaker trips and
      // reason is not easily discoverable.
      if (err instanceof TypeError) {
        throw new nexus.HandlerError(nexus.HandlerErrorType.BAD_REQUEST, `Failed to start activity: ${err.message}`, {
          cause: err,
        });
      }
      throw err;
    }
  });
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

  startActivity<R = any>(activity: string, options: ActivityOptions): Promise<TemporalOperationResult<R>>;

  /**
   * Returns this client as a {@link NexusTypedActivityClient}. It enables strong type checking of Activity name, arguments
   * and result based on the provided Activity interface. Note that no new client object is created - this method only
   * affects type annotations.
   * @template T Activity interface to use for type checking. The returned client can only start activities present in
   * this interface.
   *
   * @experimental Nexus support in Temporal SDK is experimental.
   */
  typedActivity<T>(): NexusTypedActivityClient<T>;
}

/**
 * Sub-interface of {@link TemporalNexusClient} that provides a strongly-typed interface for executing Activities.
 * Argument types in the provided options must match the argument types of the specified Activity as defined in provided
 * interface
 * @template T Activity interface
 *
 * @experimental Nexus support in Temporal SDK is experimental.
 */
export interface NexusTypedActivityClient<T> {
  startActivity<N extends ActivityName<T>>(
    activity: N,
    options: ActivityOptionsFor<T, N>
  ): Promise<TemporalOperationResult<ActivityResult<T, N>>>;
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

  public async startActivity<R = any>(
    activity: string,
    options: Replace<ActivityOptions, { taskQueue?: string }>
  ): Promise<TemporalOperationResult<R>> {
    return await this.withAsyncOperationStartReservation(async () => {
      const handle = await startActivity(this.startOperationContext, activity, options);
      const { namespace } = getHandlerContext();

      // handle.runId is always populated when starting an activity
      // it's safe to use non-null assertion
      const token = generateActivityOperationToken(namespace, handle.activityId, handle.runId!);
      return TemporalOperationResult.async(token);
    });
  }

  public typedActivity<T>(): NexusTypedActivityClient<T> {
    return this;
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
 * Options passed to a {@link TemporalOperationHandlerOptions.cancelActivity} handler describing
 * the activity to cancel.
 *
 * @experimental Nexus support in Temporal SDK is experimental.
 */
export interface CancelActivityOptions {
  /**
   * The ID of the activity backing the Nexus Operation that is being canceled.
   */
  readonly activityId: string;

  /**
   * The run ID of the activity backing the Nexus Operation that is being canceled.
   */
  readonly runId: string;
}

/**
 * Options for customizing a {@link TemporalOperationHandler}.
 *
 * @experimental Nexus support in Temporal SDK is experimental.
 */
export interface TemporalOperationHandlerOptions {
  cancelWorkflowRun?: (ctx: TemporalCancelOperationContext, options: CancelWorkflowRunOptions) => Promise<void>;
  cancelActivity?: (ctx: TemporalCancelOperationContext, options: CancelActivityOptions) => Promise<void>;
}

/**
 * A Nexus Operation implementation for operations that interact with Temporal.
 *
 * @experimental Nexus support in Temporal SDK is experimental.
 */
export class TemporalOperationHandler<I, O> implements nexus.OperationHandler<I, O> {
  private readonly startHandler: TemporalOperationStartHandler<I, O>;
  private readonly cancelWorkflowRunHandler: NonNullable<TemporalOperationHandlerOptions['cancelWorkflowRun']>;
  private readonly cancelActivityHandler: NonNullable<TemporalOperationHandlerOptions['cancelActivity']>;

  constructor(options: { start: TemporalOperationStartHandler<I, O> } & TemporalOperationHandlerOptions) {
    this.startHandler = options.start;
    this.cancelWorkflowRunHandler = options.cancelWorkflowRun ?? defaultCancelWorkflowRun;
    this.cancelActivityHandler = options.cancelActivity ?? defaultCancelActivity;
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
      case OperationTokenType.ACTIVITY:
        try {
          assertActivityOperationToken(opToken);
        } catch (err) {
          throw new nexus.HandlerError(nexus.HandlerErrorType.BAD_REQUEST, 'invalid activity operation token', {
            cause: err,
          });
        }
        await this.cancelActivityHandler(ctx, { activityId: opToken.aid, runId: opToken.rid });
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

async function defaultCancelActivity(
  _ctx: TemporalCancelOperationContext,
  { activityId, runId }: CancelActivityOptions
) {
  await getClient().activity.getHandle(activityId, runId).cancel(`Nexus Operation cancellation requested`);
}
