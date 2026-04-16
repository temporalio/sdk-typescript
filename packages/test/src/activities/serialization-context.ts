import { activityInfo, heartbeat } from '@temporalio/activity';
import { ContextTrace, withLabel } from '../payload-converters/serialization-context-converter';

export async function echoTrace<T>(inputTrace: ContextTrace<string>, value: T): Promise<ContextTrace<T>> {
  return withLabel(inputTrace, value);
}

export async function heartbeatTrace<T>(inputTrace: ContextTrace<string>, value: T): Promise<ContextTrace<T>> {
  if (activityInfo().attempt === 1) {
    heartbeat(withLabel(inputTrace, value));
    throw new Error('retry me');
  }
  return activityInfo().heartbeatDetails as ContextTrace<T>;
}
