import { Context, CancellationError, sleep } from '@temporal-sdk/workflow';
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
    result = await Context.shield(async () => httpGetJSON(url));
  } catch (e) {
    // We still want to know the workflow was cancelled
    if (e instanceof CancellationError) {
      console.log('Workflow cancelled');
    } else {
      throw e;
    }
  }

  // Shield and await completion after cancelled
  let shielded: Promise<any> | undefined;
  try {
    result = await Context.shield(async () => {
      shielded = httpGetJSON(url);
      return await shielded;
    });
  } catch (e) {
    // We still want to know the workflow was cancelled
    if (e instanceof CancellationError) {
      console.log('Workflow cancelled');
      try {
        result = await shielded;
      } catch (e) {
        // handle activity failed
      }
    } else {
      throw e;
    }
  }
  return result;
}
