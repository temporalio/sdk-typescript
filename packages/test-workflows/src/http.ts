// @@@SNIPSTART nodejs-schedule-activity-workflow
import { Context } from '@temporalio/workflow';
import { httpGet } from '@activities';
import { HTTP } from '@interfaces';

const httpGetWithCustomTimeout = Context.configure(httpGet, {
  type: 'remote',
  scheduleToCloseTimeout: '30 minutes',
});

async function main(): Promise<string[]> {
  const responses: string[] = [];
  {
    const response = await httpGet('https://google.com');
    console.log(response);
    responses.push(response);
  }
  {
    const response = await httpGetWithCustomTimeout('http://example.com');
    console.log(response);
    responses.push(response);
  }
  return responses;
}

export const workflow: HTTP = { main };
// @@@SNIPEND
