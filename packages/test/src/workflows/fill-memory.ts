import * as wf from '@temporalio/workflow';

export async function fillMemory(): Promise<void> {
  // It looks like JIT compilation of the following code affects the way the out of memory error
  // will get reported. That is, once the code has been optimized, the out of memory condition is
  // very likely to trigger a low level (native-like) error, which may terminate the whole process,
  // rather than just the Worker Thread.
  //
  // By wrapping this code in an IIFE, we delay JIT compilation of that code, thus reducing the
  // probability of test flakes.
  (() => {
    const accumulator = [];
    // Allocate 4GB of memory
    for (let i = 0; i < 2048; i++) {
      accumulator.push(new Array(1024 * 1024 * 2).fill(i));
    }
  })();
}

export async function dontFillMemory(): Promise<void> {
  // This will take, on average, 600 * .2s = 120s to complete
  for (let i = 0; i < 600; i++) {
    await wf.sleep(Math.floor(200 * Math.random()));
  }
}
