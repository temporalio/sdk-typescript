export function patchRoot<T>(root: T, seen = new Set()): T {
  for (const key in root) {
    if (root[key] && typeof root[key] === 'object') {
      // avoid infinite loop (e.g. with the `parent` field)
      if (!seen.has(root[key])) {
        seen.add(root[key]);
        patchRoot(root[key], seen);
      }
    }
    if (key === 'nested') {
      for (const nestedKey in root[key]) {
        if (nestedKey in root && (root as any)[nestedKey]?.constructor?.name !== 'Type') {
          console.log(
            `patchRoot warning: overriding property '${nestedKey}' that is used by protobufjs with the '${nestedKey}' protobuf namespace. This may result in protobufjs not working property.`
          );
        }
        (root as any)[nestedKey] = root[key][nestedKey];
      }
      delete root[key];
    }
  }

  return root;
}
