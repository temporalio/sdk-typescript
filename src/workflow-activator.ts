import { Workflow } from './workflow';
import { coresdk } from '../proto/core_interface';

export type HandlerFunction = (task: coresdk.WorkflowTask) => Promise<coresdk.IWorkflowTaskCompletion>;
export type WorkflowTaskHandler = Record<Exclude<coresdk.WorkflowTask['attributes'], undefined>, HandlerFunction>;

export class Activator implements WorkflowTaskHandler {
  protected constructor(protected readonly workflow: Workflow) {
  }

  static async create(workflowId: string) {
    const workflow = await Workflow.create(workflowId);
    await workflow.inject('console.log', console.log);
    return new Activator(workflow);
  }

  public async startWorkflow(task: coresdk.WorkflowTask): Promise<coresdk.IWorkflowTaskCompletion> {
    // TODO: get script name from task params
    const scriptName = process.argv[process.argv.length - 1];
    const commands = await this.workflow.runMain(scriptName, task.timestamp!.seconds as any * 1000);
    return { successful: { commands } };
  }

 async unblockTimer(task: coresdk.WorkflowTask): Promise<coresdk.IWorkflowTaskCompletion> {
   const commands = await this.workflow.trigger(task);
   return { successful: { commands } };
  }
};
