import arg from 'arg';
import { Connection } from '@temporalio/client';
import { createNamespace, waitOnNamespace } from '@temporalio/testing/lib/utils';
import { SetupArgSpec, setupArgSpec, getRequired } from './args';

async function main() {
  const args = arg<SetupArgSpec>(setupArgSpec);

  const serverAddress = getRequired(args, '--server-address');
  const namespace = getRequired(args, '--ns');

  const connection = new Connection({ address: serverAddress });

  await createNamespace(connection, namespace);
  console.log('Registered namespace', { namespace });
  await waitOnNamespace(connection, namespace);
  console.log('Wait complete on namespace', { namespace });
}

main()
  .then(() => {
    process.exit();
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
