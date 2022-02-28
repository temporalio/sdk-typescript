import { proxyActivities } from '@temporalio/workflow';
import type { ProtoActivityInput, ProtoActivityResult } from '../../protos/root';
import type * as activities from '../activities';

const { protoActivity } = proxyActivities<typeof activities>({ startToCloseTimeout: '1s' });

export async function protobufWorkflow(args: ProtoActivityInput): Promise<ProtoActivityResult> {
  return await protoActivity(args);
}
