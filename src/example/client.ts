import { Connection } from '../workflow-client';
import { ArgsAndReturn } from '../../workflow-interfaces/lib';
import { u8 } from './utils';

async function main() {
  const client = new Connection();
  const workflow = client.workflow<ArgsAndReturn>('args-and-return', { taskQueue: 'test' });
  console.log(await workflow('Hello', undefined, u8('world!')));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1)
  });
