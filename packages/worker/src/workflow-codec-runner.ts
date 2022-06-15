import { PayloadCodec } from '@temporalio/common';
import {
  Decoded,
  decodeOptional,
  decodeOptionalFailure,
  decodeOptionalMap,
  decodeOptionalSingle,
  Encoded,
  encodeMap,
  encodeOptional,
  encodeOptionalFailure,
  encodeOptionalSingle,
  noopDecodeMap,
  noopEncodeMap,
} from '@temporalio/internal-non-workflow-common';
import { coresdk } from '@temporalio/proto';

type EncodedCompletion = Encoded<coresdk.workflow_completion.IWorkflowActivationCompletion>;
type DecodedActivation = Decoded<coresdk.workflow_activation.IWorkflowActivation>;

/**
 * Helper class for decoding Workflow activations and encoding Workflow completions.
 */
export class WorkflowCodecRunner {
  constructor(protected readonly codecs: PayloadCodec[]) {}

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
                    arguments: await decodeOptional(this.codecs, job.startWorkflow.arguments),
                    headers: noopDecodeMap(job.startWorkflow.headers),
                    continuedFailure: await decodeOptionalFailure(this.codecs, job.startWorkflow.continuedFailure),
                    memo: {
                      fields: await decodeOptionalMap(this.codecs, job.startWorkflow.memo?.fields),
                    },
                    lastCompletionResult: {
                      payloads: await decodeOptional(this.codecs, job.startWorkflow.lastCompletionResult?.payloads),
                    },
                    searchAttributes: job.startWorkflow.searchAttributes
                      ? {
                          indexedFields: job.startWorkflow.searchAttributes.indexedFields
                            ? noopDecodeMap(job.startWorkflow.searchAttributes?.indexedFields)
                            : undefined,
                        }
                      : undefined,
                  }
                : null,
              queryWorkflow: job.queryWorkflow
                ? {
                    ...job.queryWorkflow,
                    arguments: await decodeOptional(this.codecs, job.queryWorkflow.arguments),
                    headers: noopDecodeMap(job.queryWorkflow.headers),
                  }
                : null,
              cancelWorkflow: job.cancelWorkflow
                ? {
                    ...job.cancelWorkflow,
                    details: await decodeOptional(this.codecs, job.cancelWorkflow.details),
                  }
                : null,
              signalWorkflow: job.signalWorkflow
                ? {
                    ...job.signalWorkflow,
                    input: await decodeOptional(this.codecs, job.signalWorkflow.input),
                    headers: noopDecodeMap(job.signalWorkflow.headers),
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
                                  this.codecs,
                                  job.resolveActivity.result.completed.result
                                ),
                              }
                            : null,
                          failed: job.resolveActivity.result.failed
                            ? {
                                failure: await decodeOptionalFailure(
                                  this.codecs,
                                  job.resolveActivity.result.failed.failure
                                ),
                              }
                            : null,
                          cancelled: job.resolveActivity.result.cancelled
                            ? {
                                failure: await decodeOptionalFailure(
                                  this.codecs,
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
                                  this.codecs,
                                  job.resolveChildWorkflowExecution.result.completed.result
                                ),
                              }
                            : null,
                          failed: job.resolveChildWorkflowExecution.result.failed
                            ? {
                                failure: await decodeOptionalFailure(
                                  this.codecs,
                                  job.resolveChildWorkflowExecution.result.failed.failure
                                ),
                              }
                            : null,
                          cancelled: job.resolveChildWorkflowExecution.result.cancelled
                            ? {
                                failure: await decodeOptionalFailure(
                                  this.codecs,
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
                            this.codecs,
                            job.resolveChildWorkflowExecutionStart.cancelled.failure
                          ),
                        }
                      : null,
                  }
                : null,
              resolveSignalExternalWorkflow: job.resolveSignalExternalWorkflow
                ? {
                    ...job.resolveSignalExternalWorkflow,
                    failure: await decodeOptionalFailure(this.codecs, job.resolveSignalExternalWorkflow.failure),
                  }
                : null,
              resolveRequestCancelExternalWorkflow: job.resolveRequestCancelExternalWorkflow
                ? {
                    ...job.resolveRequestCancelExternalWorkflow,
                    failure: await decodeOptionalFailure(this.codecs, job.resolveRequestCancelExternalWorkflow.failure),
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
        ? { failure: await encodeOptionalFailure(this.codecs, completion?.failed?.failure) }
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
                          arguments: await encodeOptional(this.codecs, command.scheduleActivity?.arguments),
                          // don't encode headers
                          headers: noopEncodeMap(command.scheduleActivity?.headers),
                        }
                      : undefined,
                    upsertWorkflowSearchAttributes: command.upsertWorkflowSearchAttributes
                      ? {
                          ...command.upsertWorkflowSearchAttributes,
                          searchAttributes: noopEncodeMap(command.upsertWorkflowSearchAttributes.searchAttributes),
                        }
                      : undefined,
                    respondToQuery: command.respondToQuery
                      ? {
                          ...command.respondToQuery,
                          succeeded: {
                            response: await encodeOptionalSingle(
                              this.codecs,
                              command.respondToQuery.succeeded?.response
                            ),
                          },
                          failed: await encodeOptionalFailure(this.codecs, command.respondToQuery.failed),
                        }
                      : undefined,

                    completeWorkflowExecution: command.completeWorkflowExecution
                      ? {
                          ...command.completeWorkflowExecution,
                          result: await encodeOptionalSingle(this.codecs, command.completeWorkflowExecution.result),
                        }
                      : undefined,
                    failWorkflowExecution: command.failWorkflowExecution
                      ? {
                          ...command.failWorkflowExecution,
                          failure: await encodeOptionalFailure(this.codecs, command.failWorkflowExecution.failure),
                        }
                      : undefined,
                    continueAsNewWorkflowExecution: command.continueAsNewWorkflowExecution
                      ? {
                          ...command.continueAsNewWorkflowExecution,
                          arguments: await encodeOptional(
                            this.codecs,
                            command.continueAsNewWorkflowExecution.arguments
                          ),
                          memo: await encodeMap(this.codecs, command.continueAsNewWorkflowExecution.memo),
                          // don't encode headers
                          headers: noopEncodeMap(command.continueAsNewWorkflowExecution.headers),
                          // don't encode searchAttributes
                          searchAttributes: noopEncodeMap(command.continueAsNewWorkflowExecution.searchAttributes),
                        }
                      : undefined,
                    startChildWorkflowExecution: command.startChildWorkflowExecution
                      ? {
                          ...command.startChildWorkflowExecution,
                          input: await encodeOptional(this.codecs, command.startChildWorkflowExecution.input),
                          memo: await encodeMap(this.codecs, command.startChildWorkflowExecution.memo),
                          // don't encode headers
                          headers: noopEncodeMap(command.startChildWorkflowExecution.headers),
                          // don't encode searchAttributes
                          searchAttributes: noopEncodeMap(command.startChildWorkflowExecution.searchAttributes),
                        }
                      : undefined,
                    signalExternalWorkflowExecution: command.signalExternalWorkflowExecution
                      ? {
                          ...command.signalExternalWorkflowExecution,
                          args: await encodeOptional(this.codecs, command.signalExternalWorkflowExecution.args),
                          headers: noopEncodeMap(command.signalExternalWorkflowExecution.headers),
                        }
                      : undefined,
                    scheduleLocalActivity: command.scheduleLocalActivity
                      ? {
                          ...command.scheduleLocalActivity,
                          arguments: await encodeOptional(this.codecs, command.scheduleLocalActivity.arguments),
                          // don't encode headers
                          headers: noopEncodeMap(command.scheduleLocalActivity.headers),
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
