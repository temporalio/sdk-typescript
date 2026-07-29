import { withCustomSpan, getCurrentTrace } from '@openai/agents-core';
import type { Context as ActivityContext } from '@temporalio/activity';
import type {
  Next,
  ActivityInboundCallsInterceptor,
  ActivityExecuteInput,
  NexusInboundCallsInterceptor,
  NexusStartOperationInput,
  NexusStartOperationOutput,
} from '@temporalio/worker';
import { extractAgentsTraceHeader, extractAgentsTraceHeaderNexus } from '../common/headers';
import { withRestoredAgentsTraceContext } from '../common/trace-context';

export interface OpenAIAgentsTraceInterceptorOptions {
  /**
   * Wrap intercepted calls in `temporal:*` custom spans for Temporal-specific
   * instrumentation. The plugin propagates this to Workflows via the
   * `__openai_agents_config` header. @default false
   */
  addTemporalSpans?: boolean;
}

/**
 * Activity inbound interceptor: restores agent trace context and optionally
 * wraps execution in a `temporal:executeActivity` custom span.
 */
export class OpenAIAgentsTraceActivityInboundInterceptor implements ActivityInboundCallsInterceptor {
  private readonly ctx: ActivityContext;

  constructor(
    ctx: ActivityContext,
    private readonly options?: OpenAIAgentsTraceInterceptorOptions
  ) {
    this.ctx = ctx;
  }

  async execute(input: ActivityExecuteInput, next: Next<ActivityInboundCallsInterceptor, 'execute'>): Promise<unknown> {
    const header = extractAgentsTraceHeader(input.headers);
    if (!header) return next(input);

    const addSpans = this.options?.addTemporalSpans === true;

    return withRestoredAgentsTraceContext(header, async () => {
      if (addSpans && getCurrentTrace()) {
        const info = this.ctx.info;
        return withCustomSpan(() => next(input), {
          data: {
            name: `temporal:executeActivity:${info.activityType}`,
            data: {
              activityId: info.activityId,
              activityType: info.activityType,
            },
          },
        });
      }
      return next(input);
    });
  }
}

/**
 * Nexus inbound interceptor: restores agent trace context for `startOperation`
 * so handler-emitted spans nest under the Workflow-side trace tree.
 * `cancelOperation` is not wrapped.
 */
export class OpenAIAgentsTraceNexusInboundInterceptor implements NexusInboundCallsInterceptor {
  async startOperation(
    input: NexusStartOperationInput,
    next: Next<NexusInboundCallsInterceptor, 'startOperation'>
  ): Promise<NexusStartOperationOutput> {
    const header = extractAgentsTraceHeaderNexus(input.ctx.headers);
    if (!header?.traceId) return next(input);
    return withRestoredAgentsTraceContext(header, () => next(input));
  }
}
