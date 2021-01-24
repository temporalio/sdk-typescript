import { Workflow } from './engine';

export async function install(workflow: Workflow) {
  await workflow.inject('Date', () => new Date(123));
  await workflow.inject('Date.now', () => 123);
  await workflow.inject('console.log', console.log);
}
