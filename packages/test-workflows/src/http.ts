import { Context } from '@temporalio/workflow';
import { httpGet } from '@activities';

const httpGetWithCustomTimeout = Context.configure(httpGet, {
  type: 'remote',
  taskQueue: 'remote',
  startToCloseTimeout: '10 minutes',
});

export async function main(): Promise<void> {
  {
    const body = await httpGet('https://google.com');
    console.log(body);
  }
  {
    const body = await httpGetWithCustomTimeout('http://example.com');
    console.log(body);
  }
}
