import type { AgentInputItem, Session } from '@openai/agents-core';
import { inWorkflowContext, workflowInfo } from '@temporalio/workflow';

export interface WorkflowSafeMemorySessionOptions {
  /** Defaults to the current `workflowId` when omitted. */
  sessionId?: string;
  initialItems?: AgentInputItem[];
}

/**
 * Workflow-sandbox-safe `Session` for `TemporalOpenAIRunner.run`. Upstream
 * `MemorySession` depends on Node-only utilities and is rejected at runtime.
 */
export class WorkflowSafeMemorySession implements Session {
  private readonly sessionId: string;
  private items: AgentInputItem[];

  constructor(options: WorkflowSafeMemorySessionOptions = {}) {
    if (options.sessionId === undefined && !inWorkflowContext()) {
      throw new Error(
        'WorkflowSafeMemorySession: no sessionId provided and not running in a Workflow context. ' +
          'Pass `sessionId` explicitly or construct from inside a Workflow.'
      );
    }
    this.sessionId = options.sessionId ?? workflowInfo().workflowId;
    this.items = options.initialItems ? [...options.initialItems] : [];
  }

  async getSessionId(): Promise<string> {
    return this.sessionId;
  }

  async getItems(limit?: number): Promise<AgentInputItem[]> {
    if (limit === undefined) return [...this.items];
    if (limit <= 0) return [];
    return this.items.slice(-limit);
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    this.items.push(...items);
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    return this.items.pop();
  }

  async clearSession(): Promise<void> {
    this.items = [];
  }
}
