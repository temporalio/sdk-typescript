import { registerWorkflow } from './internals';
 // @ts-ignore
import * as workflowModule from 'main';

export function run() {
  // support both export workflow and export main, signals, ..
  // exporting workflow is encouraged for type checking
  registerWorkflow(workflowModule.workflow || workflowModule);
}
