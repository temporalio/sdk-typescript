import { Agent, type FunctionTool, type RunContext, type Tool } from '@openai/agents-core';
import {
  Capability,
  Manifest,
  SandboxAgent,
  isEnvValueReference,
  type SandboxSessionLike,
} from '@openai/agents-core/sandbox';
import { TemporalOpenAIRunner, workerEnvValue, temporalSandboxClient } from '../../workflow';

class TestSandboxCapability extends Capability {
  readonly type = 'test_sandbox';

  private session(): SandboxSessionLike {
    if (!this._session) throw new Error('test_sandbox capability is not bound to a session');
    return this._session;
  }

  override tools(): Tool<any>[] {
    const makeTool = (
      name: string,
      properties: Record<string, unknown>,
      required: string[],
      execute: (args: any) => Promise<string>
    ): FunctionTool =>
      ({
        type: 'function',
        name,
        description: name,
        parameters: { type: 'object', properties, required, additionalProperties: false } as any,
        strict: true,
        invoke: async (_ctx: RunContext<any>, input: string): Promise<string> => execute(JSON.parse(input)),
        needsApproval: async () => false,
        isEnabled: async () => true,
      }) as FunctionTool;

    return [
      makeTool('run_command', { cmd: { type: 'string' } }, ['cmd'], async ({ cmd }) => {
        return this.session().execCommand!({ cmd });
      }),
      makeTool('read_file', { path: { type: 'string' } }, ['path'], async ({ path }) => {
        const data = await this.session().readFile!({ path });
        return typeof data === 'string' ? data : new TextDecoder().decode(data);
      }),
      makeTool(
        'write_file',
        { path: { type: 'string' }, diff: { type: 'string' } },
        ['path', 'diff'],
        async ({ path, diff }) => {
          const editor = this.session().createEditor!();
          const result = await editor.createFile({ type: 'create_file', path, diff });
          return result?.output ?? 'ok';
        }
      ),
    ];
  }
}

export async function sandboxAgentWorkflow(): Promise<string> {
  const agent = new SandboxAgent({
    name: 'sandbox-e2e',
    model: 'gpt-4o-mini',
    capabilities: [new TestSandboxCapability()],
    defaultManifest: new Manifest({
      entries: { 'data.bin': { type: 'file', content: new Uint8Array([0, 1, 2, 253, 254, 255]) } },
    }),
  });
  const runner = new TemporalOpenAIRunner();
  const result = await runner.run(agent, 'run a command', {
    runConfig: { sandbox: { client: temporalSandboxClient('fake') } },
  });
  return `${result.finalOutput}`;
}

/** A sandbox tool that interrupts for approval, so the run preserves its owned session. */
class ApprovalSandboxCapability extends Capability {
  readonly type = 'approval_sandbox';

  override tools(): Tool<any>[] {
    return [
      {
        type: 'function',
        name: 'run_command',
        description: 'run_command',
        parameters: {
          type: 'object',
          properties: { cmd: { type: 'string' } },
          required: ['cmd'],
          additionalProperties: false,
        } as any,
        strict: true,
        invoke: async (_ctx: RunContext<any>, input: string): Promise<string> => {
          if (!this._session) throw new Error('approval_sandbox capability is not bound to a session');
          return this._session.execCommand!(JSON.parse(input));
        },
        needsApproval: async () => true,
        isEnabled: async () => true,
      } as FunctionTool,
    ];
  }
}

export async function sandboxApprovalResumeWorkflow(): Promise<string> {
  const agent = new SandboxAgent({
    name: 'sandbox-approval',
    model: 'gpt-4o-mini',
    capabilities: [new ApprovalSandboxCapability()],
    defaultManifest: new Manifest({
      environment: { API_KEY: workerEnvValue('OPENAI_AGENTS_TEST_MANIFEST_SECRET') },
    }),
  });
  const runner = new TemporalOpenAIRunner();
  const runConfig = { sandbox: { client: temporalSandboxClient('fake') } };

  const result = await runner.run(agent, 'run a command', { runConfig });
  if (result.interruptions.length === 0) return 'no-interruption';
  for (const interruption of result.interruptions) result.state.approve(interruption);

  const resumed = await runner.run(agent, result.state, { runConfig });
  return `${resumed.finalOutput}`;
}

export async function sandboxManifestResumeWorkflow(): Promise<string> {
  const client = temporalSandboxClient('fake');
  const session = await client.create(
    new Manifest({
      entries: { 'base.txt': { type: 'file', content: 'base' } },
      environment: { API_KEY: workerEnvValue('OPENAI_AGENTS_TEST_MANIFEST_SECRET') },
    })
  );
  await session.applyManifest!(new Manifest({ entries: { 'added.txt': { type: 'file', content: 'added' } } }));
  const live = 'added.txt' in session.state.manifest.entries;
  const resumed = await client.resume(session.state);
  const persisted = 'added.txt' in resumed.state.manifest.entries;
  const reference = isEnvValueReference(resumed.state.manifest.environment.API_KEY);
  return `live=${live} persisted=${persisted} reference=${reference}`;
}

export async function sandboxExecWorkflow(): Promise<string> {
  const client = temporalSandboxClient('fake');
  const session = await client.create();
  await session.start!();
  const result = await session.exec!({ cmd: 'echo hello' });
  await session.readFile!({ path: '/workspace/out.txt' });
  const editor = session.createEditor!();
  await editor.createFile({ type: 'create_file', path: '/workspace/out.txt', diff: 'secret-content' });
  return `exit=${result.exitCode}`;
}

export async function sandboxArchiveLimitsWorkflow(): Promise<string> {
  const client = temporalSandboxClient('fake');
  const session = await client.create();
  session.setArchiveLimits!({ maxInputBytes: 42 });
  await session.persistWorkspace!();
  await session.hydrateWorkspace!(new Uint8Array([1, 2, 3]));
  return 'ok';
}

export async function sandboxValidationWorkflow(): Promise<string> {
  const runner = new TemporalOpenAIRunner();

  try {
    await runner.run(new SandboxAgent({ name: 'sandbox', model: 'gpt-4o-mini' }), 'hello');
    return 'FAIL: no-config should have thrown';
  } catch (e) {
    if (!/runConfig\.sandbox is not configured/.test((e as Error).message)) {
      return `FAIL: unexpected no-config error: ${(e as Error).message}`;
    }
  }

  try {
    const sandbox = new SandboxAgent({ name: 'sandbox_target', model: 'gpt-4o-mini' });
    const router = new Agent({ name: 'router', model: 'gpt-4o-mini', handoffs: [sandbox] });
    await runner.run(router, 'hello');
    return 'FAIL: handoff-no-config should have thrown';
  } catch (e) {
    if (!/runConfig\.sandbox is not configured/.test((e as Error).message)) {
      return `FAIL: unexpected handoff-no-config error: ${(e as Error).message}`;
    }
  }

  try {
    await runner.run(new SandboxAgent({ name: 'sandbox', model: 'gpt-4o-mini' }), 'hello', {
      runConfig: { sandbox: {} },
    });
    return 'FAIL: null-client should have thrown';
  } catch (e) {
    if (!/runConfig\.sandbox\.client must be set/.test((e as Error).message)) {
      return `FAIL: unexpected null-client error: ${(e as Error).message}`;
    }
  }

  try {
    await runner.run(new SandboxAgent({ name: 'sandbox', model: 'gpt-4o-mini' }), 'hello', {
      runConfig: { sandbox: { client: { backendId: 'raw' } as any } },
    });
    return 'FAIL: raw-client should have thrown';
  } catch (e) {
    if (!/Do not pass a raw sandbox client directly/.test((e as Error).message)) {
      return `FAIL: unexpected raw-client error: ${(e as Error).message}`;
    }
  }

  return 'OK';
}
