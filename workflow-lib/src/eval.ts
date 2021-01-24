import { runWorkflow } from './internals';
 // @ts-ignore
import { main } from 'main';

export function run() {
  runWorkflow({ main });
}
