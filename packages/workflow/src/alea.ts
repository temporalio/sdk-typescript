// A port of an algorithm by Johannes Baagøe <baagoe@baagoe.com>, 2010
// http://baagoe.com/en/RandomMusings/javascript/
// https://github.com/nquinlan/better-random-numbers-for-javascript-mirror
// Original work is under MIT license -

// Copyright (C) 2010 by Johannes Baagøe <baagoe@baagoe.org>
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

// Taken and modified from https://github.com/davidbau/seedrandom/blob/released/lib/alea.js

class Alea {
  public c: number;
  public s0: number;
  public s1: number;
  public s2: number;

  constructor(seed: number[]) {
    const mash = new Mash();
    // Apply the seeding algorithm from Baagoe.
    this.c = 1;
    this.s0 = mash.mash([32]);
    this.s1 = mash.mash([32]);
    this.s2 = mash.mash([32]);
    this.s0 -= mash.mash(seed);
    if (this.s0 < 0) {
      this.s0 += 1;
    }
    this.s1 -= mash.mash(seed);
    if (this.s1 < 0) {
      this.s1 += 1;
    }
    this.s2 -= mash.mash(seed);
    if (this.s2 < 0) {
      this.s2 += 1;
    }
  }

  public next(): number {
    const t = 2091639 * this.s0 + this.c * 2.3283064365386963e-10; // 2^-32
    this.s0 = this.s1;
    this.s1 = this.s2;
    return (this.s2 = t - (this.c = t | 0));
  }
}

export type RNG = () => number;

export function alea(seed: number[]): RNG {
  const xg = new Alea(seed);
  return xg.next.bind(xg);
}

export class Mash {
  private n = 0xefc8249d;

  public mash(data: number[]): number {
    let { n } = this;
    for (let i = 0; i < data.length; i++) {
      n += data[i];
      let h = 0.02519603282416938 * n;
      n = h >>> 0;
      h -= n;
      h *= n;
      n = h >>> 0;
      h -= n;
      n += h * 0x100000000; // 2^32
    }
    this.n = n;
    return (n >>> 0) * 2.3283064365386963e-10; // 2^-32
  }
}
