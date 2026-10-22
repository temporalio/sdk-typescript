export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (specifier !== 'got') return resolved;

  // Resolve the installed CLI's real dependency before adding fixture routing.
  // Missing production dependencies must still fail the package test.
  const source = `
import got from ${JSON.stringify(resolved.url)};
export default got.extend({hooks: {beforeRequest: [options => {
  const {hostname, pathname, search} = options.url;
  if (['api.github.com', 'codeload.github.com', 'registry.npmjs.org'].includes(hostname)) {
    options.url = new URL('/' + hostname + pathname + search, process.env.TEMPORAL_CREATE_FIXTURES_URL);
  }
}]}});
`;
  return { url: `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`, shortCircuit: true };
}
