import vm from 'vm';
import anyTest, { TestFn } from 'ava';
import { symbolBasedInstanceOf } from '@temporalio/common/lib/type-helpers';

interface Context {
  cx1: (script: string) => any;
  cx2: (script: string) => any;
}
const test = anyTest as TestFn<Context>;

const script = new vm.Script(`
  class ClassA {};
  class ClassB extends ClassA {}
  class ClassC extends ClassB {}
`);

test.beforeEach((t) => {
  const cx1 = vm.createContext();
  cx1.symbolBasedInstanceOf = symbolBasedInstanceOf;
  script.runInContext(cx1);

  const cx2 = vm.createContext();
  cx2.symbolBasedInstanceOf = symbolBasedInstanceOf;
  script.runInContext(cx2);

  t.context = {
    cx1: (script: string) => vm.runInContext(script, cx1),
    cx2: (script: string) => vm.runInContext(script, cx2),
  };
});

// This test is trivial and obvious. It is only meant to clearly establish a baseline for other tests.
test.serial('BASELINE - instanceof works as expected in single realm, without symbolBasedInstanceOf', (t) => {
  const { cx1 } = t.context;

  t.true(cx1('new ClassA()') instanceof cx1('ClassA'));
  t.true(cx1('new ClassB()') instanceof cx1('ClassA'));
  t.true(cx1('new ClassC()') instanceof cx1('ClassA'));

  t.false(cx1('new ClassA()') instanceof cx1('ClassB'));
  t.true(cx1('new ClassB()') instanceof cx1('ClassB'));
  t.true(cx1('new ClassC()') instanceof cx1('ClassB'));

  t.false(cx1('new ClassA()') instanceof cx1('ClassC'));
  t.false(cx1('new ClassB()') instanceof cx1('ClassC'));
  t.true(cx1('new ClassC()') instanceof cx1('ClassC'));

  t.true(cx1('new ClassA()') instanceof cx1('Object'));
  t.true(cx1('new ClassB()') instanceof cx1('Object'));
  t.true(cx1('new ClassC()') instanceof cx1('Object'));
});

// This test demonstrates that cross-realm instanceof is indeed broken by default.
test.serial('BASELINE - instanceof is broken in cross realms, without symbolBasedInstanceOf', (t) => {
  const { cx1, cx2 } = t.context;

  t.false(cx1('new ClassA()') instanceof cx2('ClassA'));
  t.false(cx1('new ClassB()') instanceof cx2('ClassA'));
  t.false(cx1('new ClassC()') instanceof cx2('ClassA'));

  t.false(cx1('new ClassA()') instanceof cx2('ClassB'));
  t.false(cx1('new ClassB()') instanceof cx2('ClassB'));
  t.false(cx1('new ClassC()') instanceof cx2('ClassB'));

  t.false(cx1('new ClassA()') instanceof cx2('ClassC'));
  t.false(cx1('new ClassB()') instanceof cx2('ClassC'));
  t.false(cx1('new ClassC()') instanceof cx2('ClassC'));

  t.false(cx1('new ClassA()') instanceof cx2('Object'));
  t.false(cx1('new ClassB()') instanceof cx2('Object'));
  t.false(cx1('new ClassC()') instanceof cx2('Object'));
});

test.serial(`symbolBasedInstanceOf doesn't break any default behaviour of instanceof in single realm`, (t) => {
  const { cx1 } = t.context;

  cx1(`symbolBasedInstanceOf('ClassA')(ClassA)`);
  cx1(`symbolBasedInstanceOf('ClassB')(ClassB)`);

  t.true(cx1('new ClassA()') instanceof cx1('ClassA'));
  t.true(cx1('new ClassB()') instanceof cx1('ClassA'));
  t.true(cx1('new ClassC()') instanceof cx1('ClassA'));

  t.false(cx1('new ClassA()') instanceof cx1('ClassB'));
  t.true(cx1('new ClassB()') instanceof cx1('ClassB'));
  t.true(cx1('new ClassC()') instanceof cx1('ClassB'));

  t.false(cx1('new ClassA()') instanceof cx1('ClassC'));
  t.false(cx1('new ClassB()') instanceof cx1('ClassC'));
  t.true(cx1('new ClassC()') instanceof cx1('ClassC'));

  t.true(cx1('new ClassA()') instanceof cx1('Object'));
  t.true(cx1('new ClassB()') instanceof cx1('Object'));
  t.true(cx1('new ClassC()') instanceof cx1('Object'));
});

test.serial(`instanceof is working as expected across realms with symbolBasedInstanceOf`, (t) => {
  const { cx1, cx2 } = t.context;

  cx1(`symbolBasedInstanceOf('ClassA')(ClassA)`);
  cx1(`symbolBasedInstanceOf('ClassB')(ClassB)`);

  cx2(`symbolBasedInstanceOf('ClassA')(ClassA)`);
  cx2(`symbolBasedInstanceOf('ClassB')(ClassB)`);

  t.true(cx1('new ClassA()') instanceof cx2('ClassA'));
  t.true(cx1('new ClassB()') instanceof cx2('ClassA'));
  t.true(cx1('new ClassC()') instanceof cx2('ClassA'));

  t.false(cx1('new ClassA()') instanceof cx2('ClassB'));
  t.true(cx1('new ClassB()') instanceof cx2('ClassB'));
  t.true(cx1('new ClassC()') instanceof cx2('ClassB'));

  t.false(cx1('new ClassA()') instanceof cx2('ClassC'));
  t.false(cx1('new ClassB()') instanceof cx2('ClassC'));

  // This one is surprising but expected, as symbolBasedInstanceOf was never called on ClassC;
  // it therefore reverts to the default behavior of instanceof, which is not cross-realm safe.
  t.false(cx1('new ClassC()') instanceof cx2('ClassC'));

  // The followings are surprising, but expected, as 'Object' differs between realms.
  // symbolBasedInstanceOf doesn't help with that.
  t.false(cx1('new ClassA()') instanceof cx2('Object'));
  t.false(cx1('new ClassB()') instanceof cx2('Object'));
  t.false(cx1('new ClassC()') instanceof cx2('Object'));
});

// This test demonstrates that cross-realm instanceof is indeed broken by default.
test.serial('symbolBasedInstanceOf doesnt break on non-object values', (t) => {
  const { cx1 } = t.context;

  cx1(`symbolBasedInstanceOf('ClassA')(ClassA)`);

  t.false((true as any) instanceof cx1('ClassA'));
  t.false((12 as any) instanceof cx1('ClassA'));
  t.false((NaN as any) instanceof cx1('ClassA'));
  t.false(('string' as any) instanceof cx1('ClassA'));
  t.false(([] as any) instanceof cx1('ClassA'));
  t.false((undefined as any) instanceof cx1('ClassA'));
  t.false((null as any) instanceof cx1('ClassA'));
  t.false(((() => null) as any) instanceof cx1('ClassA'));
  t.false((Symbol() as any) instanceof cx1('ClassA'));
});

test.serial('Same context with same symbolBasedInstanceOf calls also works', (t) => {
  class ClassA {}
  class ClassB {}

  t.false(new ClassA() instanceof ClassB);
  t.false(new ClassB() instanceof ClassA);

  symbolBasedInstanceOf('Foo')(ClassA);
  symbolBasedInstanceOf('Foo')(ClassB);

  t.true(new ClassA() instanceof ClassB);
  t.true(new ClassB() instanceof ClassA);
});
