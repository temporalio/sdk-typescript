export async function fillMemory(): Promise<number> {
  // It looks like JIT compilation of the following code affects the way the out of memory error
  // will get reported. That is, once the code has been optimized, the out of memory condition is
  // very likely to trigger a low level (native-like) error, which may terminate the whole process,
  // rather than just the Worker Thread.
  //
  // Wrapping code in an eval block delays JIT compilation, thus reducing the probability of flakes.

  // Allocate 32GB of memory
  // V8 internally stores numbers as 8 bytes, so each pass allocates 16MB
  const accumulator = [];
  eval(`
    for (let i = 0; i < 2048; i++) {
      accumulator.push(new Array(1024 * 1024 * 2).fill(i));
    }
  `);

  return accumulator.length;
}
