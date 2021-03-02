import { Workflow } from '@temporalio/workflow';

export interface Example extends Workflow {
  main(name: string): Promise<string>;
}
