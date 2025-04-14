import { VersioningBehavior } from './worker-deployments';

/**
 * Options that can be used when defining a workflow via {@link defineWorkflowWithOptions}.
 */
export interface WorkflowDefinitionOptions {
  versioningBehavior?: VersioningBehavior;
}

type AsyncFunction<Args extends any[], ReturnType> = (...args: Args) => Promise<ReturnType>;

/**
 * A workflow function that has been defined with options from {@link WorkflowDefinitionOptions}.
 */
export interface WorkflowFunctionWithOptions<Args extends any[], ReturnType> extends AsyncFunction<Args, ReturnType> {
  __temporal_is_workflow_function_with_options: true;
  options: WorkflowDefinitionOptions;
}
