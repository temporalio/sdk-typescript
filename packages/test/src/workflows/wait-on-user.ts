// @@@SNIPSTART typescript-trigger-workflow
import { defineSignal, setHandler, sleep, Trigger } from '@temporalio/workflow';

const completeUserInteraction = defineSignal('completeUserInteraction');

export async function waitOnUser(userId: string): Promise<void> {
  const userInteraction = new Trigger<boolean>();

  // programmatically resolve Trigger
  setHandler(completeUserInteraction, () => userInteraction.resolve(true));

  const userInteracted = await Promise.race([userInteraction, sleep('30 days')]);
  if (!userInteracted) {
    await sendReminderEmail(userId);
  }
}
// @@@SNIPEND

async function sendReminderEmail(userId: string) {
  console.log(`reminder email for ${userId}`);
}
