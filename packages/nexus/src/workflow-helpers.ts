import * as nexus from 'nexus-rpc';
import { Workflow } from '@temporalio/common';
import { Replace } from '@temporalio/common/lib/type-helpers';
import { WorkflowStartOptions as ClientWorkflowStartOptions } from '@temporalio/client';
import { temporal } from '@temporalio/proto';
import { InternalWorkflowStartOptionsSymbol, InternalWorkflowStartOptions } from '@temporalio/client/lib/internal';
import { generateWorkflowRunOperationToken, loadWorkflowRunOperationToken } from './token';
import { convertNexusLinkToWorkflowEventLink, convertWorkflowEventLinkToNexusLink } from './link-converter';
import { getClient, getHandlerContext, log } from './context';

/**
 * A handle to a running workflow that is returned by the {@link startWorkflow} helper.
 * This handle should be returned by {@link WorkflowRunOperationStartHandler} implementations.
 */
export interface WorkflowHandle<_T> {
  readonly workflowId: string;
  readonly runId: string;
}

/**
 * Options for starting a workflow using {@link startWorkflow}, this type is identical to the
 * client's `WorkflowStartOptions` with the exception that `taskQueue` is optional and defaults
 * to the current worker's task queue.
 */
export type WorkflowStartOptions<T extends Workflow> = Replace<ClientWorkflowStartOptions<T>, { taskQueue?: string }>;

/**
 * Starts a workflow run for a {@link WorkflowRunOperationStartHandler}, linking the execution chain
 * to a Nexus Operation (subsequent runs started from continue-as-new and retries). Automatically
 * propagates the callback, request ID, and back and forward links from the Nexus options to the
 * Workflow.
 *
 * @experimental Nexus support is experimental.
 */
export async function startWorkflow<T extends Workflow>(
  ctx: nexus.StartOperationContext,
  workflowTypeOrFunc: string | T,
  workflowOptions: WorkflowStartOptions<T>
): Promise<WorkflowHandle<T>> {
  const { client, taskQueue } = getHandlerContext();
  const links = Array<temporal.api.common.v1.ILink>();
  if (ctx.inboundLinks?.length > 0) {
    for (const l of ctx.inboundLinks) {
      try {
        links.push({
          workflowEvent: convertNexusLinkToWorkflowEventLink(l),
        });
      } catch (error) {
        log.warn('failed to convert Nexus link to Workflow event link', { error });
      }
    }
  }
  const internalOptions: InternalWorkflowStartOptions[typeof InternalWorkflowStartOptionsSymbol] = {
    links,
    requestId: ctx.requestId,
  };

  if (workflowOptions.workflowIdConflictPolicy === 'USE_EXISTING') {
    internalOptions.onConflictOptions = {
      attachLinks: true,
      attachCompletionCallbacks: true,
      attachRequestId: true,
    };
  }

  if (ctx.callbackUrl) {
    internalOptions.completionCallbacks = [
      {
        nexus: { url: ctx.callbackUrl, header: ctx.callbackHeaders },
        links, // pass in links here as well for older servers, newer servers dedupe them.
      },
    ];
  }

  const { taskQueue: userSpeficiedTaskQueue, ...rest } = workflowOptions;
  const startOptions: ClientWorkflowStartOptions = {
    ...rest,
    taskQueue: userSpeficiedTaskQueue || taskQueue,
    [InternalWorkflowStartOptionsSymbol]: internalOptions,
  };

  const handle = await client.workflow.start(workflowTypeOrFunc, startOptions);
  if (internalOptions.backLink?.workflowEvent != null) {
    try {
      ctx.outboundLinks.push(convertWorkflowEventLinkToNexusLink(internalOptions.backLink.workflowEvent));
    } catch (error) {
      log.warn('failed to convert Workflow event link to Nexus link', { error });
    }
  }

  return { workflowId: handle.workflowId, runId: handle.firstExecutionRunId };
}

/**
 * A handler function for the {@link WorkflowRunOperationHandler} constructor.
 */
export type WorkflowRunOperationStartHandler<I, O> = (
  ctx: nexus.StartOperationContext,
  input: I
) => Promise<WorkflowHandle<O>>;

/**
 * A Nexus Operation implementation that is backed by a Workflow run.
 */
export class WorkflowRunOperationHandler<I, O> implements nexus.OperationHandler<I, O> {
  constructor(readonly handler: WorkflowRunOperationStartHandler<I, O>) {}

  async start(ctx: nexus.StartOperationContext, input: I): Promise<nexus.HandlerStartOperationResult<O>> {
    const { namespace } = getHandlerContext();
    const handle = await this.handler(ctx, input);
    return nexus.HandlerStartOperationResult.async(generateWorkflowRunOperationToken(namespace, handle.workflowId));
  }

  getInfo(_ctx: nexus.GetOperationInfoContext, _token: string): Promise<nexus.OperationInfo> {
    // Not implemented in Temporal yet.
    throw new nexus.HandlerError('NOT_IMPLEMENTED', 'Method not implemented');
  }

  getResult(_ctx: nexus.GetOperationResultContext, _token: string): Promise<O> {
    // Not implemented in Temporal yet.
    throw new nexus.HandlerError('NOT_IMPLEMENTED', 'Method not implemented');
  }

  async cancel(_ctx: nexus.CancelOperationContext, token: string): Promise<void> {
    const decoded = loadWorkflowRunOperationToken(token);
    await getClient().workflow.getHandle(decoded.wid).cancel();
  }
}
