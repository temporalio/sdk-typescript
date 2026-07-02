import { randomUUID } from 'crypto';
import { Client } from '@temporalio/client';
import type { PayloadTypeHints } from '@temporalio/common';
import { workflowInterceptorModules } from '@temporalio/testing';
import { bundleWorkflowCode } from '@temporalio/worker';
import { defineWorkflowOptions } from '@temporalio/workflow';
import type { TestWorkflowEnvironment } from './helpers';
import { bundlerOptions } from './helpers';
import type { Context } from './helpers-integration';
import {
  configurableHelpers,
  createTestWorkflowEnvironment,
  makeConfigurableEnvironmentTestFn,
} from './helpers-integration';

const converterPath = require.resolve('./payload-converters/type-hints');
const dataConverter = { payloadConverterPath: converterPath };

class Order {
  constructor(
    readonly id: string,
    readonly totalCents: bigint
  ) {}

  summary(): string {
    return `${this.id}:${this.totalCents}`;
  }
}

const orderHint = {
  toIntermediate(value: Order): unknown {
    return { id: value.id, totalCents: value.totalCents.toString() };
  },
  fromIntermediate(value: any): Order {
    return new Order(value.id, BigInt(value.totalCents));
  },
};

const typeHints: PayloadTypeHints = { inputTypes: [orderHint] };

defineWorkflowOptions(workflowStartWithTypeHint, {
  staticOptions: { typeHints },
});
export async function workflowStartWithTypeHint(order: Order): Promise<{
  isOrder: boolean;
  summary: string;
  totalCentsType: string;
}> {
  return {
    isOrder: order instanceof Order,
    summary: order instanceof Order ? order.summary() : 'not-an-order',
    totalCentsType: typeof (order as any).totalCents,
  };
}

const test = makeConfigurableEnvironmentTestFn<Context>({
  createTestContext: async () => {
    const env = await createTestWorkflowEnvironment();
    const workflowBundle = await bundleWorkflowCode({
      ...bundlerOptions,
      workflowInterceptorModules: [...workflowInterceptorModules],
      workflowsPath: __filename,
      payloadConverterPath: converterPath,
    });
    return { env, workflowBundle };
  },
  teardown: async (c) => {
    await c.env.teardown();
  },
});

function makeClient(env: TestWorkflowEnvironment): Client {
  return new Client({
    connection: env.client.connection,
    namespace: env.client.options.namespace,
    dataConverter,
  });
}

test('workflow start uses definition-supplied input type hints', async (t) => {
  const h = configurableHelpers(t, t.context.workflowBundle, t.context.env);
  const client = makeClient(t.context.env);
  const worker = await h.createWorker({ dataConverter });

  await worker.runUntil(async () => {
    const result = await client.workflow.execute(workflowStartWithTypeHint, {
      workflowId: `wf-${randomUUID()}`,
      taskQueue: h.taskQueue,
      args: [new Order('order-1', 12345n)],
    });

    t.deepEqual(result, {
      isOrder: true,
      summary: 'order-1:12345',
      totalCentsType: 'bigint',
    });
  });
});
