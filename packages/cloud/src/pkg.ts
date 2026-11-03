// ../package.json is outside of the TS project rootDir which causes TS to complain about this import.
// We do not want to change the rootDir because it messes up the output structure.
// oxlint-disable-next-line typescript/ban-ts-comment
// @ts-ignore
import pkg from '../package.json';

export default pkg as { name: string; version: string };
