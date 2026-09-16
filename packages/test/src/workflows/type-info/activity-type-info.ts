import type { ActivityTypeInfoMap } from '@temporalio/common';
import type * as activities from './activities';
import { workflowTypeInfo } from './models';

export const activityTypeInfo = {
  convertOrder: workflowTypeInfo,
} satisfies ActivityTypeInfoMap<Pick<typeof activities, 'convertOrder'>>;
