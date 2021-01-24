import { Context } from '@temporal-sdk/workflow';
import { httpGet } from '@activities';

const httpGetWithCustomTimeout = Context.configure(httpGet, { type: 'local', startToCloseTimeout: '10 minutes' });

export async function main() {
  {
    const body = await httpGet('https://google.com');
    console.log(body);
  }
  {
    const body = await httpGetWithCustomTimeout('http://example.com');
    console.log(body);
  }
}
