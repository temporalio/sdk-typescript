import { setTracingDisabled } from '@openai/agents-core';
import { helpers } from '@temporalio/test-helpers';
import { OpenAIAgentsPlugin, SandboxClientProvider } from '..';
import { makeTestFunction } from './helpers/test-fn';
import { FakeModelProvider, textResponse, toolCallResponse } from './stubs/openai-agents';
import { FakeSandboxClient, FakeSandboxSession } from './stubs/sandbox-fakes';
import {
  sandboxAgentWorkflow,
  sandboxArchiveLimitsWorkflow,
  sandboxManifestResumeWorkflow,
  sandboxValidationWorkflow,
} from './workflows/openai-sandbox';

setTracingDisabled(false);

const test = makeTestFunction({
  workflowsPath: require.resolve('./workflows/openai-sandbox'),
  plugins: [new OpenAIAgentsPlugin({ modelProvider: new FakeModelProvider([]) })],
});

test('SandboxAgent run exercises the full sandbox lifecycle through Activities', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);

  const session = new FakeSandboxSession();
  const client = new FakeSandboxClient(session);

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new FakeModelProvider([
          toolCallResponse('run_command', { cmd: 'echo hello' }),
          toolCallResponse('read_file', { path: '/workspace/test.txt' }),
          toolCallResponse('write_file', { path: '/workspace/out.txt', diff: 'hello' }),
          textResponse('Done.'),
        ]),
        modelParams: { startToCloseTimeout: '30s' },
        sandboxClientProviders: [new SandboxClientProvider('fake', client)],
      }),
    ],
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(sandboxAgentWorkflow);
    t.is(result, 'Done.');
  });

  t.is(client.createCalls.length, 1, 'client.create() not called');
  t.is(session.startCalls, 1, 'session.start() not called');
  t.true(session.execCalls.length >= 1, 'session.execCommand() not called');
  t.is(session.execCalls[0]!.cmd, 'echo hello');
  t.true(session.readFileCalls.length >= 1, 'session.readFile() not called');
  t.deepEqual(session.editorOperations, ['create:/workspace/out.txt'], 'editor createFile not called');
  t.true(session.stopCalls >= 1, 'session.stop() not called');
  t.true(session.shutdownCalls >= 1, 'session.shutdown() not called');
  t.true(session.deleteCalls >= 1, 'session.delete() not called');
});

test('applyManifest updates the Workflow-side manifest and survives resume', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new FakeModelProvider([]),
        sandboxClientProviders: [new SandboxClientProvider('fake', new FakeSandboxClient())],
      }),
    ],
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(sandboxManifestResumeWorkflow);
    t.is(result, 'live=true persisted=true');
  });
});

test('setArchiveLimits is forwarded to the persistWorkspace and hydrateWorkspace Activities', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);

  const client = new FakeSandboxClient();
  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new FakeModelProvider([]),
        sandboxClientProviders: [new SandboxClientProvider('fake', client)],
      }),
    ],
  });

  await worker.runUntil(async () => {
    t.is(await executeWorkflow(sandboxArchiveLimitsWorkflow), 'ok');
  });

  t.deepEqual(client.session.archiveLimits, { maxInputBytes: 42 });
  t.deepEqual(client.session.hydrateCalls[0]!.archiveLimits, { maxInputBytes: 42 });
});

test('Sandbox configuration errors are raised inside the Workflow', async (t) => {
  const { createWorker, executeWorkflow } = helpers(t);

  const worker = await createWorker({
    plugins: [
      new OpenAIAgentsPlugin({
        modelProvider: new FakeModelProvider([]),
        sandboxClientProviders: [new SandboxClientProvider('fake', new FakeSandboxClient())],
      }),
    ],
  });

  await worker.runUntil(async () => {
    const result = await executeWorkflow(sandboxValidationWorkflow);
    t.is(result, 'OK');
  });
});
