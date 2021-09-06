import fs from 'fs';

import { getErrorCode } from './get-error-code';

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
