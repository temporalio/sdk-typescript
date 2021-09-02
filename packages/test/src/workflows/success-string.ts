import { Returner } from '../interfaces';

export const successString: Returner<string> = () => ({
  async execute() {
    return 'success';
  },
});
