import { Decoded, Encoded, PayloadCodec } from '@temporalio/common';
import {
  decodeOptional,
  decodeOptionalFailure,
  decodeOptionalSingle,
  encodeMap,
  encodeOptional,
  encodeOptionalFailure,
  encodeOptionalSingle,
  noopDecodeMap,
  noopEncodeMap,
  TypecheckedPayloadCodec,
} from '@temporalio/internal-non-workflow-common';
import { coresdk } from '@temporalio/proto';

type EncodedCompletion = Encoded<coresdk.workflow_completion.IWorkflowActivationCompletion>;
type DecodedActivation = Decoded<coresdk.workflow_activation.IWorkflowActivation>;

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
  ): Promise<DecodedActivation> {
    return {
      ...activation,
      jobs: activation.jobs
        ? await Promise.all(
            activation.jobs.map(async (job) => ({
              ...job,
              startWorkflow: job.startWorkflow
                ? {
                    ...job.startWorkflow,
                    arguments: await decodeOptional(this.codec, job.startWorkflow.arguments),
                    headers: noopDecodeMap(job.startWorkflow.headers),
                  }
                : null,
              queryWorkflow: job.queryWorkflow
                ? {
                    ...job.queryWorkflow,
                    arguments: await decodeOptional(this.codec, job.queryWorkflow.arguments),
                  }
                : null,
              cancelWorkflow: job.cancelWorkflow
                ? {
                    ...job.cancelWorkflow,
                    details: await decodeOptional(this.codec, job.cancelWorkflow.details),
                  }
                : null,
              signalWorkflow: job.signalWorkflow
                ? {
                    ...job.signalWorkflow,
                    input: await decodeOptional(this.codec, job.signalWorkflow.input),
                  }
                : null,
              resolveActivity: job.resolveActivity
                ? {
                    ...job.resolveActivity,
                    result: job.resolveActivity.result
                      ? {
                          ...job.resolveActivity.result,
                          completed: job.resolveActivity.result.completed
                            ? {
                                result: await decodeOptionalSingle(
                                  this.codec,
                                  job.resolveActivity.result.completed.result
                                ),
                              }
                            : null,
                          failed: job.resolveActivity.result.failed
                            ? {
                                failure: await decodeOptionalFailure(
                                  this.codec,
                                  job.resolveActivity.result.failed.failure
                                ),
                              }
                            : null,
                          cancelled: job.resolveActivity.result.cancelled
                            ? {
                                failure: await decodeOptionalFailure(
                                  this.codec,
                                  job.resolveActivity.result.cancelled.failure
                                ),
                              }
                            : null,
                        }
                      : null,
                  }
                : null,
              resolveChildWorkflowExecution: job.resolveChildWorkflowExecution
                ? {
                    ...job.resolveChildWorkflowExecution,
                    result: job.resolveChildWorkflowExecution.result
                      ? {
                          ...job.resolveChildWorkflowExecution.result,
                          completed: job.resolveChildWorkflowExecution.result.completed
                            ? {
                                result: await decodeOptionalSingle(
                                  this.codec,
                                  job.resolveChildWorkflowExecution.result.completed.result
                                ),
                              }
                            : null,
                          failed: job.resolveChildWorkflowExecution.result.failed
                            ? {
                                failure: await decodeOptionalFailure(
                                  this.codec,
                                  job.resolveChildWorkflowExecution.result.failed.failure
                                ),
                              }
                            : null,
                          cancelled: job.resolveChildWorkflowExecution.result.cancelled
                            ? {
                                failure: await decodeOptionalFailure(
                                  this.codec,
                                  job.resolveChildWorkflowExecution.result.cancelled.failure
                                ),
                              }
                            : null,
                        }
                      : null,
                  }
                : null,
              resolveChildWorkflowExecutionStart: job.resolveChildWorkflowExecutionStart
                ? {
                    ...job.resolveChildWorkflowExecutionStart,
                    cancelled: job.resolveChildWorkflowExecutionStart.cancelled
                      ? {
                          failure: await decodeOptionalFailure(
                            this.codec,
                            job.resolveChildWorkflowExecutionStart.cancelled.failure
                          ),
                        }
                      : null,
                  }
                : null,
              resolveSignalExternalWorkflow: job.resolveSignalExternalWorkflow
                ? {
                    ...job.resolveSignalExternalWorkflow,
                    failure: await decodeOptionalFailure(this.codec, job.resolveSignalExternalWorkflow.failure),
                  }
                : null,
              resolveRequestCancelExternalWorkflow: job.resolveRequestCancelExternalWorkflow
                ? {
                    ...job.resolveRequestCancelExternalWorkflow,
                    failure: await decodeOptionalFailure(this.codec, job.resolveRequestCancelExternalWorkflow.failure),
                  }
                : null,
            }))
          )
        : null,
    };
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
