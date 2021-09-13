import { Empty } from '../interfaces';

export const throwAsync: Empty = () => ({
  async execute(): Promise<void> {
    throw new Error('failure');
  },
});
