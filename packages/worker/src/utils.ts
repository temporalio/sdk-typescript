export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
export const identity = <T>(x: T): T => x;

export const GiB = 1024 ** 3;
export const MiB = 1024 ** 2;
