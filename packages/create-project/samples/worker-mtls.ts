// @@@SNIPSTART nodejs-mtls-worker
import fs from 'fs';
import { Worker } from '@temporalio/worker';
import { getEnv, Env } from './mtls-env';

/**
 * Run a Worker with an mTLS connection, configuration is provided via environment variables.
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
  const worker = await Worker.create({
    workDir: __dirname,
    taskQueue,
    serverOptions: {
      address,
      namespace,
      tls: {
        serverNameOverride,
        serverRootCACertificate,
        // See docs for other TLS options
        clientCertPair: {
          crt: fs.readFileSync(clientCertPath),
          key: fs.readFileSync(clientKeyPath),
        },
      },
    },
  });
  console.log('Worker connection succesfully established');
  // Start accepting tasks on the `tutorial` queue
  await worker.run();
}

run(getEnv()).catch((err) => {
  console.error(err);
  process.exit(1);
});
// @@@SNIPEND
