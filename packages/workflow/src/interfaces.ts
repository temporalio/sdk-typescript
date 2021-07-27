import { coresdk } from '@temporalio/proto';
export * from './dependencies';

/**
 * Workflow execution information
 */
export interface WorkflowInfo {
  /**
   * ID of the Workflow, this can be set by the client during Workflow creation.
   * A single Workflow may run multiple times e.g. when scheduled with cron.
   */
  workflowId: string;
  /**
   * ID of a single Workflow run
   */
  runId: string;

  /**
   * Filename containing the Workflow code
   */
  filename: string;

  /**
   * Namespace this Workflow is scheduled in
   */
  namespace: string;

  /**
   * Task queue this Workflow is scheduled in
   */
  taskQueue: string;

  /**
   * Whether a Workflow is replaying history or processing new events
   */
  isReplaying: boolean;
}

/**
 * Not an actual error, used by the Workflow runtime to abort execution when {@link Context.continueAsNew} is called
 */
export class ContinueAsNew extends Error {
  public readonly type = 'ContinueAsNew';

  constructor(public readonly command: coresdk.workflow_commands.IContinueAsNewWorkflowExecution) {
    super();
  }
}

/**
 * Options for continuing a Workflow as new
 */
export interface ContinueAsNewOptions {
  /**
   * A string representing the Workflow type name, e.g. the filename in the Node.js SDK or class name in Java
   */
  workflowType?: string;
  /**
   * Task queue to continue the Workflow in
   */
  taskQueue?: string;
  /**
   * Timeout for the entire Workflow run
   * @format {@link https://www.npmjs.com/package/ms | ms} formatted string
   */
  workflowRunTimeout?: string;
  /**
   * Timeout for a single Workflow task
   * @format {@link https://www.npmjs.com/package/ms | ms} formatted string
   */
  workflowTaskTimeout?: string;
  /**
   * Non-searchable attributes to attach to next Workflow run
   */
  memo?: Record<string, any>;
  /**
   * Searchable attributes to attach to next Workflow run
   */
  searchAttributes?: Record<string, any>;
}
