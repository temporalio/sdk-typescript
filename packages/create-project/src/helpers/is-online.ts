// Modified from: https://github.com/vercel/next.js/blob/2425f4703c4c6164cecfdb6aa8f80046213f0cc6/packages/create-next-app/helpers/is-online.ts
import { execSync } from 'node:child_process';
import dns from 'node:dns';
import { URL } from 'node:url';

// Look for any proxy the user might have configured on their machine
function getProxy(): string | undefined {
  if (process.env.https_proxy) {
    return process.env.https_proxy;
  }

  try {
    const httpsProxy = execSync('npm config get https-proxy').toString().trim();
    return httpsProxy !== 'null' ? httpsProxy : undefined;
  } catch (_e) {
    return;
  }
}

export function testIfThisComputerIsOnline(): Promise<boolean> {
  return new Promise((resolve) => {
    dns.lookup('github.com', (registryErr) => {
      if (!registryErr) {
        return resolve(true);
      }

      // If we can't reach the registry directly, see if the user has a proxy
      // configured. If they do, see if the proxy is reachable.
      const proxy = getProxy();
      if (!proxy) {
        return resolve(false);
      }

      const { hostname } = new URL(proxy);
      if (!hostname) {
        return resolve(false);
      }

      dns.lookup(hostname, (proxyErr) => {
        resolve(proxyErr == null);
      });
    });
  });
}
