import { activityInfo } from '@temporalio/activity';

export interface NameAndArgs {
  name: string;
  activityName?: string;
  args: any[];
}

export async function definedActivity(...args: unknown[]): Promise<NameAndArgs> {
  return { name: 'definedActivity', args };
}

export default async function (...args: unknown[]): Promise<NameAndArgs> {
  return { name: 'default', activityName: activityInfo().activityType, args };
}
