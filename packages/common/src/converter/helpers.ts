import { isRecord } from '../type-helpers';

export function patchProtobufRoot<T extends Record<string, unknown>>(root: T, name?: string): T {
  const newRoot = new (root.constructor as any)(isNamespace(root) ? name : {});
  for (const key in root) {
    newRoot[key] = root[key];
  }

  if (isRecord(root.nested)) {
    for (const typeOrNamespace in root.nested) {
      const value = root.nested[typeOrNamespace];
      if (typeOrNamespace in root && !(isType(root[typeOrNamespace]) || isNamespace(root[typeOrNamespace]))) {
        console.log(
          `patchRoot warning: overriding property '${typeOrNamespace}' that is used by protobufjs with the '${typeOrNamespace}' protobuf namespace. This may result in protobufjs not working property.`
        );
      }

      if (isNamespace(value)) {
        newRoot[typeOrNamespace] = patchProtobufRoot(value, typeOrNamespace);
      } else if (isType(value)) {
        newRoot[typeOrNamespace] = value;
      }
    }
  }

  return newRoot;
}

type Type = Record<string, unknown>;
type Namespace = { nested: Record<string, unknown> };

function isType(value: unknown): value is Type {
  return isRecord(value) && value.constructor.name === 'Type';
}

function isNamespace(value: unknown): value is Namespace {
  return isRecord(value) && value.constructor.name === 'Namespace';
}
