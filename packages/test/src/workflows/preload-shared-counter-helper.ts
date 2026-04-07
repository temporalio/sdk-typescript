let counter = 0;

export function nextPreloadedCounterValue(): number {
  counter += 1;
  return counter;
}
