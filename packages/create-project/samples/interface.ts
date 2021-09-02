// @@@SNIPSTART nodejs-hello-workflow-interface

// Define our Example Workflow type (this step is optional).
// Workflow types are useful for generating type safe workflow clients
// in environments where the Workflow implemetations are unavailable.
export type Example = (name: string) => {
  execute(): Promise<string>;
};
// @@@SNIPEND
