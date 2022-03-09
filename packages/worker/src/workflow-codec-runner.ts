import { Encoded, PayloadCodec } from '@temporalio/common';
import {
  decodeFailure,
  encodeMap,
  encodeOptional,
  encodeOptionalFailure,
  encodeOptionalSingle,
  noopEncodeMap,
  TypecheckedPayloadCodec,
} from '@temporalio/internal-non-workflow-common';
import { coresdk } from '@temporalio/proto';
import { clone, setWith } from 'lodash';

type EncodedCompletion = Encoded<coresdk.workflow_completion.IWorkflowActivationCompletion>;

/**
 * Helper class for decoding Workflow activations and encoding Workflow completions.
 */
export class WorkflowCodecRunner {
  protected readonly codec: TypecheckedPayloadCodec;

  constructor(codec: PayloadCodec) {
    this.codec = codec as TypecheckedPayloadCodec;
  }

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
      failed: completion.failed
        ? { failure: await encodeOptionalFailure(this.codec, completion?.failed?.failure) }
        : null,
      successful: completion.successful
        ? {
            commands: completion.successful.commands
              ? await Promise.all(
                  completion.successful.commands.map(async (command) => ({
                    ...command,
                    scheduleActivity: command.scheduleActivity
                      ? {
                          ...command.scheduleActivity,
                          arguments: await encodeOptional(this.codec, command.scheduleActivity?.arguments),
                          // don't encode headers
                          headerFields: noopEncodeMap(command.scheduleActivity?.headerFields),
                        }
                      : undefined,
                    respondToQuery: command.respondToQuery
                      ? {
                          ...command.respondToQuery,
                          succeeded: {
                            response: await encodeOptionalSingle(
                              this.codec,
                              command.respondToQuery.succeeded?.response
                            ),
                          },
                          failed: await encodeOptionalFailure(this.codec, command.respondToQuery.failed),
                        }
                      : undefined,

                    completeWorkflowExecution: command.completeWorkflowExecution
                      ? {
                          ...command.completeWorkflowExecution,
                          result: await encodeOptionalSingle(this.codec, command.completeWorkflowExecution.result),
                        }
                      : undefined,
                    failWorkflowExecution: command.failWorkflowExecution
                      ? {
                          ...command.failWorkflowExecution,
                          failure: await encodeOptionalFailure(this.codec, command.failWorkflowExecution.failure),
                        }
                      : undefined,
                    continueAsNewWorkflowExecution: command.continueAsNewWorkflowExecution
                      ? {
                          ...command.continueAsNewWorkflowExecution,
                          arguments: await encodeOptional(this.codec, command.continueAsNewWorkflowExecution.arguments),
                          memo: await encodeMap(this.codec, command.continueAsNewWorkflowExecution.memo),
                          // don't encode headers
                          header: noopEncodeMap(command.continueAsNewWorkflowExecution.header),
                          // don't encode searchAttributes
                          searchAttributes: noopEncodeMap(command.continueAsNewWorkflowExecution.searchAttributes),
                        }
                      : undefined,
                    startChildWorkflowExecution: command.startChildWorkflowExecution
                      ? {
                          ...command.startChildWorkflowExecution,
                          input: await encodeOptional(this.codec, command.startChildWorkflowExecution.input),
                          memo: await encodeMap(this.codec, command.startChildWorkflowExecution.memo),
                          // don't encode headers
                          header: noopEncodeMap(command.startChildWorkflowExecution.header),
                          // don't encode searchAttributes
                          searchAttributes: noopEncodeMap(command.startChildWorkflowExecution.searchAttributes),
                        }
                      : undefined,
                    signalExternalWorkflowExecution: command.signalExternalWorkflowExecution
                      ? {
                          ...command.signalExternalWorkflowExecution,
                          args: await encodeOptional(this.codec, command.signalExternalWorkflowExecution.args),
                        }
                      : undefined,
                    cancelWorkflowExecution: command.cancelWorkflowExecution ? { encoded: true } : undefined,
                    scheduleLocalActivity: command.scheduleLocalActivity
                      ? {
                          ...command.scheduleLocalActivity,
                          arguments: await encodeOptional(this.codec, command.scheduleLocalActivity.arguments),
                          // don't encode headers
                          headerFields: noopEncodeMap(command.scheduleLocalActivity.headerFields),
                        }
                      : undefined,
                  })) ?? []
                )
              : null,
          }
        : null,
    };

    return coresdk.workflow_completion.WorkflowActivationCompletion.encodeDelimited(encodedCompletion).finish();
  }
}
