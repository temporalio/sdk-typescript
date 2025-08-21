import * as nexus from 'nexus-rpc';
import { Context as ActivityContext } from '@temporalio/activity';
import { ClientInterceptors } from '@temporalio/client';
import { Headers, MetricTags, Next } from '@temporalio/common';

export { Next, Headers };

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Activity Interceptors
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export type ActivityInterceptorsFactory = (ctx: ActivityContext) => ActivityInterceptors;

/**
 * A function that takes Activity Context and returns an interceptor
 */

export interface ActivityInterceptors {
  inbound?: ActivityInboundCallsInterceptor;
  outbound?: ActivityOutboundCallsInterceptor;
}

/**
 * Implement any of these methods to intercept Activity inbound calls
 */
export interface ActivityInboundCallsInterceptor {
  /**
   * Called when Activity function is executed
   *
   * @return result of Activity function
   */
  execute?: (input: ActivityExecuteInput, next: Next<ActivityInboundCallsInterceptor, 'execute'>) => Promise<unknown>;
}

/**
 * Input for {@link ActivityInboundCallsInterceptor.execute}
 */
export interface ActivityExecuteInput {
  readonly args: unknown[];
  readonly headers: Headers;
}

/**
 * Implement any of these methods to intercept Activity outbound calls
 */
export interface ActivityOutboundCallsInterceptor {
  /**
   * Called on each invocation of the `activity.log` methods.
   *
   * The attributes returned in this call are attached to every log message.
   */
  getLogAttributes?: (
    input: GetLogAttributesInput,
    next: Next<ActivityOutboundCallsInterceptor, 'getLogAttributes'>
  ) => Record<string, unknown>;

  /**
   * Called once every time a metric is emitted from an Activity metric
   * (ie. a metric created from {@link activity.metricMeter}).
   *
   * Tags returned by this hook are _prepended_ to tags defined at the metric level and tags defined
   * on the emitter function itself.
   */
  getMetricTags?: (
    input: GetMetricTagsInput,
    next: Next<ActivityOutboundCallsInterceptor, 'getMetricTags'>
  ) => MetricTags;
}

/**
 * Input for {@link ActivityOutboundCallsInterceptor.getLogAttributes}
 */
export type GetLogAttributesInput = Record<string, unknown>;

/**
 * Input for {@link ActivityOutboundCallsInterceptor.getMetricTags}
 */
export type GetMetricTagsInput = MetricTags;

/**
 * A function that takes Activity Context and returns an interceptor
 *
 * @deprecated Use {@link ActivityInterceptorsFactory} instead
 */
export interface ActivityInboundCallsInterceptorFactory {
  (ctx: ActivityContext): ActivityInboundCallsInterceptor;
}

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Nexus Interceptors
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

export type NexusInterceptorsFactory = (ctx: nexus.OperationContext) => NexusInterceptors;

export type NexusInterceptors = {
  inbound?: NexusInboundCallsInterceptor;
  outbound?: NexusOutboundCallsInterceptor;
};

/**
 * A function that takes a Nexus Context and returns an interceptor
 *
 * @experimental
 */
export type NexusInboundCallsInterceptor = {
  execute?: (
    input: NexusExecuteInput,
    next: Next<NexusInboundCallsInterceptor, 'execute'>
  ) => Promise<NexusExecuteOutput>;
};

/**
 * Input for NexusInboundCallsInterceptor.execute
 *
 * @experimental
 */
export interface NexusExecuteInput {
  readonly args: unknown[];
  readonly headers: Headers;
}

/**
 * Output for NexusInboundCallsInterceptor.execute
 *
 * @experimental
 */
export interface NexusExecuteOutput {
  readonly result: unknown;
}

/**
 * A function that takes a Nexus Context and returns an interceptor
 *
 * @experimental
 */
export type NexusOutboundCallsInterceptor = {
  getLogAttributes?: (
    input: GetLogAttributesInput,
    next: Next<NexusOutboundCallsInterceptor, 'getLogAttributes'>
  ) => Record<string, unknown>;

  getMetricTags?: (input: GetMetricTagsInput, next: Next<NexusOutboundCallsInterceptor, 'getMetricTags'>) => MetricTags;
};

////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
// Worker Interceptors Configuration
////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////

/**
 * Structure for passing in Worker interceptors via {@link WorkerOptions}
 */
export interface WorkerInterceptors {
  /**
   * Interceptors for the Client provided by the Worker to Activities and Nexus operation handlers.
   *
   * @experimental Client support over `NativeConnection` is experimental. Error handling may be
   *               incomplete or different from what would be observed using a {@link Connection}
   *               instead. Client doesn't support cancellation through a Signal.
   */
  client?: ClientInterceptors;

  /**
   * List of factory functions that instanciate {@link ActivityInboundCallsInterceptor}s and
   * {@link ActivityOutboundCallsInterceptor}s.
   */
  activity?: ActivityInterceptorsFactory[];

  /**
   * List of factory functions returning {@link ActivityInboundCallsInterceptor}s. If both `activity` and
   * `activityInbound` is supplied, then entries from `activityInbound` will be prepended to inbound interceptors
   * instanciated from `activity`.
   *
   * @deprecated Use {@link WorkerInterceptors.activity} instead.
   */
  activityInbound?: ActivityInboundCallsInterceptorFactory[]; // eslint-disable-line deprecation/deprecation

  /**
   * List of factory functions that instanciate {@link NexusInterceptors}s.
   *
   * @experimental
   */
  nexus?: NexusInterceptorsFactory[];

  /**
   * List of modules to search for Workflow interceptors in
   * - Modules should export an `interceptors` variable of type {@link WorkflowInterceptorsFactory}
   * - Workflow interceptors run in the Workflow isolate
   *
   * **NOTE**: This option is not used if Worker is provided with pre-built bundle ({@link WorkerOptions.workflowBundle}).
   */
  workflowModules?: string[];
}

export type CompiledWorkerInterceptors = Required<
  Pick<WorkerInterceptors, 'client' | 'activity' | 'nexus' | 'workflowModules'>
>;
