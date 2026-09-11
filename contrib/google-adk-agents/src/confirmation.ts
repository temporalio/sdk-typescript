/**
 * The human-in-the-loop confirmation gate shared by the plugin's tools.
 *
 * ADK 2.0's `FunctionTool` gates a call behind `requireConfirmation`: on the
 * first pass it asks for confirmation through the tool context and returns an
 * error result to the model; once the user has answered, ADK re-dispatches the
 * call with `toolContext.toolConfirmation` set and the tool either runs or
 * returns a rejection. `activityAsTool` and `TemporalMCPToolset` are
 * `BaseTool` subclasses of their own, so they reproduce that protocol here —
 * byte-for-byte the hint and error strings of `FunctionTool.checkConfirmation`
 * (`@google/adk` `tools/function_tool.ts`), so the model sees the same text
 * either way.
 *
 * IMPORTANT: this module is part of the Workflow-sandbox import graph. It must
 * not import any worker-only module.
 */

import type { Context } from '@google/adk';

/**
 * Whether a tool call needs human approval before it runs: a flag, or a
 * predicate over the model's arguments. A predicate MUST be a pure function of
 * its arguments — ADK re-evaluates it when binding the human's approval to the
 * pinned call (`BaseTool.checkRequireConfirmation`), and an answer of `false`
 * at that point refuses the approval.
 */
export type RequireConfirmation<TArgs> = boolean | ((args: TArgs, toolContext?: Context) => boolean | Promise<boolean>);

/** The result a gated tool returns on the pass that raises the confirmation request. */
const CONFIRMATION_REQUIRED_RESULT = {
  error: 'This tool call requires confirmation, please approve or reject.',
} as const;

/** The result a gated tool returns once the user has rejected the call. */
const CONFIRMATION_REJECTED_RESULT = { error: 'This tool call is rejected.' } as const;

/** Resolves a {@link RequireConfirmation} option for one call. @internal */
export async function evaluateRequireConfirmation<TArgs>(
  gate: RequireConfirmation<TArgs> | undefined,
  args: TArgs,
  toolContext?: Context
): Promise<boolean> {
  if (gate === undefined || gate === false) return false;
  if (gate === true) return true;
  return gate(args, toolContext);
}

/**
 * Applies the gate to a call that requires confirmation. Returns `undefined`
 * when the call may proceed (the user approved), otherwise the result the tool
 * must return to the model instead of running: the request-for-confirmation
 * on the first pass, or the rejection once the user declined.
 *
 * @internal
 */
export function gateOnConfirmation(toolName: string, toolContext: Context | undefined): { error: string } | undefined {
  if (!toolContext) {
    // A programming error (ADK always supplies a context): left as a plain error,
    // exactly as `FunctionTool` does.
    throw new Error(`Tool '${toolName}' requires confirmation but no tool context was provided.`);
  }
  if (!toolContext.toolConfirmation) {
    toolContext.requestConfirmation({
      hint:
        `Please approve or reject the tool call ${toolName}() by ` +
        'responding with a FunctionResponse with an expected ' +
        'ToolConfirmation payload.',
    });
    toolContext.actions.skipSummarization = true;
    return CONFIRMATION_REQUIRED_RESULT;
  }
  if (!toolContext.toolConfirmation.confirmed) {
    return CONFIRMATION_REJECTED_RESULT;
  }
  return undefined;
}
