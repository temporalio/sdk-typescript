export function fillWithRandom(random: () => number, bytes: Uint8Array): Uint8Array {
  for (let i = 0; i < bytes.length; ++i) {
    bytes[i] = Math.floor(random() * 0x100);
  }
  return bytes;
}

export function uuid4FromRandom(random: () => number): string {
  const ho = (n: number, p: number) => n.toString(16).padStart(p, '0');
  const view = new DataView(new ArrayBuffer(16));
  view.setUint32(0, (random() * 0x100000000) >>> 0);
  view.setUint32(4, (random() * 0x100000000) >>> 0);
  view.setUint32(8, (random() * 0x100000000) >>> 0);
  view.setUint32(12, (random() * 0x100000000) >>> 0);
  view.setUint8(6, (view.getUint8(6) & 0xf) | 0x40);
  view.setUint8(8, (view.getUint8(8) & 0x3f) | 0x80);
  return `${ho(view.getUint32(0), 8)}-${ho(view.getUint16(4), 4)}-${ho(view.getUint16(6), 4)}-${ho(
    view.getUint16(8),
    4
  )}-${ho(view.getUint32(10), 8)}${ho(view.getUint16(14), 4)}`;
}
