import { Context } from '@temporalio/workflow';
import { HTTP } from '../interfaces';

const httpGetFromString = Context.configure<[string], string>(JSON.stringify(['@activities', 'httpGet']));

const httpGetFromTuple = Context.configure<[string], string>(['@activities', 'httpGet'], {
  type: 'remote',
  scheduleToCloseTimeout: '30 minutes',
  heartbeatTimeout: '3s',
});

const httpGetWithSeparatelyConfigureTimeouts = Context.configure(httpGetFromString, {
  type: 'remote',
  startToCloseTimeout: '10 minutes',
  scheduleToStartTimeout: '20 minutes',
});

async function main(): Promise<string[]> {
  try {
    Context.configure(['@activities', 'httpGet'], {
      type: 'remote',
      scheduleToStartTimeout: '30 minutes',
    });
  } catch (err) {
    console.log(`${err}`);
  }

  const responses: string[] = [];
  {
    const response = await httpGetFromString('http://example.com');
    responses.push(response);
  }
  {
    const response = await httpGetFromTuple('http://example.com');
    responses.push(response);
  }
  {
    const response = await httpGetWithSeparatelyConfigureTimeouts('http://example.com');
    responses.push(response);
  }
  return responses;
}

export const workflow: HTTP = { main };
