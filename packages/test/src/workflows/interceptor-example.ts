/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
import { WorkflowInterceptors, defaultDataConverter, Headers } from '@temporalio/workflow';
import { echo } from '@activities';

export async function main(): Promise<string> {
  return await echo(); // Do not pass message in, done in Activity interceptor
}

let receivedMessage = '';

export const interceptors: WorkflowInterceptors = {
  inbound: [
    {
      async execute(input, next) {
        const encoded = input.headers.get('message');
        receivedMessage = encoded ? defaultDataConverter.fromPayload(encoded) : '';
        return next(input);
      },
    },
  ],
  outbound: [
    {
      async scheduleActivity(input, next) {
        const headers: Headers = new Map();
        headers.set('message', defaultDataConverter.toPayload(receivedMessage));
        return next({ ...input, headers });
      },
    },
  ],
};
