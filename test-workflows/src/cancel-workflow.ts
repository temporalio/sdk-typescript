import { Context, CancellationError, shield, sleep } from '@temporal-sdk/workflow';
// import { httpGetJSON } from '@activities';

// TODO: replace with activity function once implemented
async function httpGetJSON(url: string): Promise<any> {
  await sleep(1);
  return { url };
}

export async function main(url: string) {
  let result: any = undefined;

  // By default timers and activities are automatically cancelled when the workflow is cancelled
  // and will throw the original CancellationError
  try {
    result = await httpGetJSON(url);
  } catch (e) {
    if (e instanceof CancellationError) {
      console.log('Workflow cancelled');
    } else {
      throw e;
    }
  }

  // Shield and await completion unless cancelled
  try {
    result = await shield(async () => httpGetJSON(url));
  } catch (e) {
    // We still want to know the workflow was cancelled
    if (e instanceof CancellationError) {
      console.log('Workflow cancelled');
    } else {
      throw e;
    }
  }

  // Shield and await completion after cancelled
  result = await shield(async () => httpGetJSON(url), false);
  if (Context.cancelled) {
    console.log('Workflow cancelled');
  }
  return result;
}
