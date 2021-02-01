import { registerWorkflow } from './internals';
 // @ts-ignore
import { main } from 'main';

export function run() {
  registerWorkflow({ main });
}
