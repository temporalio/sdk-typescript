import { Context } from '@temporalio/activity';

export async function myWorkflow(): Promise<void> {
  console.log(Context.current());
}
