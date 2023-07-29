/* eslint-disable no-duplicate-imports */
import { defineSignal } from '@temporalio/workflow';

export const activityStartedSignal = defineSignal('activityStarted');
export const failSignal = defineSignal('fail');
export const failWithMessageSignal = defineSignal<[string]>('fail');
export const argsTestSignal = defineSignal<[number, string]>('argsTest');
export const unblockSignal = defineSignal('unblock');
