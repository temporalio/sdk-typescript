/**
 * Dedicated PRNG plumbing for the plugin's run-id generation, isolated from the
 * Workflow's main deterministic PRNG.
 *
 * Read-only handlers (queries, update validators) must mint run ids without
 * touching the main PRNG: their PRNG consumption is never recorded in history,
 * so drawing from the main stream would perturb the sequence the next real task
 * sees on a cached instance and diverge from a fresh replay (where the handler
 * never ran). They need UNIQUENESS, not determinism, so they seed a per-call
 * PRNG from a Temporal-supplied unique input id.
 *
 * Internal: consumed only by sibling modules in this package.
 *
 * @module
 * @internal
 */

export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
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

/** Per-call PRNG seeded from a unique input id; orthogonal to the Workflow PRNG stream. */
export function prngFromInputId(inputId: string): () => number {
  return mulberry32(fnv1a32(inputId));
}

/**
 * Format a v4-shaped UUID (8-4-4-4-12 hex, version nibble `4`, variant bits
 * `10`) from successive `random()` draws. LangSmith `RunTree` ids must be UUIDs
 * because they are embedded verbatim in `dotted_order`.
 */
export function uuid4FromRandom(random: () => number): string {
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    b[i] = (random() * 256) & 0xff;
  }
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const hex = (n: number): string => n.toString(16).padStart(2, '0');
  const h = Array.from(b, hex).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
