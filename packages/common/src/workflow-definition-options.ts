import { VersioningBehavior } from './worker-deployments';

/**
 * Options that can be used when defining a workflow via {@link setWorkflowOptions}.
 */
export interface WorkflowDefinitionOptions {
  versioningBehavior?: VersioningBehavior;
}

type AsyncFunction<Args extends any[], ReturnType> = (...args: Args) => Promise<ReturnType>;
export type WorkflowDefinitionOptionsOrGetter = WorkflowDefinitionOptions | (() => WorkflowDefinitionOptions);

/**
 * @internal
 * @hidden
 * A workflow function that has been defined with options from {@link WorkflowDefinitionOptions}.
 */
export interface WorkflowFunctionWithOptions<Args extends any[], ReturnType> extends AsyncFunction<Args, ReturnType> {
  workflowDefinitionOptions: WorkflowDefinitionOptionsOrGetter;
}
