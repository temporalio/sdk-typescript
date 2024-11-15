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
} from '@temporalio/common/lib/internal-non-workflow';
import { coresdk } from '@temporalio/proto';

/**
 * Helper class for decoding Workflow activations and encoding Workflow completions.
 */
export class WorkflowCodecRunner {
  constructor(protected readonly codecs: PayloadCodec[]) {}

  /**
   * Run codec.decode on the Payloads in the Activation message.
   */
  public async decodeActivation<T extends coresdk.workflow_activation.IWorkflowActivation>(
    activation: T
  ): Promise<Decoded<T>> {
    return coresdk.workflow_activation.WorkflowActivation.fromObject(<
      Decoded<coresdk.workflow_activation.IWorkflowActivation>
    >{
      ...activation,
      jobs: activation.jobs
        ? await Promise.all(
            activation.jobs.map(async (job) => ({
              ...job,
              initializeWorkflow: job.initializeWorkflow
                ? {
                    ...job.initializeWorkflow,
                    arguments: await decodeOptional(this.codecs, job.initializeWorkflow.arguments),
                    headers: noopDecodeMap(job.initializeWorkflow.headers),
                    continuedFailure: await decodeOptionalFailure(this.codecs, job.initializeWorkflow.continuedFailure),
                    memo: {
                      ...job.initializeWorkflow.memo,
                      fields: await decodeOptionalMap(this.codecs, job.initializeWorkflow.memo?.fields),
                    },
                    lastCompletionResult: {
                      ...job.initializeWorkflow.lastCompletionResult,
                      payloads: await decodeOptional(
                        this.codecs,
                        job.initializeWorkflow.lastCompletionResult?.payloads
                      ),
                    },
                    searchAttributes: job.initializeWorkflow.searchAttributes
                      ? {
                          ...job.initializeWorkflow.searchAttributes,
                          indexedFields: job.initializeWorkflow.searchAttributes.indexedFields
                            ? noopDecodeMap(job.initializeWorkflow.searchAttributes?.indexedFields)
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
              doUpdate: job.doUpdate
                ? {
                    ...job.doUpdate,
                    input: await decodeOptional(this.codecs, job.doUpdate.input),
                    headers: noopDecodeMap(job.doUpdate.headers),
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
                                ...job.resolveActivity.result.completed,
                                result: await decodeOptionalSingle(
                                  this.codecs,
                                  job.resolveActivity.result.completed.result
                                ),
                              }
                            : null,
                          failed: job.resolveActivity.result.failed
                            ? {
                                ...job.resolveActivity.result.failed,
                                failure: await decodeOptionalFailure(
                                  this.codecs,
                                  job.resolveActivity.result.failed.failure
                                ),
                              }
                            : null,
                          cancelled: job.resolveActivity.result.cancelled
                            ? {
                                ...job.resolveActivity.result.cancelled,
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
                                ...job.resolveChildWorkflowExecution.result.completed,
                                result: await decodeOptionalSingle(
                                  this.codecs,
                                  job.resolveChildWorkflowExecution.result.completed.result
                                ),
                              }
                            : null,
                          failed: job.resolveChildWorkflowExecution.result.failed
                            ? {
                                ...job.resolveChildWorkflowExecution.result.failed,
                                failure: await decodeOptionalFailure(
                                  this.codecs,
                                  job.resolveChildWorkflowExecution.result.failed.failure
                                ),
                              }
                            : null,
                          cancelled: job.resolveChildWorkflowExecution.result.cancelled
                            ? {
                                ...job.resolveChildWorkflowExecution.result.cancelled,
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
                          ...job.resolveChildWorkflowExecutionStart.cancelled,
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
    }) as Decoded<T>;
  }

  /**
   * Run codec.encode on the Payloads inside the Completion message.
   */
  public async encodeCompletion(
    completion: coresdk.workflow_completion.IWorkflowActivationCompletion
  ): Promise<Uint8Array> {
    const encodedCompletion: Encoded<coresdk.workflow_completion.IWorkflowActivationCompletion> = {
      ...completion,
      failed: completion.failed
        ? {
            ...completion.failed,
            failure: await encodeOptionalFailure(this.codecs, completion?.failed?.failure),
          }
        : null,
      successful: completion.successful
        ? {
            ...completion.successful,
            commands: completion.successful.commands
              ? await Promise.all(
                  completion.successful.commands.map(
                    async (command) =>
                      <Encoded<coresdk.workflow_commands.IWorkflowCommand>>{
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
                                ...command.respondToQuery.succeeded,
                                response: await encodeOptionalSingle(
                                  this.codecs,
                                  command.respondToQuery.succeeded?.response
                                ),
                              },
                              failed: await encodeOptionalFailure(this.codecs, command.respondToQuery.failed),
                            }
                          : undefined,
                        updateResponse: command.updateResponse
                          ? {
                              ...command.updateResponse,
                              rejected: await encodeOptionalFailure(this.codecs, command.updateResponse.rejected),
                              completed: await encodeOptionalSingle(this.codecs, command.updateResponse.completed),
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
                        modifyWorkflowProperties: command.modifyWorkflowProperties
                          ? {
                              ...command.modifyWorkflowProperties,
                              upsertedMemo: {
                                ...command.modifyWorkflowProperties.upsertedMemo,
                                fields: await encodeMap(
                                  this.codecs,
                                  command.modifyWorkflowProperties.upsertedMemo?.fields
                                ),
                              },
                            }
                          : undefined,
                      }
                  ) ?? []
                )
              : null,
          }
        : null,
    };

    return coresdk.workflow_completion.WorkflowActivationCompletion.encodeDelimited(encodedCompletion).finish();
  }
}
