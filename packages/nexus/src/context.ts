import * as nexus from 'nexus-rpc';
import { HandlerContext as BaseHandlerContext, getHandlerContext, handlerLinks } from 'nexus-rpc/lib/handler';
import { Logger, LogLevel, LogMetadata, Workflow } from '@temporalio/common';
import { Client, WorkflowStartOptions } from '@temporalio/client';
import { temporal } from '@temporalio/proto';
import { InternalWorkflowStartOptionsKey, InternalWorkflowStartOptions } from '@temporalio/client/lib/internal';
import { generateWorkflowRunOperationToken, loadWorkflowRunOperationToken } from './token';
import { convertNexusLinkToWorkflowEventLink, convertWorkflowEventLinkToNexusLink } from './link-converter';

export interface HandlerContext extends BaseHandlerContext {
  log: Logger;
  client: Client;
  namespace: string;
}

function getLogger() {
  return getHandlerContext<HandlerContext>().log;
}

/**
 * A logger for use in Nexus Handler scope.
 */
export const log: Logger = {
  log(level: LogLevel, message: string, meta?: LogMetadata): any {
    return getLogger().log(level, message, meta);
  },
  trace(message: string, meta?: LogMetadata): any {
    return getLogger().trace(message, meta);
  },
  debug(message: string, meta?: LogMetadata): any {
    return getLogger().debug(message, meta);
  },
  info(message: string, meta?: LogMetadata): any {
    return getLogger().info(message, meta);
  },
  warn(message: string, meta?: LogMetadata): any {
    return getLogger().warn(message, meta);
  },
  error(message: string, meta?: LogMetadata): any {
    return getLogger().error(message, meta);
  },
};

// TODO: also support getting a metrics handler.

/**
 * Returns a client to be used in a Nexus Operation's context, this Client is powered by the same Connection that the
 * worker was created with.
 */
export function getClient(): Client {
  return getHandlerContext<HandlerContext>().client;
}

export interface WorkflowHandle<_T> {
  readonly workflowId: string;
  readonly runId: string;
}

export async function startWorkflow<T extends Workflow>(workflowTypeOrFunc: string | T, workflowOptions: WorkflowStartOptions<T>, nexusOptions: nexus.StartOperationOptions): Promise<WorkflowHandle<T>> {
  const links = Array<temporal.api.common.v1.ILink>();
  if (nexusOptions.links?.length > 0) {
    for (const l of nexusOptions.links) {
      try {
        links.push({
          workflowEvent: convertNexusLinkToWorkflowEventLink(l),
        });
      } catch (error) {
        log.warn('failed to convert Nexus link to Workflow event link', { error });
      }
    }
  }
  const internalOptions: InternalWorkflowStartOptions = { links, requestId: nexusOptions.requestId };

  if (workflowOptions.workflowIdConflictPolicy === 'USE_EXISTING') {
    internalOptions.onConflictOptions = {
      attachLinks: true,
      attachCompletionCallbacks: true,
      attachRequestId: true,
    };
  }

  if (nexusOptions.callbackURL) {
    internalOptions.completionCallbacks = [
      {
        nexus: {url: nexusOptions.callbackURL, header: nexusOptions.callbackHeaders},
        links, // pass in links here as well, the server dedupes them.
      },
    ];
  }
  (workflowOptions as any)[InternalWorkflowStartOptionsKey] = internalOptions;
  const handle = await getClient().workflow.start<T>(workflowTypeOrFunc, workflowOptions);
  if (internalOptions.backLink?.workflowEvent != null) {
    try {
      handlerLinks().push(convertWorkflowEventLinkToNexusLink(internalOptions.backLink.workflowEvent));
    } catch (error) {
        log.warn('failed to convert Workflow event link to Nexus link', { error });
    }
  }
  return { workflowId: handle.workflowId, runId: handle.firstExecutionRunId };
}

export type WorkflowRunOperationHandler<I, O> = (input: I, options: nexus.StartOperationOptions) => Promise<WorkflowHandle<O>>;

export class WorkflowRunOperation<I, O> implements nexus.OperationHandler<I, O> {
  constructor(readonly handler: WorkflowRunOperationHandler<I, O>) { }

  async start(input: I, options: nexus.StartOperationOptions): Promise<nexus.HandlerStartOperationResult<O>> {
    const { namespace } = getHandlerContext<HandlerContext>();
    const handle = await this.handler(input, options);
    return { token: generateWorkflowRunOperationToken(namespace, handle.workflowId) };
  }
  getResult(_token: string, _options: nexus.GetOperationResultOptions): Promise<O> {
    // Not implemented in Temporal yet.
    throw new nexus.HandlerError({ type: 'NOT_IMPLEMENTED', message: 'Method not implemented' });
  }
  getInfo(_token: string, _options: nexus.GetOperationInfoOptions): Promise<nexus.OperationInfo> {
    // Not implemented in Temporal yet.
    throw new nexus.HandlerError({ type: 'NOT_IMPLEMENTED', message: 'Method not implemented' });
  }
  async cancel(token: string, _options: nexus.CancelOperationOptions): Promise<void> {
    const decoded = loadWorkflowRunOperationToken(token);
    await getClient().workflow.getHandle(decoded.wid).cancel();
  }
}
