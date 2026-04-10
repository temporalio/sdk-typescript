import { assertInWorkflowContext } from './global-attributes';

export function currentRandom(): number {
  return assertInWorkflowContext('Workflow random APIs may only be used from workflow context.').currentRandom();
}
