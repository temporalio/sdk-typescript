import * as fs from 'fs/promises';
import * as path from 'path';
import * as iface from '@temporalio/proto';
import { historyToJSON } from '@temporalio/common/lib/proto-utils';

/**
 * Load a history file from a given path. Supports both JSON and binary formats.
 */
export async function loadHistory(fpath: string): Promise<iface.temporal.api.history.v1.History> {
  const isJson = fpath.endsWith('json');
  if (isJson) {
    const hist = await fs.readFile(fpath, 'utf8');
    return JSON.parse(hist);
  } else {
    const hist = await fs.readFile(fpath);
    return iface.temporal.api.history.v1.History.decode(hist);
  }
}

/**
 * Save a history to a file in JSON format.
 */
export async function saveHistory(fpath: string, history: iface.temporal.api.history.v1.IHistory): Promise<void> {
  await fs.writeFile(fpath, historyToJSON(history));
}

/**
 * Load a history file from a directory relative to the given dirname.
 * This is a convenience function for loading history files from a package's history_files directory.
 *
 * @param dirname - The __dirname of the calling module
 * @param historyDir - The relative path to the history files directory (defaults to '../history_files')
 * @param fname - The filename of the history file to load
 */
export async function loadHistoryFromDir(
  dirname: string,
  fname: string,
  historyDir = '../history_files'
): Promise<iface.temporal.api.history.v1.History> {
  const fpath = path.resolve(dirname, historyDir, fname);
  return loadHistory(fpath);
}
