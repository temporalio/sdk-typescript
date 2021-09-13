import { Returner } from '../interfaces';

export const asyncWorkflow: Returner<string> = () => {
  return {
    async execute() {
      return await (async () => 'async')();
    },
  };
};
