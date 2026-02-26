/**
 * Workflow that starts a child workflow with an auto-generated ID.
 * The child workflow ID comes from uuid4() which uses Math.random().
 * If OTel span creation consumes Math.random(), the generated child
 * workflow ID will differ on replay, causing a nondeterminism error.
 */
import { executeChild } from '@temporalio/workflow';
import { successString } from './success-string';

export async function prngIsolation(): Promise<string> {
  return executeChild(successString, {});
}
