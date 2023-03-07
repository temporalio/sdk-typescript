// Modified from: https://github.com/vercel/next.js/blob/2425f4703c4c6164cecfdb6aa8f80046213f0cc6/packages/create-next-app/helpers/is-writeable.ts
import fs from 'node:fs';

import { getErrorCode } from './get-error-code.js';

export async function isWriteable(directory: string): Promise<boolean> {
  try {
    await fs.promises.access(directory, (fs.constants || fs).W_OK);
    return true;
  } catch (error) {
    if (getErrorCode(error) === 'EACCES') {
      return false;
    } else {
      throw error;
    }
  }
}
