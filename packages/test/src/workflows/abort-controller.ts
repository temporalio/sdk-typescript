export async function abortController(): Promise<string | null> {
  let aborted: string | null = null;

  const controller = new AbortController();
  const { signal } = controller;

  const abortEventListener = () => {
    aborted = signal.reason;
  };

  signal.addEventListener('abort', abortEventListener);
  controller.abort('abort successful');
  signal.removeEventListener('abort', abortEventListener);

  return aborted;
}
