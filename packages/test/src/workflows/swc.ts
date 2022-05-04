interface Constructor {
  new (): any;
}

function sealed(constructor: Constructor) {
  Object.seal(constructor);
  Object.seal(constructor.prototype);
}

function decorate() {
  return function (_target: any, _propertyKey: string, _descriptor: PropertyDescriptor) {
    // empty
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
