import {
  ActivitySerializationContext,
  Payload,
  PayloadCodec,
  ProtoFailure,
  SerializationContext,
  WorkflowSerializationContext,
} from '@temporalio/common';
import { withPayloadCodecContext } from '@temporalio/common/lib/converter/serialization-context';
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

interface WorkflowCodecRunState {
  workflowContext: WorkflowSerializationContext;
  workflowType: string;
  activityContexts: Map<number, ActivitySerializationContext>;
  childWorkflowContexts: Map<number, WorkflowSerializationContext>;
  // signalExternalWorkflowExecution and requestCancelExternalWorkflowExecution use independent seq counters.
  signalExternalWorkflowContexts: Map<number, WorkflowSerializationContext>;
  cancelExternalWorkflowContexts: Map<number, WorkflowSerializationContext>;
}

/**
 * Helper class for decoding Workflow activations and encoding Workflow completions.
 */
export class WorkflowCodecRunner {
  protected readonly serializationContextsByRunId = new Map<string, WorkflowCodecRunState>();

  constructor(
    protected readonly codecs: PayloadCodec[],
    protected readonly namespace: string,
    protected readonly taskQueue: string
  ) {}

  /**
   * Forget all codec context state for a workflow run.
   */
  public forgetRun(runId: string): void {
    this.serializationContextsByRunId.delete(runId);
  }

  protected codecsForContext(context: SerializationContext | undefined): PayloadCodec[] {
    if (context == null || this.codecs.length === 0) {
      return this.codecs;
    }
    let codecsChanged = false;
    const maybeBoundCodecs = this.codecs.map((codec) => {
      const maybeContextCodec = withPayloadCodecContext(codec, context);
      if (maybeContextCodec !== codec) {
        codecsChanged = true;
      }
      return maybeContextCodec;
    });
    return codecsChanged ? maybeBoundCodecs : this.codecs;
  }

  protected createRunState(
    initializeWorkflow: coresdk.workflow_activation.IInitializeWorkflow
  ): WorkflowCodecRunState | undefined {
    if (typeof initializeWorkflow.workflowId !== 'string') {
      return undefined;
    }
    return {
      workflowContext: {
        namespace: this.namespace,
        workflowId: initializeWorkflow.workflowId,
      },
      workflowType: initializeWorkflow.workflowType ?? '',
      activityContexts: new Map(),
      childWorkflowContexts: new Map(),
      signalExternalWorkflowContexts: new Map(),
      cancelExternalWorkflowContexts: new Map(),
    };
  }

  protected getOrCreateRunState(
    runId: string,
    initializeWorkflow: coresdk.workflow_activation.IInitializeWorkflow | undefined
  ): WorkflowCodecRunState | undefined {
    let state = this.serializationContextsByRunId.get(runId);
    if (state || initializeWorkflow == null) {
      return state;
    }
    state = this.createRunState(initializeWorkflow);
    if (state != null) {
      this.serializationContextsByRunId.set(runId, state);
    }
    return state;
  }

  /**
   * Run codec.decode on the Payloads in the Activation message.
   */
  public async decodeActivation<T extends coresdk.workflow_activation.IWorkflowActivation>(
    activation: T
  ): Promise<Decoded<T>> {
    const runId = activation.runId ?? undefined;
    const initializeWorkflow = activation.jobs?.find((job) => job.initializeWorkflow)?.initializeWorkflow ?? undefined;
    // A run state may be absent on sticky cache misses/restarts. Fall back to context-free decoding in that case.
    const runState = runId ? this.getOrCreateRunState(runId, initializeWorkflow) : undefined;
    const workflowContext = runState?.workflowContext;

    return coresdk.workflow_activation.WorkflowActivation.fromObject(<
      Decoded<coresdk.workflow_activation.IWorkflowActivation>
    >{
      ...activation,
      jobs: activation.jobs
        ? await Promise.all(
            activation.jobs.map(async (job) => {
              const resolveActivitySeq = job.resolveActivity?.seq ?? undefined;
              const resolveActivityContext =
                resolveActivitySeq != null ? runState?.activityContexts.get(resolveActivitySeq) : undefined;

              const resolveChildSeq = job.resolveChildWorkflowExecution?.seq ?? undefined;
              const resolveChildContext =
                resolveChildSeq != null ? runState?.childWorkflowContexts.get(resolveChildSeq) : undefined;

              const resolveChildStartSeq = job.resolveChildWorkflowExecutionStart?.seq ?? undefined;
              const resolveChildStartContext =
                resolveChildStartSeq != null ? runState?.childWorkflowContexts.get(resolveChildStartSeq) : undefined;

              const resolveSignalExternalSeq = job.resolveSignalExternalWorkflow?.seq ?? undefined;
              const resolveSignalExternalContext =
                resolveSignalExternalSeq != null
                  ? runState?.signalExternalWorkflowContexts.get(resolveSignalExternalSeq)
                  : undefined;

              const resolveCancelExternalSeq = job.resolveRequestCancelExternalWorkflow?.seq ?? undefined;
              const resolveCancelExternalContext =
                resolveCancelExternalSeq != null
                  ? runState?.cancelExternalWorkflowContexts.get(resolveCancelExternalSeq)
                  : undefined;

              const initializeContext = job.initializeWorkflow?.workflowId
                ? { namespace: this.namespace, workflowId: job.initializeWorkflow.workflowId }
                : workflowContext;

              const decodedJob = {
                ...job,
                initializeWorkflow: job.initializeWorkflow
                  ? {
                      ...job.initializeWorkflow,
                      arguments: await decodeOptional(this.codecsForContext(initializeContext), job.initializeWorkflow.arguments),
                      headers: noopDecodeMap(job.initializeWorkflow.headers),
                      continuedFailure: await decodeOptionalFailure(this.codecsForContext(initializeContext), job.initializeWorkflow.continuedFailure),
                      memo: {
                        ...job.initializeWorkflow.memo,
                        fields: await decodeOptionalMap(this.codecsForContext(initializeContext), job.initializeWorkflow.memo?.fields),
                      },
                      lastCompletionResult: {
                        ...job.initializeWorkflow.lastCompletionResult,
                        payloads: await decodeOptional(this.codecsForContext(initializeContext), job.initializeWorkflow.lastCompletionResult?.payloads),
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
                      arguments: await decodeOptional(this.codecsForContext(workflowContext), job.queryWorkflow.arguments),
                      headers: noopDecodeMap(job.queryWorkflow.headers),
                    }
                  : null,
                doUpdate: job.doUpdate
                  ? {
                      ...job.doUpdate,
                      input: await decodeOptional(this.codecsForContext(workflowContext), job.doUpdate.input),
                      headers: noopDecodeMap(job.doUpdate.headers),
                    }
                  : null,
                signalWorkflow: job.signalWorkflow
                  ? {
                      ...job.signalWorkflow,
                      input: await decodeOptional(this.codecsForContext(workflowContext), job.signalWorkflow.input),
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
                                  result: await decodeOptionalSingle(this.codecsForContext(resolveActivityContext),
                                    job.resolveActivity.result.completed.result
                                  ),
                                }
                              : null,
                            failed: job.resolveActivity.result.failed
                              ? {
                                  ...job.resolveActivity.result.failed,
                                  failure: await decodeOptionalFailure(this.codecsForContext(resolveActivityContext),
                                    job.resolveActivity.result.failed.failure
                                  ),
                                }
                              : null,
                            cancelled: job.resolveActivity.result.cancelled
                              ? {
                                  ...job.resolveActivity.result.cancelled,
                                  failure: await decodeOptionalFailure(this.codecsForContext(resolveActivityContext),
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
                                  result: await decodeOptionalSingle(this.codecsForContext(resolveChildContext),
                                    job.resolveChildWorkflowExecution.result.completed.result
                                  ),
                                }
                              : null,
                            failed: job.resolveChildWorkflowExecution.result.failed
                              ? {
                                  ...job.resolveChildWorkflowExecution.result.failed,
                                  failure: await decodeOptionalFailure(this.codecsForContext(resolveChildContext),
                                    job.resolveChildWorkflowExecution.result.failed.failure
                                  ),
                                }
                              : null,
                            cancelled: job.resolveChildWorkflowExecution.result.cancelled
                              ? {
                                  ...job.resolveChildWorkflowExecution.result.cancelled,
                                  failure: await decodeOptionalFailure(this.codecsForContext(resolveChildContext),
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
                            failure: await decodeOptionalFailure(this.codecsForContext(resolveChildStartContext),
                              job.resolveChildWorkflowExecutionStart.cancelled.failure
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
                          ? await decodeOptionalSingle(this.codecsForContext(workflowContext),
                              job.resolveNexusOperation.result?.completed
                            )
                          : null,
                        failed: job.resolveNexusOperation.result?.failed
                          ? await decodeOptionalFailure(this.codecsForContext(workflowContext),
                              job.resolveNexusOperation.result?.failed
                            )
                          : null,
                        cancelled: job.resolveNexusOperation.result?.cancelled
                          ? await decodeOptionalFailure(this.codecsForContext(workflowContext),
                              job.resolveNexusOperation.result?.cancelled
                            )
                          : null,
                        timedOut: job.resolveNexusOperation.result?.cancelled
                          ? await decodeOptionalFailure(this.codecsForContext(workflowContext),
                              job.resolveNexusOperation.result?.timedOut
                            )
                          : null,
                      },
                    }
                  : null,
                resolveSignalExternalWorkflow: job.resolveSignalExternalWorkflow
                  ? {
                      ...job.resolveSignalExternalWorkflow,
                      failure: await decodeOptionalFailure(this.codecsForContext(resolveSignalExternalContext),
                        job.resolveSignalExternalWorkflow.failure
                      ),
                    }
                  : null,
                resolveRequestCancelExternalWorkflow: job.resolveRequestCancelExternalWorkflow
                  ? {
                      ...job.resolveRequestCancelExternalWorkflow,
                      failure: await decodeOptionalFailure(this.codecsForContext(resolveCancelExternalContext),
                        job.resolveRequestCancelExternalWorkflow.failure
                      ),
                    }
                  : null,
              };

              // Consume and remove seq contexts on resolve jobs.
              if (resolveActivitySeq != null) {
                runState?.activityContexts.delete(resolveActivitySeq);
              }

              if (resolveChildSeq != null) {
                runState?.childWorkflowContexts.delete(resolveChildSeq);
              }

              if (resolveChildStartSeq != null) {
                const start = job.resolveChildWorkflowExecutionStart;
                if (start?.failed || start?.cancelled) {
                  runState?.childWorkflowContexts.delete(resolveChildStartSeq);
                }
              }

              if (resolveSignalExternalSeq != null) {
                runState?.signalExternalWorkflowContexts.delete(resolveSignalExternalSeq);
              }

              if (resolveCancelExternalSeq != null) {
                runState?.cancelExternalWorkflowContexts.delete(resolveCancelExternalSeq);
              }

              return decodedJob;
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
    const runId = completion.runId ?? undefined;
    // A run state may be absent if no InitializeWorkflow has been seen for this worker process.
    // Preserve compatibility by encoding without context in that case.
    const runState = runId ? this.serializationContextsByRunId.get(runId) : undefined;
    const workflowContext = runState?.workflowContext;

    const encodedCompletion: Encoded<coresdk.workflow_completion.IWorkflowActivationCompletion> = {
      ...completion,
      failed: completion.failed
        ? {
            ...completion.failed,
            failure: await encodeOptionalFailure(this.codecsForContext(workflowContext), completion?.failed?.failure),
          }
        : null,
      successful: completion.successful
        ? {
            ...completion.successful,
            commands: completion.successful.commands
              ? await Promise.all(
                  completion.successful.commands.map(
                    async (command) => {
                      const scheduleActivitySeq = command.scheduleActivity?.seq ?? undefined;
                      const scheduleActivityContext =
                        runState && command.scheduleActivity
                          ? {
                              namespace: runState.workflowContext.namespace,
                              workflowId: runState.workflowContext.workflowId,
                              workflowType: runState.workflowType,
                              activityType: command.scheduleActivity.activityType ?? '',
                              activityTaskQueue: command.scheduleActivity.taskQueue ?? this.taskQueue,
                              isLocal: false,
                            }
                          : undefined;

                      const scheduleLocalActivitySeq = command.scheduleLocalActivity?.seq ?? undefined;
                      const scheduleLocalActivityContext =
                        runState && command.scheduleLocalActivity
                          ? {
                              namespace: runState.workflowContext.namespace,
                              workflowId: runState.workflowContext.workflowId,
                              workflowType: runState.workflowType,
                              activityType: command.scheduleLocalActivity.activityType ?? '',
                              activityTaskQueue: this.taskQueue,
                              isLocal: true,
                            }
                          : undefined;

                      const childWorkflowSeq = command.startChildWorkflowExecution?.seq ?? undefined;
                      const childWorkflowId =
                        command.startChildWorkflowExecution?.workflowId ?? runState?.workflowContext.workflowId ?? '';
                      const childWorkflowContext = runState ? { namespace: this.namespace, workflowId: childWorkflowId } : undefined;

                      const signalExternalSeq = command.signalExternalWorkflowExecution?.seq ?? undefined;
                      const signalExternalTargetWorkflowId =
                        command.signalExternalWorkflowExecution?.workflowExecution?.workflowId ??
                        command.signalExternalWorkflowExecution?.childWorkflowId ??
                        runState?.workflowContext.workflowId ??
                        '';
                      const signalExternalContext = runState
                        ? { namespace: this.namespace, workflowId: signalExternalTargetWorkflowId }
                        : undefined;

                      const cancelExternalSeq = command.requestCancelExternalWorkflowExecution?.seq ?? undefined;
                      const cancelExternalWorkflowId =
                        command.requestCancelExternalWorkflowExecution?.workflowExecution?.workflowId ??
                        runState?.workflowContext.workflowId ??
                        '';
                      const cancelExternalContext = runState ? { namespace: this.namespace, workflowId: cancelExternalWorkflowId } : undefined;

                      // Add seq contexts while encoding commands.
                      if (scheduleActivitySeq != null && scheduleActivityContext) {
                        runState?.activityContexts.set(scheduleActivitySeq, scheduleActivityContext);
                      }
                      if (scheduleLocalActivitySeq != null && scheduleLocalActivityContext) {
                        runState?.activityContexts.set(scheduleLocalActivitySeq, scheduleLocalActivityContext);
                      }
                      if (childWorkflowSeq != null && childWorkflowContext) {
                        runState?.childWorkflowContexts.set(childWorkflowSeq, childWorkflowContext);
                      }
                      if (signalExternalSeq != null && signalExternalContext) {
                        runState?.signalExternalWorkflowContexts.set(signalExternalSeq, signalExternalContext);
                      }
                      if (cancelExternalSeq != null && cancelExternalContext) {
                        runState?.cancelExternalWorkflowContexts.set(cancelExternalSeq, cancelExternalContext);
                      }

                      return <Encoded<coresdk.workflow_commands.IWorkflowCommand>>{
                        ...command,
                        scheduleActivity: command.scheduleActivity
                          ? {
                              ...command.scheduleActivity,
                              arguments: await encodeOptional(this.codecsForContext(scheduleActivityContext),
                                command.scheduleActivity?.arguments
                              ),
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
                                response: await encodeOptionalSingle(this.codecsForContext(workflowContext),
                                  command.respondToQuery.succeeded?.response
                                ),
                              },
                              failed: await encodeOptionalFailure(this.codecsForContext(workflowContext),
                                command.respondToQuery.failed
                              ),
                            }
                          : undefined,
                        updateResponse: command.updateResponse
                          ? {
                              ...command.updateResponse,
                              rejected: await encodeOptionalFailure(this.codecsForContext(
                                workflowContext),
                                command.updateResponse.rejected
                              ),
                              completed: await encodeOptionalSingle(this.codecsForContext(
                                workflowContext),
                                command.updateResponse.completed
                              ),
                            }
                          : undefined,
                        completeWorkflowExecution: command.completeWorkflowExecution
                          ? {
                              ...command.completeWorkflowExecution,
                              result: await encodeOptionalSingle(this.codecsForContext(
                                workflowContext),
                                command.completeWorkflowExecution.result
                              ),
                            }
                          : undefined,
                        failWorkflowExecution: command.failWorkflowExecution
                          ? {
                              ...command.failWorkflowExecution,
                              failure: await encodeOptionalFailure(this.codecsForContext(
                                workflowContext),
                                command.failWorkflowExecution.failure
                              ),
                            }
                          : undefined,
                        continueAsNewWorkflowExecution: command.continueAsNewWorkflowExecution
                          ? {
                              ...command.continueAsNewWorkflowExecution,
                              arguments: await encodeOptional(this.codecsForContext(
                                workflowContext),
                                command.continueAsNewWorkflowExecution.arguments
                              ),
                              memo: await encodeMap(this.codecsForContext(
                                workflowContext),
                                command.continueAsNewWorkflowExecution.memo
                              ),
                              // don't encode headers
                              headers: noopEncodeMap(command.continueAsNewWorkflowExecution.headers),
                              // don't encode searchAttributes
                              searchAttributes: noopEncodeMap(command.continueAsNewWorkflowExecution.searchAttributes),
                            }
                          : undefined,
                        startChildWorkflowExecution: command.startChildWorkflowExecution
                          ? {
                              ...command.startChildWorkflowExecution,
                              input: await encodeOptional(this.codecsForContext(
                                childWorkflowContext),
                                command.startChildWorkflowExecution.input
                              ),
                              memo: await encodeMap(this.codecsForContext(
                                childWorkflowContext),
                                command.startChildWorkflowExecution.memo
                              ),
                              // don't encode headers
                              headers: noopEncodeMap(command.startChildWorkflowExecution.headers),
                              // don't encode searchAttributes
                              searchAttributes: noopEncodeMap(command.startChildWorkflowExecution.searchAttributes),
                            }
                          : undefined,
                        signalExternalWorkflowExecution: command.signalExternalWorkflowExecution
                          ? {
                              ...command.signalExternalWorkflowExecution,
                              args: await encodeOptional(this.codecsForContext(
                                signalExternalContext),
                                command.signalExternalWorkflowExecution.args
                              ),
                              headers: noopEncodeMap(command.signalExternalWorkflowExecution.headers),
                            }
                          : undefined,
                        scheduleLocalActivity: command.scheduleLocalActivity
                          ? {
                              ...command.scheduleLocalActivity,
                              arguments: await encodeOptional(this.codecsForContext(
                                scheduleLocalActivityContext),
                                command.scheduleLocalActivity.arguments
                              ),
                              // don't encode headers
                              headers: noopEncodeMap(command.scheduleLocalActivity.headers),
                            }
                          : undefined,
                        scheduleNexusOperation: command.scheduleNexusOperation
                          ? {
                              ...command.scheduleNexusOperation,
                              input: await encodeOptionalSingle(this.codecsForContext(
                                workflowContext),
                                command.scheduleNexusOperation.input
                              ),
                            }
                          : undefined,
                        modifyWorkflowProperties: command.modifyWorkflowProperties
                          ? {
                              ...command.modifyWorkflowProperties,
                              upsertedMemo: {
                                ...command.modifyWorkflowProperties.upsertedMemo,
                                fields: await encodeMap(this.codecsForContext(
                                  workflowContext),
                                  command.modifyWorkflowProperties.upsertedMemo?.fields
                                ),
                              },
                            }
                          : undefined,
                        userMetadata:
                          command.userMetadata && (command.userMetadata.summary || command.userMetadata.details)
                            ? {
                                summary: await encodeOptionalSingle(this.codecsForContext(
                                  workflowContext),
                                  command.userMetadata.summary
                                ),
                                details: await encodeOptionalSingle(this.codecsForContext(
                                  workflowContext),
                                  command.userMetadata.details
                                ),
                              }
                            : undefined,
                      };
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
