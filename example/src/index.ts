type Logger = (a: string) => void;

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  Promise.resolve(666).then(console.log);
  // Promise.resolve().then(() => Date.now());
  // const cb = (a: string) => void console.log(a);
  // setTimeout((x: Logger, y: string) => void x(y), 500, cb, '500 ms timeout ended');
  // const timeout = setTimeout((x, y) => void x(y), 500, cb, 'I shouldn\'t be printed');
  // clearTimeout(timeout);
  console.log('sleeping');
  await sleep(1000);
  // console.log(timeout);
  console.log('new Date', new Date());
  console.log('Date.now', Date.now());
  console.log('Math.random', Math.random());
}
