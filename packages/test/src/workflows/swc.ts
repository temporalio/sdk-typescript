// eslint-disable-next-line @typescript-eslint/ban-types
function sealed(constructor: Function) {
  Object.seal(constructor);
  Object.seal(constructor.prototype);
}

function decorate() {
  console.log('decorate(): factory evaluated');
  return function (_target: any, _propertyKey: string, _descriptor: PropertyDescriptor) {
    console.log('decorate(): called');
  };
}

@sealed
class ExampleClass {
  @decorate()
  method() {
    return 'hi';
  }
}

export async function swc(): Promise<void> {
  new ExampleClass().method();
}
