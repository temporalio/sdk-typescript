import seedrandom from 'seedrandom';
import { Workflow } from './engine';

export async function install(workflow: Workflow) {
  const rng = seedrandom(workflow.id);

  await workflow.inject('Date', () => new Date(123));
  await workflow.inject('Date.now', () => 123);
  await workflow.inject('Math.random', rng);
  await workflow.inject('console.log', console.log);
}
