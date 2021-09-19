// @@@SNIPSTART nodejs-activity-class
export class ActivitiesWithDependencies {
  constructor(protected readonly greetString = 'Hello, ') {}

  async greet(name: string): Promise<string> {
    return `${this.greetString}${name}`;
  }
}
// @@@SNIPEND
