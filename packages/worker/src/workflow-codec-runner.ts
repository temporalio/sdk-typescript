import type {
  ActivitySerializationContext,
  PayloadCodec,
  SerializationContext,
  WorkflowSerializationContext,
} from '@temporalio/common';
import type { Decoded, Encoded } from '@temporalio/common/lib/internal-non-workflow';
import {
  decodeOptional,
  decodeOptionalFailure,
  decodeOptionalMap,
  decodeOptionalSingle,
  encodeMap,
  encodeOptional,
  encodeOptionalFailure,
  encodeOptionalSingle,
  noopDecodeMap,
  noopEncodeMap,
  noopEncodeSearchAttrs,
} from '@temporalio/common/lib/internal-non-workflow';
import { coresdk } from '@temporalio/proto';

/**
 * Helper class for decoding Workflow activations and encoding Workflow completions.
 */
export class WorkflowCodecRunner {
  private readonly pendingCompletionContexts = {
    activity: new Map<number, ActivitySerializationContext>(),
    childWorkflowStart: new Map<number, WorkflowSerializationContext>(),
    childWorkflowComplete: new Map<number, WorkflowSerializationContext>(),
    signalWorkflow: new Map<number, WorkflowSerializationContext>(),
    cancelWorkflow: new Map<number, WorkflowSerializationContext>(),
  };

  constructor(
    private readonly codecs: PayloadCodec[],
    private readonly workflowContext: WorkflowSerializationContext
  ) {}

  private consumeContext<TContext extends SerializationContext>(
    map: Map<number, TContext>,
    seq: number | null | undefined
  ): TContext | undefined {
    if (seq == null) return undefined;
    const context = map.get(seq);
    if (context !== undefined) {
      map.delete(seq);
    }
    return context;
  }

  private activityContext(
    command: coresdk.workflow_commands.IScheduleActivity | coresdk.workflow_commands.IScheduleLocalActivity,
    isLocal: boolean
  ): ActivitySerializationContext {
    return {
      type: 'activity',
      namespace: this.workflowContext.namespace,
      workflowId: this.workflowContext.workflowId,
      activityId: command.activityId || undefined,
      isLocal,
    };
  }

  private childWorkflowContext(
    command: coresdk.workflow_commands.IStartChildWorkflowExecution
  ): WorkflowSerializationContext | undefined {
    if (command.workflowId == null) return undefined;
    return {
      type: 'workflow',
      namespace: command.namespace || this.workflowContext.namespace,
      workflowId: command.workflowId,
    };
  }

  private externalWorkflowContext(
    command:
      | coresdk.workflow_commands.ISignalExternalWorkflowExecution
      | coresdk.workflow_commands.IRequestCancelExternalWorkflowExecution
  ): WorkflowSerializationContext | undefined {
    const workflowId =
      command.workflowExecution?.workflowId ?? ('childWorkflowId' in command ? command.childWorkflowId : undefined);
    if (workflowId == null) return undefined;
    return {
      type: 'workflow',
      namespace: command.workflowExecution?.namespace || this.workflowContext.namespace,
      workflowId,
    };
  }

  private async encodeUserMetadata(
    context: SerializationContext,
    userMetadata: coresdk.workflow_commands.IWorkflowCommand['userMetadata']
  ): Promise<Encoded<NonNullable<coresdk.workflow_commands.IWorkflowCommand['userMetadata']>> | undefined> {
    if (!(userMetadata && (userMetadata.summary || userMetadata.details))) {
      return undefined;
    }

    return {
      summary: await encodeOptionalSingle(this.codecs, userMetadata.summary, context),
      details: await encodeOptionalSingle(this.codecs, userMetadata.details, context),
    };
  }

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
            activation.jobs.map(async (job) => {
              const resolveActivityContext = job.resolveActivity
                ? this.consumeContext(this.pendingCompletionContexts.activity, job.resolveActivity.seq)
                : undefined;
              const resolveChildWorkflowExecutionContext = job.resolveChildWorkflowExecution
                ? this.consumeContext(
                    this.pendingCompletionContexts.childWorkflowComplete,
                    job.resolveChildWorkflowExecution.seq
                  )
                : undefined;
              const resolveChildWorkflowStartContext = job.resolveChildWorkflowExecutionStart
                ? this.consumeContext(
                    this.pendingCompletionContexts.childWorkflowStart,
                    job.resolveChildWorkflowExecutionStart.seq
                  )
                : undefined;
              const resolveSignalContext = job.resolveSignalExternalWorkflow
                ? this.consumeContext(
                    this.pendingCompletionContexts.signalWorkflow,
                    job.resolveSignalExternalWorkflow.seq
                  )
                : undefined;
              const resolveCancelContext = job.resolveRequestCancelExternalWorkflow
                ? this.consumeContext(
                    this.pendingCompletionContexts.cancelWorkflow,
                    job.resolveRequestCancelExternalWorkflow.seq
                  )
                : undefined;

              return {
                ...job,
                initializeWorkflow: job.initializeWorkflow
                  ? {
                      ...job.initializeWorkflow,
                      arguments: await decodeOptional(
                        this.codecs,
                        job.initializeWorkflow.arguments,
                        this.workflowContext
                      ),
                      headers: noopDecodeMap(job.initializeWorkflow.headers),
                      continuedFailure: await decodeOptionalFailure(
                        this.codecs,
                        job.initializeWorkflow.continuedFailure,
                        this.workflowContext
                      ),
                      memo: {
                        ...job.initializeWorkflow.memo,
                        fields: await decodeOptionalMap(
                          this.codecs,
                          job.initializeWorkflow.memo?.fields,
                          this.workflowContext
                        ),
                      },
                      lastCompletionResult: {
                        ...job.initializeWorkflow.lastCompletionResult,
                        payloads: await decodeOptional(
                          this.codecs,
                          job.initializeWorkflow.lastCompletionResult?.payloads,
                          this.workflowContext
                        ),
                      },
                      searchAttributes: job.initializeWorkflow.searchAttributes
                        ? {
                            ...job.initializeWorkflow.searchAttributes,
                            indexedFields: job.initializeWorkflow.searchAttributes.indexedFields
                              ? noopDecodeMap(job.initializeWorkflow.searchAttributes.indexedFields)
                              : undefined,
                          }
                        : undefined,
                    }
                  : null,
                queryWorkflow: job.queryWorkflow
                  ? {
                      ...job.queryWorkflow,
                      arguments: await decodeOptional(this.codecs, job.queryWorkflow.arguments, this.workflowContext),
                      headers: noopDecodeMap(job.queryWorkflow.headers),
                    }
                  : null,
                doUpdate: job.doUpdate
                  ? {
                      ...job.doUpdate,
                      input: await decodeOptional(this.codecs, job.doUpdate.input, this.workflowContext),
                      headers: noopDecodeMap(job.doUpdate.headers),
                    }
                  : null,
                signalWorkflow: job.signalWorkflow
                  ? {
                      ...job.signalWorkflow,
                      input: await decodeOptional(this.codecs, job.signalWorkflow.input, this.workflowContext),
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
                                    job.resolveActivity.result.completed.result,
                                    resolveActivityContext
                                  ),
                                }
                              : null,
                            failed: job.resolveActivity.result.failed
                              ? {
                                  ...job.resolveActivity.result.failed,
                                  failure: await decodeOptionalFailure(
                                    this.codecs,
                                    job.resolveActivity.result.failed.failure,
                                    resolveActivityContext
                                  ),
                                }
                              : null,
                            cancelled: job.resolveActivity.result.cancelled
                              ? {
                                  ...job.resolveActivity.result.cancelled,
                                  failure: await decodeOptionalFailure(
                                    this.codecs,
                                    job.resolveActivity.result.cancelled.failure,
                                    resolveActivityContext
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
                                    job.resolveChildWorkflowExecution.result.completed.result,
                                    resolveChildWorkflowExecutionContext
                                  ),
                                }
                              : null,
                            failed: job.resolveChildWorkflowExecution.result.failed
                              ? {
                                  ...job.resolveChildWorkflowExecution.result.failed,
                                  failure: await decodeOptionalFailure(
                                    this.codecs,
                                    job.resolveChildWorkflowExecution.result.failed.failure,
                                    resolveChildWorkflowExecutionContext
                                  ),
                                }
                              : null,
                            cancelled: job.resolveChildWorkflowExecution.result.cancelled
                              ? {
                                  ...job.resolveChildWorkflowExecution.result.cancelled,
                                  failure: await decodeOptionalFailure(
                                    this.codecs,
                                    job.resolveChildWorkflowExecution.result.cancelled.failure,
                                    resolveChildWorkflowExecutionContext
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
                              job.resolveChildWorkflowExecutionStart.cancelled.failure,
                              resolveChildWorkflowStartContext
                            ),
                          }
                        : null,
                    }
                  : null,
                resolveNexusOperation: job.resolveNexusOperation
                  ? {
                      ...job.resolveNexusOperation,
                      result: {
                        completed: job.resolveNexusOperation.result?.completed
                          ? await decodeOptionalSingle(
                              this.codecs,
                              job.resolveNexusOperation.result.completed,
                              this.workflowContext
                            )
                          : null,
                        failed: job.resolveNexusOperation.result?.failed
                          ? await decodeOptionalFailure(
                              this.codecs,
                              job.resolveNexusOperation.result.failed,
                              this.workflowContext
                            )
                          : null,
                        cancelled: job.resolveNexusOperation.result?.cancelled
                          ? await decodeOptionalFailure(
                              this.codecs,
                              job.resolveNexusOperation.result.cancelled,
                              this.workflowContext
                            )
                          : null,
                        timedOut: job.resolveNexusOperation.result?.timedOut
                          ? await decodeOptionalFailure(
                              this.codecs,
                              job.resolveNexusOperation.result.timedOut,
                              this.workflowContext
                            )
                          : null,
                      },
                    }
                  : null,
                resolveSignalExternalWorkflow: job.resolveSignalExternalWorkflow
                  ? {
                      ...job.resolveSignalExternalWorkflow,
                      failure: await decodeOptionalFailure(
                        this.codecs,
                        job.resolveSignalExternalWorkflow.failure,
                        resolveSignalContext
                      ),
                    }
                  : null,
                resolveRequestCancelExternalWorkflow: job.resolveRequestCancelExternalWorkflow
                  ? {
                      ...job.resolveRequestCancelExternalWorkflow,
                      failure: await decodeOptionalFailure(
                        this.codecs,
                        job.resolveRequestCancelExternalWorkflow.failure,
                        resolveCancelContext
                      ),
                    }
                  : null,
              };
            })
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
            failure: await encodeOptionalFailure(this.codecs, completion.failed.failure, this.workflowContext),
          }
        : null,
      successful: completion.successful
        ? {
            ...completion.successful,
            commands: completion.successful.commands
              ? await Promise.all(
                  completion.successful.commands.map(async (command) => {
                    let userMetadataContext: SerializationContext = this.workflowContext;

                    const scheduleActivityContext = command.scheduleActivity
                      ? this.activityContext(command.scheduleActivity, false)
                      : undefined;
                    if (command.scheduleActivity?.seq != null && scheduleActivityContext) {
                      this.pendingCompletionContexts.activity.set(
                        command.scheduleActivity.seq,
                        scheduleActivityContext
                      );
                      userMetadataContext = scheduleActivityContext;
                    }

                    const scheduleLocalActivityContext = command.scheduleLocalActivity
                      ? this.activityContext(command.scheduleLocalActivity, true)
                      : undefined;
                    if (command.scheduleLocalActivity?.seq != null && scheduleLocalActivityContext) {
                      this.pendingCompletionContexts.activity.set(
                        command.scheduleLocalActivity.seq,
                        scheduleLocalActivityContext
                      );
                      userMetadataContext = scheduleLocalActivityContext;
                    }

                    const childWorkflowContext = command.startChildWorkflowExecution
                      ? this.childWorkflowContext(command.startChildWorkflowExecution)
                      : undefined;
                    if (command.startChildWorkflowExecution?.seq != null && childWorkflowContext) {
                      this.pendingCompletionContexts.childWorkflowStart.set(
                        command.startChildWorkflowExecution.seq,
                        childWorkflowContext
                      );
                      this.pendingCompletionContexts.childWorkflowComplete.set(
                        command.startChildWorkflowExecution.seq,
                        childWorkflowContext
                      );
                      userMetadataContext = childWorkflowContext;
                    }

                    const signalWorkflowContext = command.signalExternalWorkflowExecution
                      ? this.externalWorkflowContext(command.signalExternalWorkflowExecution)
                      : undefined;
                    if (command.signalExternalWorkflowExecution?.seq != null && signalWorkflowContext) {
                      this.pendingCompletionContexts.signalWorkflow.set(
                        command.signalExternalWorkflowExecution.seq,
                        signalWorkflowContext
                      );
                    }

                    const cancelWorkflowContext = command.requestCancelExternalWorkflowExecution
                      ? this.externalWorkflowContext(command.requestCancelExternalWorkflowExecution)
                      : undefined;
                    if (command.requestCancelExternalWorkflowExecution?.seq != null && cancelWorkflowContext) {
                      this.pendingCompletionContexts.cancelWorkflow.set(
                        command.requestCancelExternalWorkflowExecution.seq,
                        cancelWorkflowContext
                      );
                    }

                    return <Encoded<coresdk.workflow_commands.IWorkflowCommand>>{
                      ...command,
                      scheduleActivity: command.scheduleActivity
                        ? {
                            ...command.scheduleActivity,
                            arguments: await encodeOptional(
                              this.codecs,
                              command.scheduleActivity.arguments,
                              scheduleActivityContext
                            ),
                            headers: noopEncodeMap(command.scheduleActivity.headers),
                          }
                        : undefined,
                      upsertWorkflowSearchAttributes: command.upsertWorkflowSearchAttributes
                        ? {
                            ...command.upsertWorkflowSearchAttributes,
                            searchAttributes: noopEncodeSearchAttrs(
                              command.upsertWorkflowSearchAttributes.searchAttributes
                            ),
                          }
                        : undefined,
                      respondToQuery: command.respondToQuery
                        ? {
                            ...command.respondToQuery,
                            succeeded: {
                              ...command.respondToQuery.succeeded,
                              response: await encodeOptionalSingle(
                                this.codecs,
                                command.respondToQuery.succeeded?.response,
                                this.workflowContext
                              ),
                            },
                            failed: await encodeOptionalFailure(
                              this.codecs,
                              command.respondToQuery.failed,
                              this.workflowContext
                            ),
                          }
                        : undefined,
                      updateResponse: command.updateResponse
                        ? {
                            ...command.updateResponse,
                            rejected: await encodeOptionalFailure(
                              this.codecs,
                              command.updateResponse.rejected,
                              this.workflowContext
                            ),
                            completed: await encodeOptionalSingle(
                              this.codecs,
                              command.updateResponse.completed,
                              this.workflowContext
                            ),
                          }
                        : undefined,
                      completeWorkflowExecution: command.completeWorkflowExecution
                        ? {
                            ...command.completeWorkflowExecution,
                            result: await encodeOptionalSingle(
                              this.codecs,
                              command.completeWorkflowExecution.result,
                              this.workflowContext
                            ),
                          }
                        : undefined,
                      failWorkflowExecution: command.failWorkflowExecution
                        ? {
                            ...command.failWorkflowExecution,
                            failure: await encodeOptionalFailure(
                              this.codecs,
                              command.failWorkflowExecution.failure,
                              this.workflowContext
                            ),
                          }
                        : undefined,
                      continueAsNewWorkflowExecution: command.continueAsNewWorkflowExecution
                        ? {
                            ...command.continueAsNewWorkflowExecution,
                            arguments: await encodeOptional(
                              this.codecs,
                              command.continueAsNewWorkflowExecution.arguments,
                              this.workflowContext
                            ),
                            memo: await encodeMap(
                              this.codecs,
                              command.continueAsNewWorkflowExecution.memo,
                              this.workflowContext
                            ),
                            headers: noopEncodeMap(command.continueAsNewWorkflowExecution.headers),
                            searchAttributes: noopEncodeSearchAttrs(
                              command.continueAsNewWorkflowExecution.searchAttributes
                            ),
                          }
                        : undefined,
                      startChildWorkflowExecution: command.startChildWorkflowExecution
                        ? {
                            ...command.startChildWorkflowExecution,
                            input: await encodeOptional(
                              this.codecs,
                              command.startChildWorkflowExecution.input,
                              childWorkflowContext
                            ),
                            memo: await encodeMap(
                              this.codecs,
                              command.startChildWorkflowExecution.memo,
                              childWorkflowContext
                            ),
                            headers: noopEncodeMap(command.startChildWorkflowExecution.headers),
                            searchAttributes: noopEncodeSearchAttrs(
                              command.startChildWorkflowExecution.searchAttributes
                            ),
                          }
                        : undefined,
                      signalExternalWorkflowExecution: command.signalExternalWorkflowExecution
                        ? {
                            ...command.signalExternalWorkflowExecution,
                            args: await encodeOptional(
                              this.codecs,
                              command.signalExternalWorkflowExecution.args,
                              signalWorkflowContext
                            ),
                            headers: noopEncodeMap(command.signalExternalWorkflowExecution.headers),
                          }
                        : undefined,
                      scheduleLocalActivity: command.scheduleLocalActivity
                        ? {
                            ...command.scheduleLocalActivity,
                            arguments: await encodeOptional(
                              this.codecs,
                              command.scheduleLocalActivity.arguments,
                              scheduleLocalActivityContext
                            ),
                            headers: noopEncodeMap(command.scheduleLocalActivity.headers),
                          }
                        : undefined,
                      scheduleNexusOperation: command.scheduleNexusOperation
                        ? {
                            ...command.scheduleNexusOperation,
                            input: await encodeOptionalSingle(
                              this.codecs,
                              command.scheduleNexusOperation.input,
                              this.workflowContext
                            ),
                          }
                        : undefined,
                      modifyWorkflowProperties: command.modifyWorkflowProperties
                        ? {
                            ...command.modifyWorkflowProperties,
                            upsertedMemo: {
                              ...command.modifyWorkflowProperties.upsertedMemo,
                              fields: await encodeMap(
                                this.codecs,
                                command.modifyWorkflowProperties.upsertedMemo?.fields,
                                this.workflowContext
                              ),
                            },
                          }
                        : undefined,
                      userMetadata: await this.encodeUserMetadata(userMetadataContext, command.userMetadata),
                    };
                  })
                )
              : null,
          }
        : null,
    };

    return coresdk.workflow_completion.WorkflowActivationCompletion.encodeDelimited(encodedCompletion).finish();
  }
}
