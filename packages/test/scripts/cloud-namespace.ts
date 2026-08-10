import { appendFile, readFile } from 'node:fs/promises';
import { CloudOperationsClient, CloudOperationsConnection } from '@temporalio/cloud';
import { cloudNamespaceName, createCloudNamespace, deleteCloudNamespace } from '../src/cloud-namespace';

const CLOUD_OPERATION_TIMEOUT_MS = 10 * 60 * 1_000;

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

async function main(): Promise<void> {
  const [command, namespaceArgument] = process.argv.slice(2);
  if (command !== 'create' && command !== 'delete') {
    throw new TypeError('Usage: cloud-namespace.ts create | delete <namespace>');
  }

  const apiVersion = requiredEnv('TEMPORAL_CLIENT_CLOUD_API_VERSION');
  const connection = await CloudOperationsConnection.connect({
    apiKey: requiredEnv('TEMPORAL_CLIENT_CLOUD_API_KEY'),
  });
  const client = new CloudOperationsClient({ connection, apiVersion });
  const metadata = { 'temporal-cloud-api-version': apiVersion };

  try {
    await client.withDeadline(Date.now() + CLOUD_OPERATION_TIMEOUT_MS, async () => {
      await client.withMetadata(metadata, async () => {
        if (command === 'create') {
          const name = cloudNamespaceName(requiredEnv('GITHUB_RUN_ID'), requiredEnv('GITHUB_RUN_ATTEMPT'));
          const clientCa = await readFile(requiredEnv('TEMPORAL_CLOUD_CLIENT_CA_PATH'));
          const namespace = await createCloudNamespace(client.cloudService, {
            name,
            clientCa,
            onAccepted: async (acceptedNamespace) => {
              const output = `namespace=${acceptedNamespace}\naddress=${acceptedNamespace}.tmprl.cloud:7233\n`;
              const githubOutput = process.env.GITHUB_OUTPUT;
              if (githubOutput) await appendFile(githubOutput, output);
              else process.stdout.write(output);
            },
          });
          process.stdout.write(`Cloud namespace ${namespace} is ready\n`);
          return;
        }

        if (!namespaceArgument) {
          throw new TypeError('Usage: cloud-namespace.ts delete <namespace>');
        }
        await deleteCloudNamespace(client.cloudService, namespaceArgument);
        process.stdout.write(`Cloud namespace ${namespaceArgument} was deleted\n`);
      });
    });
  } finally {
    connection.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
