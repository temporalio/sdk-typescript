import test from 'ava';
import { patchProtobufRoot } from '@temporalio/common/lib/protobufs';

test('patchRoot', (t) => {
  const type = new Type();
  t.deepEqual((patchProtobufRoot({ nested: { type } }) as any).type, type);

  const bar = new Namespace({ BarMsg: new Type() });
  const root = {
    nested: {
      foo: new Namespace({
        Msg: new Type(),
        nested: {
          bar,
        },
      }),
    },
  };
  t.like(patchProtobufRoot(root), {
    ...root,
    foo: { Msg: new Type(), bar: { BarMsg: new Type() }, nested: { bar } },
  } as any);
});

class Namespace {
  public static className = 'Namespace';

  constructor(props: Record<string, unknown>) {
    for (const key in props) {
      (this as any)[key] = props[key];
    }
  }
}

class Type {
  public static className = 'Type';
}
