import type { ApplyPatchOperation, ApplyPatchResult, Editor, EditorInvocationContext, ToolOutputImage } from '@openai/agents-core';
import type {
  ExecCommandArgs,
  ExposedPortEndpoint,
  ListDirectoryArgs,
  Manifest,
  MaterializeEntryArgs,
  ReadFileArgs,
  SandboxArchiveLimits,
  SandboxDirectoryEntry,
  SandboxExecResult,
  SandboxSession,
  SandboxSessionLifecycleOptions,
  ViewImageArgs,
  WorkspaceArchiveData,
  WorkspaceArchiveOptions,
  WriteStdinArgs,
} from '@openai/agents-core/sandbox';
import { recordExposedPortEndpoint } from '@openai/agents-core/sandbox';
import type { ActivityOptions } from '@temporalio/common';
import { scheduleActivity } from '@temporalio/workflow';
import {
  SANDBOX_EDITOR_CREATE_FILE_SUFFIX,
  SANDBOX_EDITOR_DELETE_FILE_SUFFIX,
  SANDBOX_EDITOR_UPDATE_FILE_SUFFIX,
  SANDBOX_SESSION_APPLY_MANIFEST_SUFFIX,
  SANDBOX_SESSION_DELETE_SUFFIX,
  SANDBOX_SESSION_EXEC_COMMAND_SUFFIX,
  SANDBOX_SESSION_EXEC_SUFFIX,
  SANDBOX_SESSION_HYDRATE_WORKSPACE_SUFFIX,
  SANDBOX_SESSION_LIST_DIR_SUFFIX,
  SANDBOX_SESSION_MATERIALIZE_ENTRY_SUFFIX,
  SANDBOX_SESSION_PATH_EXISTS_SUFFIX,
  SANDBOX_SESSION_PERSIST_WORKSPACE_SUFFIX,
  SANDBOX_SESSION_READ_FILE_SUFFIX,
  SANDBOX_SESSION_RESOLVE_EXPOSED_PORT_SUFFIX,
  SANDBOX_SESSION_RUNNING_SUFFIX,
  SANDBOX_SESSION_SHUTDOWN_SUFFIX,
  SANDBOX_SESSION_START_SUFFIX,
  SANDBOX_SESSION_STOP_SUFFIX,
  SANDBOX_SESSION_VIEW_IMAGE_SUFFIX,
  SANDBOX_SESSION_WRITE_STDIN_SUFFIX,
  decodeToolOutputImage,
  encodeEntry,
  encodeManifest,
  serializeSessionEnvelope,
  type SerializedSandboxSessionState,
  type SerializedToolOutputImage,
  type TemporalSandboxSessionState,
} from '../common/sandbox-activity-types';

/**
 * Workflow-side handle for a sandbox session. Holds only serializable state;
 * every real sandbox operation is dispatched as an Activity to the
 * `SandboxClientProvider` registered under the same name on the Worker.
 *
 * `registerPreStopHook` is intentionally not implemented, so the SDK installs
 * its managed pre-stop-hook fallback (registerSandboxPreStopHook) instead.
 */
export class TemporalSandboxSession implements SandboxSession<TemporalSandboxSessionState> {
  state: TemporalSandboxSessionState;
  private readonly _name: string;
  private readonly _config: ActivityOptions;
  private readonly _supportsPty: boolean;
  private _archiveLimits: SandboxArchiveLimits | null | undefined;

  constructor(name: string, config: ActivityOptions, state: TemporalSandboxSessionState, supportsPty: boolean) {
    this._name = name;
    this._config = config;
    this.state = state;
    this._supportsPty = supportsPty;
  }

  private stateInput(): SerializedSandboxSessionState {
    return serializeSessionEnvelope(this.state.sessionId, this.state, this.state.providerState);
  }

  private dispatch<T>(suffix: string, input: Record<string, unknown>, extraArgs: unknown[] = []): Promise<T> {
    return scheduleActivity<T>(`${this._name}${suffix}`, [{ state: this.stateInput(), ...input }, ...extraArgs], this._config);
  }

  async start(options?: SandboxSessionLifecycleOptions): Promise<void> {
    await this.dispatch(SANDBOX_SESSION_START_SUFFIX, { options });
  }

  async running(): Promise<boolean> {
    return this.dispatch(SANDBOX_SESSION_RUNNING_SUFFIX, {});
  }

  async stop(options?: SandboxSessionLifecycleOptions): Promise<void> {
    await this.dispatch(SANDBOX_SESSION_STOP_SUFFIX, { options });
  }

  async shutdown(options?: SandboxSessionLifecycleOptions): Promise<void> {
    await this.dispatch(SANDBOX_SESSION_SHUTDOWN_SUFFIX, { options });
  }

  async delete(options?: SandboxSessionLifecycleOptions): Promise<void> {
    await this.dispatch(SANDBOX_SESSION_DELETE_SUFFIX, { options });
  }

  createEditor(runAs?: string): Editor {
    return new TemporalEditor(this._name, this._config, () => this.stateInput(), runAs);
  }

  async exec(args: ExecCommandArgs): Promise<SandboxExecResult> {
    return this.dispatch(SANDBOX_SESSION_EXEC_SUFFIX, { args });
  }

  async execCommand(args: ExecCommandArgs): Promise<string> {
    return this.dispatch(SANDBOX_SESSION_EXEC_COMMAND_SUFFIX, { args });
  }

  async writeStdin(args: WriteStdinArgs): Promise<string> {
    return this.dispatch(SANDBOX_SESSION_WRITE_STDIN_SUFFIX, { args });
  }

  async viewImage(args: ViewImageArgs): Promise<ToolOutputImage> {
    const serialized = await this.dispatch<SerializedToolOutputImage>(SANDBOX_SESSION_VIEW_IMAGE_SUFFIX, { args });
    return decodeToolOutputImage(serialized);
  }

  async readFile(args: ReadFileArgs): Promise<string | Uint8Array> {
    return this.dispatch(SANDBOX_SESSION_READ_FILE_SUFFIX, { args });
  }

  async listDir(args: ListDirectoryArgs): Promise<SandboxDirectoryEntry[]> {
    return this.dispatch(SANDBOX_SESSION_LIST_DIR_SUFFIX, { args });
  }

  async pathExists(path: string, runAs?: string): Promise<boolean> {
    return this.dispatch(SANDBOX_SESSION_PATH_EXISTS_SUFFIX, { path, runAs });
  }

  async materializeEntry(args: MaterializeEntryArgs): Promise<void> {
    await this.dispatch(SANDBOX_SESSION_MATERIALIZE_ENTRY_SUFFIX, {
      path: args.path,
      entry: encodeEntry(args.entry),
      runAs: args.runAs,
    });
  }

  async applyManifest(manifest: Manifest, runAs?: string): Promise<void> {
    await this.dispatch(SANDBOX_SESSION_APPLY_MANIFEST_SUFFIX, { manifest: encodeManifest(manifest), runAs });
  }

  async persistWorkspace(): Promise<Uint8Array> {
    return this.dispatch(SANDBOX_SESSION_PERSIST_WORKSPACE_SUFFIX, { archiveLimits: this._archiveLimits });
  }

  async hydrateWorkspace(data: WorkspaceArchiveData, options?: WorkspaceArchiveOptions): Promise<void> {
    const payload = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    await this.dispatch(
      SANDBOX_SESSION_HYDRATE_WORKSPACE_SUFFIX,
      { archiveLimits: options?.archiveLimits ?? this._archiveLimits },
      [payload]
    );
  }

  setArchiveLimits(limits?: SandboxArchiveLimits | null): void {
    this._archiveLimits = limits;
  }

  async resolveExposedPort(port: number): Promise<ExposedPortEndpoint> {
    const endpoint = await this.dispatch<ExposedPortEndpoint>(SANDBOX_SESSION_RESOLVE_EXPOSED_PORT_SUFFIX, { port });
    recordExposedPortEndpoint(this.state, endpoint, port);
    return endpoint;
  }

  supportsPty(): boolean {
    return this._supportsPty;
  }
}

class TemporalEditor implements Editor {
  constructor(
    private readonly name: string,
    private readonly config: ActivityOptions,
    private readonly stateInput: () => SerializedSandboxSessionState,
    private readonly runAs?: string
  ) {}

  private apply(suffix: string, operation: ApplyPatchOperation): Promise<ApplyPatchResult | void> {
    return scheduleActivity<ApplyPatchResult | undefined>(
      `${this.name}${suffix}`,
      [{ state: this.stateInput(), operation, runAs: this.runAs }],
      this.config
    );
  }

  async createFile(
    operation: Extract<ApplyPatchOperation, { type: 'create_file' }>,
    _context?: EditorInvocationContext
  ): Promise<ApplyPatchResult | void> {
    return this.apply(SANDBOX_EDITOR_CREATE_FILE_SUFFIX, operation);
  }

  async updateFile(
    operation: Extract<ApplyPatchOperation, { type: 'update_file' }>,
    _context?: EditorInvocationContext
  ): Promise<ApplyPatchResult | void> {
    return this.apply(SANDBOX_EDITOR_UPDATE_FILE_SUFFIX, operation);
  }

  async deleteFile(
    operation: Extract<ApplyPatchOperation, { type: 'delete_file' }>,
    _context?: EditorInvocationContext
  ): Promise<ApplyPatchResult | void> {
    return this.apply(SANDBOX_EDITOR_DELETE_FILE_SUFFIX, operation);
  }
}
