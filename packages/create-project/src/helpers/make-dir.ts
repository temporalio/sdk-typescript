// Modified from: https://github.com/vercel/next.js/blob/2425f4703c4c6164cecfdb6aa8f80046213f0cc6/packages/create-next-app/helpers/make-dir.ts
import fs from 'fs';

export async function makeDir(root: string, options = { recursive: true }): Promise<void> {
  await fs.promises.mkdir(root, options);
}
