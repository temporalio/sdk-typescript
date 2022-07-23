const startTime = new Date().getTime();

export async function date(): Promise<void> {
  console.log(startTime);
  console.log(Date.now());
  console.log(new Date() instanceof Date);
  console.log(new Date(0) instanceof Date);
  console.log(new Date(0).toJSON() === '1970-01-01T00:00:00.000Z');
  console.log(Date.UTC(1970, 0) === 0);
  console.log(Date.parse('1970-01-01') === 0);
}
