import type { Agent, FunctionTool, RunContext, RunResult } from '@openai/agents-core';
import type { SandboxRunConfig } from '@openai/agents-core/sandbox';
import { ApplicationFailure } from '@temporalio/common';
import { TemporalOpenAIRunner } from './runner';
import { ToolSerializationError } from './tools';

export interface AgentAsToolOptions<TAgent extends Agent<any, any>> {
  toolName: string;
  toolDescription?: string;
  customOutputExtractor?: (result: RunResult<any, TAgent>) => string | Promise<string>;
}

const agentAsToolSandboxConfig = Symbol.for('@temporalio/openai-agents/agentAsToolSandboxConfig');

type TemporalAgentTool = FunctionTool & {
  [agentAsToolSandboxConfig]: (sandbox: SandboxRunConfig) => TemporalAgentTool;
};

/**
 * Nested approval interruptions are not supported: `invoke` throws
 * `ApplicationFailure` of type `NestedAgentInterruption`. Handle approvals
 * at the top-level runner instead.
 */
export function agentAsTool<TAgent extends Agent<any, any>>(
  agent: TAgent,
  options: AgentAsToolOptions<TAgent>
): FunctionTool {
  const createTool = (sandbox?: SandboxRunConfig): TemporalAgentTool =>
    ({
      type: 'function',
      name: options.toolName,
      description: options.toolDescription ?? '',
      parameters: {
        type: 'object',
        properties: { input: { type: 'string' } },
        required: ['input'],
        additionalProperties: false,
      },
      strict: true,
      async invoke(_runContext: RunContext<any>, input: string): Promise<string> {
        let parsed: { input: string };
        try {
          parsed = JSON.parse(input);
        } catch (e) {
          throw new ToolSerializationError(`Failed to parse tool input for '${options.toolName}': ${e}`);
        }
        const runner = new TemporalOpenAIRunner();
        const result = await runner.run(
          agent,
          parsed.input,
          sandbox === undefined ? undefined : { runConfig: { sandbox } }
        );
        return extractToolOutput(result, agent.name, options);
      },
      needsApproval: async () => false,
      isEnabled: async () => true,
      [agentAsToolSandboxConfig]: createTool,
    }) as TemporalAgentTool;

  return createTool();
}

export async function extractToolOutput<TAgent extends Agent<any, any>>(
  result: RunResult<any, TAgent>,
  agentName: string,
  options: AgentAsToolOptions<TAgent>
): Promise<string> {
  if (result.interruptions.length > 0) {
    throw ApplicationFailure.create({
      type: 'NestedAgentInterruption',
      nonRetryable: true,
      message:
        `Nested agent '${agentName}' invoked via agentAsTool('${options.toolName}') paused for ` +
        `${result.interruptions.length} approval interruption(s). agentAsTool does not currently ` +
        `bridge nested approval interruptions to the parent runner; handle approvals at the top-level runner instead.`,
    });
  }
  if (options.customOutputExtractor) {
    return options.customOutputExtractor(result);
  }
  if (result.finalOutput === undefined) return '';
  return typeof result.finalOutput === 'string' ? result.finalOutput : JSON.stringify(result.finalOutput);
}
