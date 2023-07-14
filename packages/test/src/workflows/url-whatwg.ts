// import URL but use directly from global URLSearchParams
import { URL } from 'url';

export async function urlEcho(url: string): Promise<string> {
  const parsedURL = new URL(url);
  const searchParams = new URLSearchParams({ counter: '1' });
  parsedURL.search = searchParams.toString();
  return parsedURL.toString();
}
