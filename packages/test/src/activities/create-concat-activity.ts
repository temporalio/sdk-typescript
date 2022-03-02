/* eslint-disable @typescript-eslint/explicit-module-boundary-types */
export function createConcatActivity(logs: string[]) {
  return {
    async concat(string1: string, string2: string): Promise<string> {
      logs.push(`Activity${string1}${string2}`);
      return string1 + string2;
    },
  };
}
