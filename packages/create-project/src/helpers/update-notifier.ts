import updateNotifier from 'update-notifier';

export function createUpdateNotifier(pkg: { name: string; version: string }): () => void {
  try {
    const notifier = updateNotifier({
      pkg,
      updateCheckInterval: 60 * 60 * 1000,
      shouldNotifyInNpmScript: true,
    });
    return () => {
      try {
        notifier.notify({
          defer: false,
          message: 'A new version of {packageName} is available!\nRun npx {packageName}@latest to use it.',
        });
      } catch {
        // Update notifications must never interrupt project creation.
      }
    };
  } catch {
    return () => undefined;
  }
}
