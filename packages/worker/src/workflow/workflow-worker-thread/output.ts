import { SinkCall } from '@temporalio/workflow/lib/sinks';

export interface ActivationCompletion {
  type: 'activation-completion';
  completion: Uint8Array;
}

export interface SinkCallList {
  type: 'sink-calls';
  calls: SinkCall[];
}

export type WorkerThreadOutput = ActivationCompletion | SinkCallList | undefined;

export interface WorkerThreadResponse {
  requestId: BigInt;

  result:
    | {
        type: 'ok';
        output?: WorkerThreadOutput;
      }
    | {
        type: 'error';
        /** Error class name */
        name: string;
        message: string;
        stack: string;
      };
}
