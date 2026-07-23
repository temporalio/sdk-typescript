import type { ToolOutputImage } from '@openai/agents-core';
import {
  Manifest,
  type ExecCommandArgs,
  type ListDirectoryArgs,
  type MaterializeEntryArgs,
  type ReadFileArgs,
  type SandboxArchiveLimits,
  type SandboxClient,
  type SandboxClientCreateArgs,
  type SandboxDirectoryEntry,
  type SandboxExecResult,
  type SandboxSession,
  type SandboxSessionState,
  type ViewImageArgs,
  type WriteStdinArgs,
} from '@openai/agents-core/sandbox';
import { deserializeManifest, mergeManifestDelta, mergeManifestEntryDelta } from '@openai/agents-core/sandbox/internal';

export class FakeSandboxSession implements SandboxSession {
  state: SandboxSessionState;
  execCalls: ExecCommandArgs[] = [];
  readFileCalls: ReadFileArgs[] = [];
  materializedEntries: MaterializeEntryArgs[] = [];
  appliedManifests: Manifest[] = [];
  hydrateCalls: Array<{ data: string | ArrayBuffer | Uint8Array; archiveLimits?: SandboxArchiveLimits | null }> = [];
  editorOperations: string[] = [];
  archiveLimits: SandboxArchiveLimits | null | undefined;
  startCalls = 0;
  stopCalls = 0;
  shutdownCalls = 0;
  deleteCalls = 0;
  persistCalls = 0;

  constructor(manifest?: Manifest) {
    this.state = {
      manifest: manifest ?? new Manifest(),
      workspaceReady: true,
      workspacePath: '/tmp/fake-workspace',
    };
  }

  async start(): Promise<void> {
    this.startCalls += 1;
  }

  async running(): Promise<boolean> {
    return this.startCalls > 0;
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }

  async shutdown(): Promise<void> {
    this.shutdownCalls += 1;
  }

  async delete(): Promise<void> {
    this.deleteCalls += 1;
  }

  createEditor(): {
    createFile: (op: any) => Promise<{ status: 'completed'; output: string }>;
    updateFile: (op: any) => Promise<{ status: 'completed'; output: string }>;
    deleteFile: (op: any) => Promise<{ status: 'completed'; output: string }>;
  } {
    const record = (kind: string) => async (op: { path: string }) => {
      this.editorOperations.push(`${kind}:${op.path}`);
      return { status: 'completed' as const, output: kind };
    };
    return { createFile: record('create'), updateFile: record('update'), deleteFile: record('delete') };
  }

  async exec(args: ExecCommandArgs): Promise<SandboxExecResult> {
    this.execCalls.push(args);
    return { output: 'ok', stdout: 'ok', stderr: '', wallTimeSeconds: 0.1, exitCode: 0 };
  }

  async execCommand(args: ExecCommandArgs): Promise<string> {
    this.execCalls.push(args);
    return `ran:${args.cmd}`;
  }

  async writeStdin(args: WriteStdinArgs): Promise<string> {
    return `stdin:${args.chars ?? ''}`;
  }

  async viewImage(_args: ViewImageArgs): Promise<ToolOutputImage> {
    return { type: 'image', image: { data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mediaType: 'image/png' } };
  }

  async readFile(args: ReadFileArgs): Promise<Uint8Array> {
    this.readFileCalls.push(args);
    return new TextEncoder().encode('file-content');
  }

  async listDir(_args: ListDirectoryArgs): Promise<SandboxDirectoryEntry[]> {
    return [{ name: 'file.txt', path: '/workspace/file.txt', type: 'file' }];
  }

  async pathExists(_path: string): Promise<boolean> {
    return true;
  }

  async materializeEntry(args: MaterializeEntryArgs): Promise<void> {
    this.materializedEntries.push(args);
    this.state.manifest = mergeManifestEntryDelta(this.state.manifest, args.path, args.entry);
  }

  async applyManifest(manifest: Manifest): Promise<void> {
    this.appliedManifests.push(manifest);
    this.state.manifest = mergeManifestDelta(this.state.manifest, manifest);
  }

  async persistWorkspace(): Promise<Uint8Array> {
    this.persistCalls += 1;
    return new Uint8Array([10, 20, 30]);
  }

  async hydrateWorkspace(
    data: string | ArrayBuffer | Uint8Array,
    options?: { archiveLimits?: SandboxArchiveLimits | null }
  ): Promise<void> {
    this.hydrateCalls.push({ data, archiveLimits: options?.archiveLimits });
  }

  setArchiveLimits(limits?: SandboxArchiveLimits | null): void {
    this.archiveLimits = limits;
  }

  supportsPty(): boolean {
    return false;
  }
}

export class FakeSandboxClient implements SandboxClient {
  readonly backendId = 'fake';
  session: FakeSandboxSession;
  createCalls: SandboxClientCreateArgs[] = [];
  resumeCalls = 0;
  deleteCalls = 0;

  constructor(session?: FakeSandboxSession) {
    this.session = session ?? new FakeSandboxSession();
  }

  async create(args?: SandboxClientCreateArgs | Manifest): Promise<SandboxSession> {
    const createArgs = args instanceof Manifest ? { manifest: args } : args ?? {};
    this.createCalls.push(createArgs);
    if (createArgs.manifest instanceof Manifest) {
      this.session.state.manifest = createArgs.manifest;
      // create resolves the manifest's environment, ephemeral values included.
      this.session.state.environment = Object.fromEntries(
        Object.entries(createArgs.manifest.environment).map(([key, env]) => [key, env.value])
      );
    }
    return this.session;
  }

  async resume(state: SandboxSessionState): Promise<SandboxSession> {
    this.resumeCalls += 1;
    this.session.state = state;
    return this.session;
  }

  async delete(_state: SandboxSessionState): Promise<void> {
    this.deleteCalls += 1;
  }

  async serializeSessionState(state: SandboxSessionState): Promise<Record<string, unknown>> {
    // Persist non-ephemeral env only.
    const environment = Object.fromEntries(
      Object.entries(state.environment ?? {}).filter(([key]) => !state.manifest.environment[key]?.ephemeral)
    );
    return Object.keys(environment).length > 0
      ? { workspacePath: state.workspacePath, environment }
      : { workspacePath: state.workspacePath };
  }

  async deserializeSessionState(state: Record<string, unknown>): Promise<SandboxSessionState> {
    // Env comes from the persisted (stripped) state — never re-resolved from the manifest.
    return {
      ...state,
      manifest: deserializeManifest(state.manifest as Record<string, unknown>),
    } as SandboxSessionState;
  }
}
