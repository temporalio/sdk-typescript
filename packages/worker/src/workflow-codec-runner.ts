import { defaultPayloadCodec, Encoded, PayloadCodec } from '@temporalio/common';
import {
  decodeFailure,
  encodeMap,
  encodeOptional,
  encodeOptionalFailure,
  encodeOptionalSingle,
} from '@temporalio/internal-non-workflow-common';
import { coresdk } from '@temporalio/proto';
import { clone, setWith } from 'lodash';

type EncodedCompletion = Encoded<coresdk.workflow_completion.IWorkflowActivationCompletion>;

/**
 * Helper class for decoding Workflow activations and encoding Workflow completions.
 */
export class WorkflowCodecRunner {
  constructor(protected readonly codec: PayloadCodec) {}

  /**
   * Run codec.decode on the Payloads in the Activation message.
   */
  public async decodeActivation(
    activation: coresdk.workflow_activation.IWorkflowActivation
  ): Promise<coresdk.workflow_activation.IWorkflowActivation> {
    const decodedActivation = { ...activation };
    if (activation.jobs?.length) {
      decodedActivation.jobs = await Promise.all(
        activation.jobs.map(async (job) => {
          const decodedJob = { ...job };
          if (decodedJob.startWorkflow?.arguments) {
            setWith(
              decodedJob,
              'startWorkflow.arguments',
              await this.codec.decode(decodedJob.startWorkflow.arguments),
              clone
            );
          }
          if (decodedJob.queryWorkflow?.arguments) {
            setWith(
              decodedJob,
              'queryWorkflow.arguments',
              await this.codec.decode(decodedJob.queryWorkflow.arguments),
              clone
            );
          }
          if (decodedJob.cancelWorkflow?.details) {
            setWith(
              decodedJob,
              'cancelWorkflow.details',
              await this.codec.decode(decodedJob.cancelWorkflow.details),
              clone
            );
          }
          if (decodedJob.signalWorkflow?.input) {
            setWith(
              decodedJob,
              'signalWorkflow.input',
              await this.codec.decode(decodedJob.signalWorkflow.input),
              clone
            );
          }
          // if (decodedJob.startWorkflow?.headers) {
          //   await Promise.all(
          //     Object.entries(decodedJob.startWorkflow.headers).map(async ([header, payload]) => {
          //       const [decodedPayload] = await this.codec.decode([payload]);
          //       setWith(decodedJob, `startWorkflow.headers.${header}`, decodedPayload, clone);
          //     })
          //   );
          // }
          if (decodedJob.resolveActivity?.result?.completed?.result) {
            const [decodedResult] = await this.codec.decode([decodedJob.resolveActivity.result.completed.result]);
            setWith(decodedJob, 'resolveActivity.result.completed.result', decodedResult, clone);
          }
          if (decodedJob.resolveChildWorkflowExecution?.result?.completed?.result) {
            const [decodedResult] = await this.codec.decode([
              decodedJob.resolveChildWorkflowExecution.result.completed.result,
            ]);
            setWith(decodedJob, 'resolveChildWorkflowExecution.result.completed.result', decodedResult, clone);
          }
          if (decodedJob.resolveActivity?.result?.failed?.failure) {
            decodedJob.resolveActivity.result.failed.failure = await decodeFailure(
              this.codec,
              decodedJob.resolveActivity.result.failed.failure
            );
          }
          if (decodedJob.resolveActivity?.result?.cancelled?.failure) {
            decodedJob.resolveActivity.result.cancelled.failure = await decodeFailure(
              this.codec,
              decodedJob.resolveActivity.result.cancelled.failure
            );
          }
          if (decodedJob.resolveChildWorkflowExecutionStart?.cancelled?.failure) {
            decodedJob.resolveChildWorkflowExecutionStart.cancelled.failure = await decodeFailure(
              this.codec,
              decodedJob.resolveChildWorkflowExecutionStart.cancelled.failure
            );
          }
          if (decodedJob.resolveSignalExternalWorkflow?.failure) {
            decodedJob.resolveSignalExternalWorkflow.failure = await decodeFailure(
              this.codec,
              decodedJob.resolveSignalExternalWorkflow.failure
            );
          }
          if (decodedJob.resolveChildWorkflowExecution?.result?.failed?.failure) {
            decodedJob.resolveChildWorkflowExecution.result.failed.failure = await decodeFailure(
              this.codec,
              decodedJob.resolveChildWorkflowExecution.result.failed.failure
            );
          }
          if (decodedJob.resolveChildWorkflowExecution?.result?.cancelled?.failure) {
            decodedJob.resolveChildWorkflowExecution.result.cancelled.failure = await decodeFailure(
              this.codec,
              decodedJob.resolveChildWorkflowExecution.result.cancelled.failure
            );
          }
          if (decodedJob.resolveRequestCancelExternalWorkflow?.failure) {
            decodedJob.resolveRequestCancelExternalWorkflow.failure = await decodeFailure(
              this.codec,
              decodedJob.resolveRequestCancelExternalWorkflow.failure
            );
          }
          return decodedJob;
        })
      );
    }
    return decodedActivation;
  }

  /**
   * Run codec.encode on the Payloads inside the Completion message.
   */
  public async encodeCompletion(completionBytes: Uint8Array): Promise<Uint8Array> {
    const completion = coresdk.workflow_completion.WorkflowActivationCompletion.decodeDelimited(completionBytes);
    const encodedCompletion: EncodedCompletion = {
      ...completion,
      ...(completion.failed?.failure && {
        failed: { failure: await encodeOptionalFailure(this.codec, completion.failed.failure) },
      }),
      ...(completion.successful && {
        successful: {
          ...completion.successful,
          commands: await Promise.all(
            completion.successful?.commands?.map(async (command) => ({
              ...command,
              ...(command.scheduleActivity && {
                scheduleActivity: {
                  ...command.scheduleActivity,
                  arguments: await encodeOptional(this.codec, command.scheduleActivity.arguments),
                  // use no-op codec on headers
                  headerFields: await encodeMap(defaultPayloadCodec, command.scheduleActivity.headerFields),
                },
              }),
              ...(command.respondToQuery && {
                respondToQuery: {
                  ...command.respondToQuery,
                  succeeded: {
                    response: await encodeOptionalSingle(this.codec, command.respondToQuery.succeeded?.response),
                  },
                  failed: await encodeOptionalFailure(this.codec, command.respondToQuery.failed),
                },
              }),
              ...(command.completeWorkflowExecution && {
                completeWorkflowExecution: {
                  ...command.completeWorkflowExecution,
                  result: await encodeOptionalSingle(this.codec, command.completeWorkflowExecution.result),
                },
              }),
              ...(command.failWorkflowExecution && {
                failWorkflowExecution: {
                  ...command.failWorkflowExecution,
                  failure: await encodeOptionalFailure(this.codec, command.failWorkflowExecution.failure),
                },
              }),
              ...(command.continueAsNewWorkflowExecution && {
                continueAsNewWorkflowExecution: {
                  ...command.continueAsNewWorkflowExecution,
                  arguments: await encodeOptional(this.codec, command.continueAsNewWorkflowExecution.arguments),
                  memo: await encodeMap(this.codec, command.continueAsNewWorkflowExecution.memo),
                  // use no-op codec on headers
                  header: await encodeMap(defaultPayloadCodec, command.continueAsNewWorkflowExecution.header),
                  // use no-op codec on searchAttributes
                  searchAttributes: await encodeMap(
                    defaultPayloadCodec,
                    command.continueAsNewWorkflowExecution.searchAttributes
                  ),
                },
              }),
              ...(command.startChildWorkflowExecution && {
                startChildWorkflowExecution: {
                  ...command.startChildWorkflowExecution,
                  input: await encodeOptional(this.codec, command.startChildWorkflowExecution.input),
                  memo: await encodeMap(this.codec, command.startChildWorkflowExecution.memo),
                  // use no-op codec on headers
                  header: await encodeMap(defaultPayloadCodec, command.startChildWorkflowExecution.header),
                  // use no-op codec on searchAttributes
                  searchAttributes: await encodeMap(
                    defaultPayloadCodec,
                    command.startChildWorkflowExecution.searchAttributes
                  ),
                },
              }),
              ...(command.signalExternalWorkflowExecution && {
                signalExternalWorkflowExecution: {
                  ...command.signalExternalWorkflowExecution,
                  args: await encodeOptional(this.codec, command.signalExternalWorkflowExecution.args),
                },
              }),
            })) ?? []
          ),
        },
      }),
    };

    return coresdk.workflow_completion.WorkflowActivationCompletion.encodeDelimited(encodedCompletion).finish();
  }
}
