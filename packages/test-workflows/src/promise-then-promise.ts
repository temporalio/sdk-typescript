import '@temporalio/workflow';

async function main(): Promise<void> {
  const res = await Promise.resolve(1).then((value) => new Promise((resolve) => resolve(value + 1)));
  console.log(res);
}

export const workflow = { main };
