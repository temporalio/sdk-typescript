// @@@SNIPSTART nodejs-mtls-worker
import fs from 'fs';
import path from 'path';
import { Worker } from '@temporalio/worker';

async function run() {
  // certsDir should be the directory created by the generate-certs.sh script from
  // https://github.com/temporalio/customization-samples/tree/master/tls/tls-full#steps-to-run-this-sample
  const [certsDir] = process.argv.slice(2);
  if (certsDir === undefined) {
    throw new Error('Please pass certs dir as single argument');
  }
  // Connect to localhost and use the "default" namespace
  await Worker.create({
    taskQueue: 'tutorial',
    serverOptions: {
      tls: {
        serverNameOverride: 'development.cluster-x.contoso.com',
        serverRootCACertificate: fs.readFileSync(path.join(certsDir, 'cluster/ca/server-intermediate-ca.pem')),
        clientCertPair: {
          crt: fs.readFileSync(path.join(certsDir, 'client/development/client-development-namespace.pem')),
          key: fs.readFileSync(path.join(certsDir, 'client/development/client-development-namespace.key')),
        },
      },
    },
  });
  console.log('Worker connection succesfully established');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
// @@@SNIPEND
