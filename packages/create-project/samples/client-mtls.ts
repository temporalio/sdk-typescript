// @@@SNIPSTART nodejs-mtls-client
import fs from 'fs';
import { Connection } from '@temporalio/client';
import { Example } from '@interfaces/workflows';
import { getEnv, Env } from './mtls-env';

/**
 * Schedule a Workflow connecting with mTLS, configuration is provided via environment variables.
 * Note that serverNameOverride and serverRootCACertificate are optional.
 */
async function run({
  address,
  namespace,
  clientCertPath,
  clientKeyPath,
  serverNameOverride,
  serverRootCACertificatePath,
  taskQueue,
}: Env) {
  let serverRootCACertificate: Buffer | undefined = undefined;
  if (serverRootCACertificatePath) {
    serverRootCACertificate = fs.readFileSync(serverRootCACertificatePath);
  }
  const connection = new Connection({
    address,
    tls: {
      serverNameOverride,
      serverRootCACertificate,
      clientCertPair: {
        crt: fs.readFileSync(clientCertPath),
        key: fs.readFileSync(clientKeyPath),
      },
    },
  });
  await connection.untilReady();
  // Create a typed client using the Example Workflow interface,
  const workflow = connection.workflow<Example>('example', { namespace, taskQueue });
  const result = await workflow.start('Temporal');
  console.log(result); // Hello, Temporal!
}

run(getEnv()).then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
// @@@SNIPEND
