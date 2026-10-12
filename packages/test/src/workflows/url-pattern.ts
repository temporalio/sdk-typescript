import * as url from 'url';

interface URLPatternLike {
  exec(input: string): { pathname: { groups: Record<string, string | undefined> } } | null;
}
type URLPatternCtor = new (init: { pathname: string }) => URLPatternLike;

function matchUserId(URLPattern: URLPatternCtor | undefined, input: string): string | undefined {
  if (URLPattern === undefined) throw new Error('URLPattern is not defined');
  return new URLPattern({ pathname: '/users/:id' }).exec(input)?.pathname.groups.id;
}

export async function urlPatternGlobal(input: string): Promise<string | undefined> {
  // we don't import URLPattern - it is exposed as a global
  return matchUserId((globalThis as { URLPattern?: URLPatternCtor }).URLPattern, input);
}

export async function urlPatternFromImport(input: string): Promise<string | undefined> {
  return matchUserId((url as { URLPattern?: URLPatternCtor }).URLPattern, input);
}
