import { Gated } from '../interfaces';

export const failUnlessSignaledBeforeStart: Gated = () => {
  let pass = false;
  return {
    signals: {
      someShallPass(): void {
        pass = true;
      },
    },

    async execute(): Promise<void> {
      if (!pass) {
        throw new Error('None shall pass');
      }
    },
  };
};
