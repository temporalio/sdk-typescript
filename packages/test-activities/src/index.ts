export async function httpGet(url: string): Promise<string> {
  return `<html><body>hello from ${url}</body></html>`;
}
