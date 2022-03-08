export interface ExampleModel {
  someProperty: ExampleEnum;
}

export enum ExampleEnum {
  success = 'succcess',
  failure = 'failure',
}

export function extractProperty(obj: ExampleModel): ExampleEnum {
  return obj.someProperty;
}
