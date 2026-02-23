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

interface BaseWorkflowContext extends WorkflowSerializationContext {
  /**
   * Additional run metadata used only to derive ActivitySerializationContext for schedule commands.
   */
  workflowType: string;
  taskQueue: string;
}

interface WorkflowCodecRunState {
  baseContext: BaseWorkflowContext;
  activityContexts: Map<number, ActivitySerializationContext>;
  childWorkflowContexts: Map<number, WorkflowSerializationContext>;
  // signalExternalWorkflowExecution and requestCancelExternalWorkflowExecution use independent seq counters.
  signalExternalWorkflowContexts: Map<number, WorkflowSerializationContext>;
  cancelExternalWorkflowContexts: Map<number, WorkflowSerializationContext>;
}

function getSeq(seq: number | null | undefined): number | undefined {
  return typeof seq === 'number' ? seq : undefined;
}

function getRunId(runId: string | null | undefined): string | undefined {
  return typeof runId === 'string' && runId.length > 0 ? runId : undefined;
}

/**
 * Helper class for decoding Workflow activations and encoding Workflow completions.
 */
export class WorkflowCodecRunner {
  protected readonly runStates = new Map<string, WorkflowCodecRunState>();
  protected readonly codecsByContext = new WeakMap<SerializationContext, PayloadCodec[]>();

  constructor(
    protected readonly codecs: PayloadCodec[],
    protected readonly namespace: string,
    protected readonly taskQueue: string
  ) {}

  /**
   * Forget all codec context state for a workflow run.
   */
  public forgetRun(runId: string): void {
    this.runStates.delete(runId);
  }

  protected codecsForContext(context: SerializationContext | undefined): PayloadCodec[] {
    if (context == null || this.codecs.length === 0) {
      return this.codecs;
    }

    const cached = this.codecsByContext.get(context);
    if (cached != null) {
      return cached;
    }

    let codecs = this.codecs;
    for (let i = 0; i < this.codecs.length; i++) {
      const codec = this.codecs[i]!;
      const nextCodec = withPayloadCodecContext(codec, context);
      if (nextCodec !== codec) {
        if (codecs === this.codecs) {
          codecs = this.codecs.slice();
        }
        codecs[i] = nextCodec;
      }
    }
    this.codecsByContext.set(context, codecs);
    return codecs;
  }

  protected async decodeOptionalWithContext(
    context: SerializationContext | undefined,
    payloads: Payload[] | null | undefined
  ): Promise<Decoded<Payload[]> | null | undefined> {
    return await decodeOptional(this.codecsForContext(context), payloads);
  }

  protected async decodeOptionalSingleWithContext(
    context: SerializationContext | undefined,
    payload: Payload | null | undefined
  ): Promise<Decoded<Payload> | null | undefined> {
    return await decodeOptionalSingle(this.codecsForContext(context), payload);
  }

  protected async decodeOptionalFailureWithContext(
    context: SerializationContext | undefined,
    failure: ProtoFailure | null | undefined
  ): Promise<Decoded<ProtoFailure> | null | undefined> {
    return await decodeOptionalFailure(this.codecsForContext(context), failure);
  }

  protected async decodeOptionalMapWithContext(
    context: SerializationContext | undefined,
    map: Record<string, Payload> | null | undefined
  ): Promise<Record<string, Decoded<Payload>> | null | undefined> {
    return await decodeOptionalMap(this.codecsForContext(context), map);
  }

  protected async encodeOptionalWithContext(
    context: SerializationContext | undefined,
    payloads: Payload[] | null | undefined
  ): Promise<Encoded<Payload[]> | null | undefined> {
    return await encodeOptional(this.codecsForContext(context), payloads);
  }

  protected async encodeOptionalSingleWithContext(
    context: SerializationContext | undefined,
    payload: Payload | null | undefined
  ): Promise<Encoded<Payload> | null | undefined> {
    return await encodeOptionalSingle(this.codecsForContext(context), payload);
  }

  protected async encodeOptionalFailureWithContext(
    context: SerializationContext | undefined,
    failure: ProtoFailure | null | undefined
  ): Promise<Encoded<ProtoFailure> | null | undefined> {
    return await encodeOptionalFailure(this.codecsForContext(context), failure);
  }

  protected async encodeMapWithContext(
    context: SerializationContext | undefined,
    map: Record<string, Payload> | null | undefined
  ): Promise<Record<string, Encoded<Payload>> | null | undefined> {
    return await encodeMap(this.codecsForContext(context), map);
  }

  protected createRunState(
    initializeWorkflow: coresdk.workflow_activation.IInitializeWorkflow
  ): WorkflowCodecRunState | undefined {
    if (typeof initializeWorkflow.workflowId !== 'string') {
      return undefined;
    }
    return {
      baseContext: {
        namespace: this.namespace,
        workflowId: initializeWorkflow.workflowId,
        workflowType: initializeWorkflow.workflowType ?? '',
        taskQueue: this.taskQueue,
      },
      activityContexts: new Map(),
      childWorkflowContexts: new Map(),
      signalExternalWorkflowContexts: new Map(),
      cancelExternalWorkflowContexts: new Map(),
    };
  }

  protected getRunState(runId: string): WorkflowCodecRunState | undefined {
    return this.runStates.get(runId);
  }

  protected getOrCreateRunState(
    runId: string,
    initializeWorkflow: coresdk.workflow_activation.IInitializeWorkflow | undefined
  ): WorkflowCodecRunState | undefined {
    let state = this.runStates.get(runId);
    if (state || initializeWorkflow == null) {
      return state;
    }
    state = this.createRunState(initializeWorkflow);
    if (state != null) {
      this.runStates.set(runId, state);
    }
    return state;
  }

  protected workflowContext(workflowId: string): WorkflowSerializationContext {
    return {
      namespace: this.namespace,
      workflowId,
    };
  }

  protected activityContext(
    baseContext: BaseWorkflowContext,
    activityType: string,
    activityTaskQueue: string,
    isLocal: boolean
  ): ActivitySerializationContext {
    return {
      namespace: baseContext.namespace,
      workflowId: baseContext.workflowId,
      workflowType: baseContext.workflowType,
      activityType,
      activityTaskQueue,
      isLocal,
    };
  }

  /**
   * Run codec.decode on the Payloads in the Activation message.
   */
  public async decodeActivation<T extends coresdk.workflow_activation.IWorkflowActivation>(
    activation: T
  ): Promise<Decoded<T>> {
    const runId = getRunId(activation.runId);
    const initializeWorkflow = activation.jobs?.find((job) => job.initializeWorkflow)?.initializeWorkflow ?? undefined;
    // A run state may be absent on sticky cache misses/restarts. Fall back to context-free decoding in that case.
    const runState = runId ? this.getOrCreateRunState(runId, initializeWorkflow) : undefined;
    const baseContext = runState?.baseContext;

    return coresdk.workflow_activation.WorkflowActivation.fromObject(<
      Decoded<coresdk.workflow_activation.IWorkflowActivation>
    >{
      ...activation,
      jobs: activation.jobs
        ? await Promise.all(
            activation.jobs.map(async (job) => {
              const resolveActivitySeq = getSeq(job.resolveActivity?.seq);
              const resolveActivityContext =
                resolveActivitySeq != null ? runState?.activityContexts.get(resolveActivitySeq) : undefined;

              const resolveChildSeq = getSeq(job.resolveChildWorkflowExecution?.seq);
              const resolveChildContext =
                resolveChildSeq != null ? runState?.childWorkflowContexts.get(resolveChildSeq) : undefined;

              const resolveChildStartSeq = getSeq(job.resolveChildWorkflowExecutionStart?.seq);
              const resolveChildStartContext =
                resolveChildStartSeq != null ? runState?.childWorkflowContexts.get(resolveChildStartSeq) : undefined;

              const resolveSignalExternalSeq = getSeq(job.resolveSignalExternalWorkflow?.seq);
              const resolveSignalExternalContext =
                resolveSignalExternalSeq != null
                  ? runState?.signalExternalWorkflowContexts.get(resolveSignalExternalSeq)
                  : undefined;

              const resolveCancelExternalSeq = getSeq(job.resolveRequestCancelExternalWorkflow?.seq);
              const resolveCancelExternalContext =
                resolveCancelExternalSeq != null
                  ? runState?.cancelExternalWorkflowContexts.get(resolveCancelExternalSeq)
                  : undefined;

              const initializeContext = job.initializeWorkflow?.workflowId
                ? this.workflowContext(job.initializeWorkflow.workflowId)
                : baseContext;

              const decodedJob = {
                ...job,
                initializeWorkflow: job.initializeWorkflow
                  ? {
                      ...job.initializeWorkflow,
                      arguments: await this.decodeOptionalWithContext(initializeContext, job.initializeWorkflow.arguments),
                      headers: noopDecodeMap(job.initializeWorkflow.headers),
                      continuedFailure: await this.decodeOptionalFailureWithContext(
                        initializeContext,
                        job.initializeWorkflow.continuedFailure
                      ),
                      memo: {
                        ...job.initializeWorkflow.memo,
                        fields: await this.decodeOptionalMapWithContext(initializeContext, job.initializeWorkflow.memo?.fields),
                      },
                      lastCompletionResult: {
                        ...job.initializeWorkflow.lastCompletionResult,
                        payloads: await this.decodeOptionalWithContext(
                          initializeContext,
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
                      arguments: await this.decodeOptionalWithContext(baseContext, job.queryWorkflow.arguments),
                      headers: noopDecodeMap(job.queryWorkflow.headers),
                    }
                  : null,
                doUpdate: job.doUpdate
                  ? {
                      ...job.doUpdate,
                      input: await this.decodeOptionalWithContext(baseContext, job.doUpdate.input),
                      headers: noopDecodeMap(job.doUpdate.headers),
                    }
                  : null,
                signalWorkflow: job.signalWorkflow
                  ? {
                      ...job.signalWorkflow,
                      input: await this.decodeOptionalWithContext(baseContext, job.signalWorkflow.input),
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
                                  result: await this.decodeOptionalSingleWithContext(
                                    resolveActivityContext ?? baseContext,
                                    job.resolveActivity.result.completed.result
                                  ),
                                }
                              : null,
                            failed: job.resolveActivity.result.failed
                              ? {
                                  ...job.resolveActivity.result.failed,
                                  failure: await this.decodeOptionalFailureWithContext(
                                    resolveActivityContext ?? baseContext,
                                    job.resolveActivity.result.failed.failure
                                  ),
                                }
                              : null,
                            cancelled: job.resolveActivity.result.cancelled
                              ? {
                                  ...job.resolveActivity.result.cancelled,
                                  failure: await this.decodeOptionalFailureWithContext(
                                    resolveActivityContext ?? baseContext,
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
                                  result: await this.decodeOptionalSingleWithContext(
                                    resolveChildContext ?? baseContext,
                                    job.resolveChildWorkflowExecution.result.completed.result
                                  ),
                                }
                              : null,
                            failed: job.resolveChildWorkflowExecution.result.failed
                              ? {
                                  ...job.resolveChildWorkflowExecution.result.failed,
                                  failure: await this.decodeOptionalFailureWithContext(
                                    resolveChildContext ?? baseContext,
                                    job.resolveChildWorkflowExecution.result.failed.failure
                                  ),
                                }
                              : null,
                            cancelled: job.resolveChildWorkflowExecution.result.cancelled
                              ? {
                                  ...job.resolveChildWorkflowExecution.result.cancelled,
                                  failure: await this.decodeOptionalFailureWithContext(
                                    resolveChildContext ?? baseContext,
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
                            failure: await this.decodeOptionalFailureWithContext(
                              resolveChildStartContext ?? baseContext,
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
                          ? await this.decodeOptionalSingleWithContext(baseContext, job.resolveNexusOperation.result?.completed)
                          : null,
                        failed: job.resolveNexusOperation.result?.failed
                          ? await this.decodeOptionalFailureWithContext(baseContext, job.resolveNexusOperation.result?.failed)
                          : null,
                        cancelled: job.resolveNexusOperation.result?.cancelled
                          ? await this.decodeOptionalFailureWithContext(baseContext, job.resolveNexusOperation.result?.cancelled)
                          : null,
                        timedOut: job.resolveNexusOperation.result?.cancelled
                          ? await this.decodeOptionalFailureWithContext(baseContext, job.resolveNexusOperation.result?.timedOut)
                          : null,
                      },
                    }
                  : null,
                resolveSignalExternalWorkflow: job.resolveSignalExternalWorkflow
                  ? {
                      ...job.resolveSignalExternalWorkflow,
                      failure: await this.decodeOptionalFailureWithContext(
                        resolveSignalExternalContext ?? baseContext,
                        job.resolveSignalExternalWorkflow.failure
                      ),
                    }
                  : null,
                resolveRequestCancelExternalWorkflow: job.resolveRequestCancelExternalWorkflow
                  ? {
                      ...job.resolveRequestCancelExternalWorkflow,
                      failure: await this.decodeOptionalFailureWithContext(
                        resolveCancelExternalContext ?? baseContext,
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
    const runId = getRunId(completion.runId);
    // A run state may be absent if no InitializeWorkflow has been seen for this worker process.
    // Preserve compatibility by encoding without context in that case.
    const runState = runId ? this.getRunState(runId) : undefined;
    const baseContext = runState?.baseContext;

    const encodedCompletion: Encoded<coresdk.workflow_completion.IWorkflowActivationCompletion> = {
      ...completion,
      failed: completion.failed
        ? {
            ...completion.failed,
            failure: await this.encodeOptionalFailureWithContext(baseContext, completion?.failed?.failure),
          }
        : null,
      successful: completion.successful
        ? {
            ...completion.successful,
            commands: completion.successful.commands
              ? await Promise.all(
                  completion.successful.commands.map(
                    async (command) => {
                      const scheduleActivitySeq = getSeq(command.scheduleActivity?.seq);
                      const scheduleActivityContext =
                        runState && command.scheduleActivity
                          ? this.activityContext(
                              runState.baseContext,
                              command.scheduleActivity.activityType ?? '',
                              command.scheduleActivity.taskQueue ?? runState.baseContext.taskQueue,
                              false
                            )
                          : undefined;

                      const scheduleLocalActivitySeq = getSeq(command.scheduleLocalActivity?.seq);
                      const scheduleLocalActivityContext =
                        runState && command.scheduleLocalActivity
                          ? this.activityContext(
                              runState.baseContext,
                              command.scheduleLocalActivity.activityType ?? '',
                              runState.baseContext.taskQueue,
                              true
                            )
                          : undefined;

                      const childWorkflowSeq = getSeq(command.startChildWorkflowExecution?.seq);
                      const childWorkflowId =
                        command.startChildWorkflowExecution?.workflowId ?? runState?.baseContext.workflowId ?? '';
                      const childWorkflowContext = runState ? this.workflowContext(childWorkflowId) : undefined;

                      const signalExternalSeq = getSeq(command.signalExternalWorkflowExecution?.seq);
                      const signalExternalTargetWorkflowId =
                        command.signalExternalWorkflowExecution?.workflowExecution?.workflowId ??
                        command.signalExternalWorkflowExecution?.childWorkflowId ??
                        runState?.baseContext.workflowId ??
                        '';
                      const signalExternalContext = runState
                        ? this.workflowContext(signalExternalTargetWorkflowId)
                        : undefined;

                      const cancelExternalSeq = getSeq(command.requestCancelExternalWorkflowExecution?.seq);
                      const cancelExternalWorkflowId =
                        command.requestCancelExternalWorkflowExecution?.workflowExecution?.workflowId ??
                        runState?.baseContext.workflowId ??
                        '';
                      const cancelExternalContext = runState ? this.workflowContext(cancelExternalWorkflowId) : undefined;

                      // Add seq contexts while encoding commands (easy direction).
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
                              arguments: await this.encodeOptionalWithContext(
                                scheduleActivityContext ?? baseContext,
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
                                response: await this.encodeOptionalSingleWithContext(
                                  baseContext,
                                  command.respondToQuery.succeeded?.response
                                ),
                              },
                              failed: await this.encodeOptionalFailureWithContext(baseContext, command.respondToQuery.failed),
                            }
                          : undefined,
                        updateResponse: command.updateResponse
                          ? {
                              ...command.updateResponse,
                              rejected: await this.encodeOptionalFailureWithContext(
                                baseContext,
                                command.updateResponse.rejected
                              ),
                              completed: await this.encodeOptionalSingleWithContext(
                                baseContext,
                                command.updateResponse.completed
                              ),
                            }
                          : undefined,
                        completeWorkflowExecution: command.completeWorkflowExecution
                          ? {
                              ...command.completeWorkflowExecution,
                              result: await this.encodeOptionalSingleWithContext(
                                baseContext,
                                command.completeWorkflowExecution.result
                              ),
                            }
                          : undefined,
                        failWorkflowExecution: command.failWorkflowExecution
                          ? {
                              ...command.failWorkflowExecution,
                              failure: await this.encodeOptionalFailureWithContext(
                                baseContext,
                                command.failWorkflowExecution.failure
                              ),
                            }
                          : undefined,
                        continueAsNewWorkflowExecution: command.continueAsNewWorkflowExecution
                          ? {
                              ...command.continueAsNewWorkflowExecution,
                              arguments: await this.encodeOptionalWithContext(
                                baseContext,
                                command.continueAsNewWorkflowExecution.arguments
                              ),
                              memo: await this.encodeMapWithContext(baseContext, command.continueAsNewWorkflowExecution.memo),
                              // don't encode headers
                              headers: noopEncodeMap(command.continueAsNewWorkflowExecution.headers),
                              // don't encode searchAttributes
                              searchAttributes: noopEncodeMap(command.continueAsNewWorkflowExecution.searchAttributes),
                            }
                          : undefined,
                        startChildWorkflowExecution: command.startChildWorkflowExecution
                          ? {
                              ...command.startChildWorkflowExecution,
                              input: await this.encodeOptionalWithContext(
                                childWorkflowContext ?? baseContext,
                                command.startChildWorkflowExecution.input
                              ),
                              memo: await this.encodeMapWithContext(
                                childWorkflowContext ?? baseContext,
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
                              args: await this.encodeOptionalWithContext(
                                signalExternalContext ?? baseContext,
                                command.signalExternalWorkflowExecution.args
                              ),
                              headers: noopEncodeMap(command.signalExternalWorkflowExecution.headers),
                            }
                          : undefined,
                        scheduleLocalActivity: command.scheduleLocalActivity
                          ? {
                              ...command.scheduleLocalActivity,
                              arguments: await this.encodeOptionalWithContext(
                                scheduleLocalActivityContext ?? baseContext,
                                command.scheduleLocalActivity.arguments
                              ),
                              // don't encode headers
                              headers: noopEncodeMap(command.scheduleLocalActivity.headers),
                            }
                          : undefined,
                        scheduleNexusOperation: command.scheduleNexusOperation
                          ? {
                              ...command.scheduleNexusOperation,
                              input: await this.encodeOptionalSingleWithContext(baseContext, command.scheduleNexusOperation.input),
                            }
                          : undefined,
                        modifyWorkflowProperties: command.modifyWorkflowProperties
                          ? {
                              ...command.modifyWorkflowProperties,
                              upsertedMemo: {
                                ...command.modifyWorkflowProperties.upsertedMemo,
                                fields: await this.encodeMapWithContext(
                                  baseContext,
                                  command.modifyWorkflowProperties.upsertedMemo?.fields
                                ),
                              },
                            }
                          : undefined,
                        userMetadata:
                          command.userMetadata && (command.userMetadata.summary || command.userMetadata.details)
                            ? {
                                summary: await this.encodeOptionalSingleWithContext(baseContext, command.userMetadata.summary),
                                details: await this.encodeOptionalSingleWithContext(baseContext, command.userMetadata.details),
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
