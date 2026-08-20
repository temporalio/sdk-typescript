import type { ActivityTypeInfoMap } from '@temporalio/workflow';
import type * as activities from './activities';
import { workflowTypeInfo } from './models';

export const activityTypeInfo = {
  convertOrder: workflowTypeInfo,
} satisfies ActivityTypeInfoMap<typeof activities>;
