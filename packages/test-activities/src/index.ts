export async function httpGet(url: string): Promise<string> {
  return `<html><body>hello from ${url}</body></html>`;
}

export async function throwAnError(message: string): Promise<void> {
  throw new Error(message);
}
