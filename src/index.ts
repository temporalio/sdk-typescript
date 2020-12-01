import { Workflow } from './engine';
import * as stdlib from './stdlib';
export { Workflow };

async function run() {
  const workflow = await Workflow.create();
  await stdlib.install(workflow);
  await workflow.run(`
    const cb = (a) => void console.log(a);
    setTimeout((x, y) => void x(y), 500, cb, 'hey');
    const timeout = setTimeout((x, y) => void x(y), 500, cb, 'hey');
    clearTimeout(timeout);
    console.log(timeout);
    console.log(new Date());
    console.log(Date.now());
    console.log(Math.random());
  `);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
