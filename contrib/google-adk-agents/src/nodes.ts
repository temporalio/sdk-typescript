/**
 * A Temporal Activity as a node in an ADK 2.0 workflow graph.
 *
 * ADK 2.0's workflow runtime (`Workflow`, `node()`, `JoinNode`, `dynamicEntry`,
 * …) is plain async code driven by session events, so it runs inside the
 * Workflow sandbox as-is. {@link activityNode} is the one piece it lacks: a node
 * whose body is a registered Temporal Activity, the same way `activityAsTool`
 * exposes an Activity to the model.
 *
 * Failure semantics: a node that throws fails the whole `Runner.runAsync` (ADK
 * rethrows node errors; only an agent's model call is absorbed), so a failed
 * Activity fails the Workflow through the usual `ActivityFailure` and needs no
 * absorbed-failure recording. ADK's own graph errors (a `NodeTimeoutError`, …)
 * are plain `Error`s that the plugin converts as they leave the Workflow — see
 * `absorbed-failure.ts`.
 *
 * IMPORTANT: this module is part of the Workflow-sandbox import graph. It must
 * not import any worker-only module.
 */

import {
  FunctionNode,
  type BaseNode,
  type FunctionNodeConfig,
  type NodeContext,
  type RetryConfig,
  type SchemaLike,
} from '@google/adk';
import { ApplicationFailure } from '@temporalio/common';
import { CancellationScope, inWorkflowContext, proxyActivities, type ActivityOptions } from '@temporalio/workflow';

import { ACTIVITY_NODE_OUTSIDE_WORKFLOW_FAILURE_TYPE } from './error-types';
import { activityOptionsFrom } from './model';

/** Options for {@link activityNode}. */
export interface ActivityNodeOptions<TInput = unknown> {
  /**
   * The registered Activity type to run — an `@activity`-style function
   * registered on the worker (e.g. via the worker's `activities`). Also the
   * node's name unless `nodeName` is set.
   */
  name: string;
  /** The graph node's name, when it must differ from the Activity's (e.g. two nodes running one Activity). */
  nodeName?: string;
  /** The node's description, advertised when the node is used as a tool. */
  description?: string;
  /**
   * Per-call Temporal Activity configuration (timeouts, retry, task queue,
   * summary). Prefer `retry` here over ADK's `retryConfig`: an ADK retry
   * re-runs the whole node on top of Temporal's own Activity retries.
   */
  activity?: ActivityOptions;
  /**
   * Maps the node's input to the Activity's argument list. Defaults to passing
   * the input as the single argument. TypeScript has no runtime signature
   * introspection, so — unlike Python's `activity_node` — there is no
   * named-parameter binding; use the `NodeContext` for state-bound values:
   * `(input, ctx) => [ctx.state.get('customerId'), input]`.
   */
  args?: (input: TInput, ctx: NodeContext) => unknown[];

  // --- ADK node configuration, passed through to the node ---
  /**
   * Whether the node re-runs when a paused (human-in-the-loop) run resumes.
   * Default `false`: a node that already produced its output is fast-forwarded
   * from the session and the Activity is not scheduled again. (ADK's `Workflow`
   * and `LlmAgent` default to `true` for themselves.)
   */
  rerunOnResume?: boolean;
  /** Fan-in: only produce output once every predecessor has triggered the node. */
  waitForOutput?: boolean;
  /**
   * ADK graph-level retry. Its backoff becomes a durable Workflow timer; its
   * jitter is drawn from the Workflow's `Math.random()`. Match a Temporal
   * Activity failure with `exceptions: ['ActivityFailure']` (ADK matches error
   * names).
   */
  retryConfig?: RetryConfig;
  /**
   * The node's deadline, in **seconds** (ADK semantics). A durable Workflow
   * timer; when it fires, the in-flight Activity is cancelled and the node
   * fails with ADK's `NodeTimeoutError`.
   */
  timeout?: number;
  inputSchema?: SchemaLike;
  outputSchema?: SchemaLike;
  stateSchema?: SchemaLike;
  isolationScope?: string | true;
}

/**
 * Wraps a registered Temporal Activity as an ADK workflow graph node. Put the
 * returned node on a `Workflow`'s `edges`, run it from a `dynamicEntry` with
 * `ctx.runNode(node, input)`, or give it to an `LlmAgent`'s `tools` (ADK 2.0
 * wraps a node in a `NodeTool`; that needs an `inputSchema`).
 *
 * Inside a Workflow the node's input (or the arguments `args` derives from it)
 * is sent to the Activity and the Activity's result becomes the node's output,
 * which flows to the successors. The node can only run inside a Workflow.
 */
export function activityNode<TInput = unknown, TOutput = unknown>(
  options: ActivityNodeOptions<TInput>
): BaseNode<TInput, TOutput> {
  const { name, nodeName, description, activity, args } = options;

  const handler = async (ctx: NodeContext, input: TInput): Promise<TOutput> => {
    if (!inWorkflowContext()) {
      throw ApplicationFailure.nonRetryable(
        `activityNode('${name}') can only run inside a Temporal Workflow.`,
        ACTIVITY_NODE_OUTSIDE_WORKFLOW_FAILURE_TYPE
      );
    }
    const activities = proxyActivities<Record<string, (...activityArgs: unknown[]) => Promise<unknown>>>(
      activityOptionsFrom(activity, `adk.node ${name}`)
    );
    // `proxyActivities` returns a Proxy that materializes a stub for any name,
    // so the indexed access is always defined; `noUncheckedIndexedAccess`
    // widens the static type to `| undefined`, hence the assertion.
    const run = activities[name]!;
    const activityArgs = args ? args(input, ctx) : [input];
    return (await underNodeAbort(ctx, () => run(...activityArgs))) as TOutput;
  };

  const config: FunctionNodeConfig = {
    rerunOnResume: options.rerunOnResume ?? false,
  };
  if (description !== undefined) config.description = description;
  if (options.waitForOutput !== undefined) config.waitForOutput = options.waitForOutput;
  if (options.retryConfig !== undefined) config.retryConfig = options.retryConfig;
  if (options.timeout !== undefined) config.timeout = options.timeout;
  if (options.inputSchema !== undefined) config.inputSchema = options.inputSchema;
  if (options.outputSchema !== undefined) config.outputSchema = options.outputSchema;
  if (options.stateSchema !== undefined) config.stateSchema = options.stateSchema;
  if (options.isolationScope !== undefined) config.isolationScope = options.isolationScope;

  return new FunctionNode<TInput, TOutput>(nodeName ?? name, handler, config);
}

/**
 * Runs `body` so that the node's abort — its own `timeout`, or the
 * invocation's — cancels the in-flight Activity. ADK signals both through
 * `ctx.abortSignal` (always set for a node inside a `Workflow`); asyncio gives
 * Python this for free, TypeScript has to bridge it: the abort cancels a
 * `CancellationScope` the Activity runs in, which is a deterministic command.
 *
 * The cancellation is rethrown, never swallowed: on ADK's deadline path the
 * runner has already raised `NodeTimeoutError` and ignores this late
 * rejection; on the cooperative path (no deadline) the node must fail rather
 * than complete with an `undefined` output that would flow to its successors.
 * The listener is removed on the way out because the signal is shared by every
 * node for the whole run, and its body never throws: it runs inside a host
 * `EventTarget` dispatch, outside the Workflow's own error handling.
 */
async function underNodeAbort<T>(ctx: NodeContext, body: () => Promise<T>): Promise<T> {
  const signal = ctx.abortSignal;
  if (!signal) return body();
  const scope = new CancellationScope({ cancellable: true });
  const onAbort = (): void => {
    try {
      scope.cancel();
    } catch {
      /* cancelling an already-cancelled scope, or a scope with nothing in it, is not an error worth surfacing here */
    }
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await scope.run(body);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
