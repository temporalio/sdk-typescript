export async function fillMemory(): Promise<number> {
  // There are different ways that Node may report "out of memory" conditions, and the criterias
  // for each of them are essentially undocumented. The following code has been empirically
  // designed to trigger a very specific type of error, i.e. a Worker Thread getting killed with an
  // `ERR_WORKER_OUT_OF_MEMORY` code, with very high probability (more than 95% of the time across
  // all of our test setups, including all platforms, and Node.js v16, v18 and v20). The size of
  // RAM appears not to be important.
  //
  // Occurence of an `ERR_WORKER_OUT_OF_MEMORY` error in the following code appears to be the
  // result of some interractions of V8's JIT compiler and the V8's heap allocator. With appropriate
  // parameters, the code crashes on the first execution of the loop; yet, removing the loop or
  // reducing the upper bound of the loop (exact threshold appears to be between 64 and 128) prevents
  // the crash, presumably because the loop might no longer be deemed worth of early JIT compilation.
  // Allocating larger arrays is also likely to prevent the crash, presumably because the arrays will
  // then be allocated from the "large objects space" rather than the "yound gen" space, which, by
  // default, has a limit of 16MB on 64-bit systems.
  //
  // We also need to prevent the JIT compiler from optimizing this code _before_ we even start
  // executing it, as that then results in a low level error (native-like), which may terminate the
  // whole process rather than just the Worker Thread. Hence, we wrap the code in an `eval` block.

  const accumulator = [];
  eval(`
    for (let i = 0; i < 2048; i++) {
      accumulator.push(new Array(1024 * 1024 * 2).fill(i));
    }
  `);

  return accumulator.length;
}
