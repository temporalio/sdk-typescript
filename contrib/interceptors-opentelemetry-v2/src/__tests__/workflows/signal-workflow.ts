import { defineSignal, startChild, setHandler, sleep, condition } from '@temporalio/workflow';

const approveTopSecret = defineSignal('approve');

// A workflow that simply calls an activity
export async function topSecretGreeting(name: string): Promise<string> {
  const handle = await startChild(topSecretGreetingChild, {
    args: [name],
  });
  await Promise.all([handle.signal(approveTopSecret), sleep('1ms')]);
  return await handle.result();
}

export async function topSecretGreetingChild(name: string): Promise<string> {
  let approved = false;
  setHandler(approveTopSecret, () => {
    approved = true;
  });
  await condition(() => approved);
  return `Hello ${name}`;
}
