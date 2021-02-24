import { registerWorkflow } from './internals';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import * as workflowModule from 'main';

export function run(): void {
  // support both export workflow and export main, signals, ..
  // exporting workflow is encouraged for type checking
  registerWorkflow(workflowModule.workflow || workflowModule);
}
