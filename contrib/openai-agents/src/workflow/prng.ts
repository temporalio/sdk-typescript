export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Agent-SDK-shaped span ID derived from a Temporal-supplied unique input ID
// (queryId/updateId), orthogonal to the Workflow PRNG stream. Uses three
// salted FNV-1a-32 hashes (96 bits) to fill 24 hex characters, so user-
// supplied IDs that differ by case or punctuation produce distinct span IDs.
export function spanIdFromInputId(inputId: string): string {
  const a = fnv1a32(`0:${inputId}`).toString(16).padStart(8, '0');
  const b = fnv1a32(`1:${inputId}`).toString(16).padStart(8, '0');
  const c = fnv1a32(`2:${inputId}`).toString(16).padStart(8, '0');
  return `span_${a}${b}${c}`;
}

export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Per-call PRNG seeded from a unique input ID. Read-only handlers must NOT
// reuse the body PRNG: handler-task PRNG consumption isn't persisted, so
// using the body PRNG would either desync the body or collide across
// concurrent handlers in fresh-VM tasks.
export function prngFromInputId(inputId: string): () => number {
  return mulberry32(fnv1a32(inputId));
}
