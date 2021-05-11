// @@@SNIPSTART nodejs-mtls-client
import fs from 'fs';
import path from 'path';
import * as grpc from 'grpc';
import { Connection } from '@temporalio/client';

async function run() {
  // certsDir should be the directory created by the generate-certs.sh script from https://github.com/temporalio/customization-samples/tree/master/tls/tls-full#steps-to-run-this-sample
  const [certsDir] = process.argv.slice(2);
  if (certsDir === undefined) {
    throw new Error('Please pass certs dir as single argument');
  }
  const credentials = grpc.credentials.createSsl(
    fs.readFileSync(path.join(certsDir, 'cluster/ca/server-intermediate-ca.pem')),
    fs.readFileSync(path.join(certsDir, 'client/development/client-development-namespace.key')),
    fs.readFileSync(path.join(certsDir, 'client/development/client-development-namespace.pem'))
  );
  // Connect to localhost and use the "default" namespace
  const connection = new Connection({
    credentials,
    channelArgs: {
      'grpc.ssl_target_name_override': 'development.cluster-x.contoso.com',
    },
  });
  await connection.untilReady();
  console.log('connection succesfully established');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
// @@@SNIPEND
