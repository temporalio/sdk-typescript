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
  NodeTimeoutError,
  type BaseNode,
  type FunctionNodeConfig,
  type NodeContext,
  type RetryConfig,
  type SchemaLike,
} from '@google/adk';
import { ApplicationFailure } from '@temporalio/common';
import {
  CancellationScope,
  inWorkflowContext,
  proxyActivities,
  sleep,
  type ActivityOptions,
} from '@temporalio/workflow';

import { ACTIVITY_NODE_NAME_FAILURE_TYPE, ACTIVITY_NODE_OUTSIDE_WORKFLOW_FAILURE_TYPE } from './error-types';
import { activityOptionsFrom } from './model';

/** Options for {@link activityNode}. */
export interface ActivityNodeOptions<TInput = unknown> {
  /**
   * The registered Activity type to run — an `@activity`-style function
   * registered on the worker (e.g. via the worker's `activities`). Also the
   * node's name unless `nodeName` is set.
   */
  name: string;
  /**
   * The graph node's name, when it must differ from the Activity's (e.g. two
   * nodes running one Activity, or an Activity type carrying a `.`). The
   * effective name may not contain a `.`: ADK reserves it as the separator in a
   * node's path, and a dotted name breaks the rehydration that fast-forwards a
   * completed node on resume. `activityNode` refuses one rather than rename the
   * node behind your back.
   */
  nodeName?: string;
  /** The node's description, advertised when the node is used as a tool. */
  description?: string;
  /**
   * Per-call Temporal Activity configuration (timeouts, retry, task queue,
   * summary). Prefer `retry` here over ADK's `retryConfig`: an ADK retry
   * re-runs the whole node on top of Temporal's own Activity retries.
   *
   * An abort (the node's `timeout`, or a sibling node failing) *requests* the
   * Activity's cancellation on Temporal's usual terms, and `cancellationType`
   * decides what the node then waits for. Unset means `TRY_CANCEL`: the node
   * hears about the cancellation at once and the Activity is left to wind down
   * on its own. `WAIT_CANCELLATION_COMPLETED` makes the node wait for the
   * Activity to acknowledge, which it does at its next heartbeat, so pair it
   * with a `heartbeatTimeout` and an Activity that heartbeats.
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
   * ADK graph-level retry. Its backoff becomes a durable Workflow timer; its
   * jitter is drawn from the Workflow's `Math.random()`. Match a Temporal
   * Activity failure with `exceptions: ['ActivityFailure']` (ADK matches error
   * names).
   */
  retryConfig?: RetryConfig;
  /**
   * The node's deadline, in **seconds** (ADK semantics). A durable Workflow
   * timer: when it fires the in-flight Activity is cancelled, and the node
   * fails with ADK's `NodeTimeoutError` once that cancellation has settled, so
   * a `retryConfig` attempt never overlaps the Activity it replaces.
   *
   * How long the settling takes is the Activity's own
   * {@link ActivityOptions.cancellationType}. Unset (`TRY_CANCEL`) it settles
   * at once, and the Activity winds down on its own time. Under
   * `WAIT_CANCELLATION_COMPLETED` the node waits for the Activity to
   * acknowledge, which it does at its next heartbeat, so an Activity that never
   * heartbeats holds the node until its `startToCloseTimeout`.
   *
   * The plugin runs this deadline itself rather than handing it to ADK, whose
   * own implementation races the node's generator and then abandons the unwind
   * (`node_runner.ts`), which would let a retry start on top of an Activity
   * that is still running.
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
 * which flows to the successors. An Activity returning nothing completes the
 * node with an `undefined` output. The node can only run inside a Workflow.
 *
 * Two of ADK's node flags are deliberately not exposed. `waitForOutput` is not
 * a fan-in gate: it parks a node in `WAITING` when the node ended with neither
 * an output nor a route (`Workflow.handleCompletion`), which for an Activity
 * node is a no-op when the Activity returns a value and a hang when it returns
 * `undefined`. Fan in with a `JoinNode`, the node type that does wait for every
 * predecessor (`BaseNode.requiresAllPredecessors`), and whose input is the map
 * from predecessor name to output. `rerunOnResume` only decides what happens to
 * a node that paused for input last turn (`Workflow.scheduleNode`); a node that
 * completed is always fast-forwarded, and an Activity node never raises an
 * interrupt, so neither value could change anything.
 */
export function activityNode<TInput = unknown, TOutput = unknown>(
  options: ActivityNodeOptions<TInput>
): BaseNode<TInput, TOutput> {
  const { name, nodeName, description, activity, args } = options;
  const graphName = nodeName ?? name;
  // ADK joins a node's ancestry into a dotted path (`BranchPath.toString`) and
  // splits it again to rehydrate a resumed run, so a dot inside a single name
  // makes the node unrecognisable across turns and it runs a second time. An
  // Activity type is often dotted (`payments.charge`), so say so rather than
  // quietly rewriting the name the graph, the events and the traces all carry.
  if (graphName.includes('.')) {
    throw ApplicationFailure.nonRetryable(
      `activityNode('${name}'): a node name may not contain '.', which ADK reserves as its node-path ` +
        `separator. Pass a path-safe 'nodeName' (for example '${graphName.split('.').join('_')}').`,
      ACTIVITY_NODE_NAME_FAILURE_TYPE
    );
  }

  const handler = async (ctx: NodeContext, input: TInput): Promise<TOutput> => {
    if (!inWorkflowContext()) {
      throw ApplicationFailure.nonRetryable(
        `activityNode('${name}') can only run inside a Temporal Workflow.`,
        ACTIVITY_NODE_OUTSIDE_WORKFLOW_FAILURE_TYPE
      );
    }
    // The default summary names the *node*: the Activity type is already its own
    // history column, so two nodes running one Activity would otherwise read alike.
    const activities = proxyActivities<Record<string, (...activityArgs: unknown[]) => Promise<unknown>>>(
      activityOptionsFrom(activity, `adk.node ${graphName}`)
    );
    // `proxyActivities` returns a Proxy that materializes a stub for any name,
    // so the indexed access is always defined; `noUncheckedIndexedAccess`
    // widens the static type to `| undefined`, hence the assertion.
    const run = activities[name]!;
    const activityArgs = args ? args(input, ctx) : [input];
    return (await underNodeDeadline(ctx, graphName, options.timeout, () => run(...activityArgs))) as TOutput;
  };

  const config: FunctionNodeConfig = {};
  if (description !== undefined) config.description = description;
  if (options.retryConfig !== undefined) config.retryConfig = options.retryConfig;
  if (options.inputSchema !== undefined) config.inputSchema = options.inputSchema;
  if (options.outputSchema !== undefined) config.outputSchema = options.outputSchema;
  if (options.stateSchema !== undefined) config.stateSchema = options.stateSchema;
  if (options.isolationScope !== undefined) config.isolationScope = options.isolationScope;

  return new FunctionNode<TInput, TOutput>(graphName, handler, config);
}

/**
 * Runs the Activity under the node's own deadline and under the invocation's abort, and
 * does not return until whatever it started has settled.
 *
 * Both are the same mechanism: a cancellable `CancellationScope` the Activity runs in, so
 * cancelling it is an ordinary, replay-safe Workflow command. ADK signals a sibling's
 * failure or an outside abort through `ctx.abortSignal` (always set for a node inside a
 * `Workflow`), which asyncio gives Python for free; the deadline is a durable timer this
 * function owns.
 *
 * The plugin runs the deadline rather than declaring `timeout` on the node because ADK's
 * own deadline races the node's generator and then abandons the unwind
 * (`void iterator.return(...)` in `node_runner.ts`), leaving the Activity running while
 * the runner has already moved on: a `retryConfig` attempt would overlap the Activity it
 * is meant to replace. Awaiting the cancelled Activity here keeps the attempts in order,
 * on the terms the Activity's own `cancellationType` sets.
 *
 * An abort that is not the deadline is not a timeout, so its failure (an `ActivityFailure`
 * whose cause is the `CancelledFailure`) is rethrown as it is and the node fails with the
 * cancellation it actually got. The abort listener is removed on the way out because the
 * signal is shared by every node for the whole run, and the listener never throws: it runs
 * inside a host `EventTarget` dispatch, outside the Workflow's own error handling.
 */
async function underNodeDeadline<T>(
  ctx: NodeContext,
  nodeName: string,
  timeout: number | undefined,
  body: () => Promise<T>
): Promise<T> {
  const signal = ctx.abortSignal;
  const deadlineMs = timeout !== undefined && timeout > 0 ? timeout * 1000 : undefined;
  if (signal === undefined && deadlineMs === undefined) return body();

  const scope = new CancellationScope({ cancellable: true });
  const cancel = (): void => {
    try {
      scope.cancel();
    } catch {
      /* cancelling an already-cancelled scope, or a scope with nothing in it, is not an error worth surfacing here */
    }
  };

  let timedOut = false;
  // The timer sits in its own scope so cancelling the Activity's scope does not cancel it,
  // and so the `finally` below can cancel it once the Activity has settled.
  let deadline: CancellationScope | undefined;
  if (deadlineMs !== undefined) {
    deadline = new CancellationScope({ cancellable: true });
    void deadline
      .run(() => sleep(deadlineMs))
      .then(
        () => {
          timedOut = true;
          cancel();
        },
        () => {
          /* the deadline was cancelled because the Activity settled first */
        }
      );
  }

  const onAbort = (): void => cancel();
  if (signal !== undefined) {
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  let settled: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    settled = { ok: true, value: await scope.run(body) };
  } catch (error) {
    settled = { ok: false, error };
  } finally {
    deadline?.cancel();
    signal?.removeEventListener('abort', onAbort);
  }

  // Reaching here after the deadline fired means the Activity has settled, however its
  // `cancellationType` defines that, so the node can now fail the way ADK's own deadline
  // would have. Matching ADK's error keeps `retryConfig.exceptions` and the plugin's
  // failure-type mapping working on it.
  if (timedOut) throw new NodeTimeoutError({ nodeName, timeout: deadlineMs! / 1000 });
  if (settled.ok) return settled.value;
  throw settled.error;
}
