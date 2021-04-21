const { readFileSync, writeFileSync } = require('fs');
const { resolve } = require('path');
const glob = require('glob');

const sourcePattern = resolve(__dirname, '../packages/**/*.ts');
const targetPattern = resolve(__dirname, '../packages/*/src/**/*.ts');

const snips = {};
const potentialSources = glob.sync(sourcePattern);
for (const source of potentialSources) {
  const content = readFileSync(source, 'utf8');
  const lines = content.split('\n');
  let snipId = undefined;
  let snip = [];
  for (const line of lines) {
    if (snipId !== undefined) {
      const end = line.match(/^.*@@@SNIPEND\s*$/);
      if (end) {
        snips[snipId] = snip;
        snipId === undefined;
      } else {
        snip.push(line);
      }
    } else {
      const start = line.match(/^.*@@@SNIPSTART\s+(.*)\s*$/);
      if (start) {
        snipId = start[1];
      }
    }
  }
}

const potentialTargets = glob.sync(targetPattern);
for (const target of potentialTargets) {
  const content = readFileSync(target, 'utf8');
  const lines = content.split('\n');
  let output = [];
  const numLines = lines.length;
  let snip = undefined;
  let foundSnip = false;
  for (let i = 0; i < numLines; ++i) {
    const line = lines[i];
    if (snip !== undefined) {
      const end = line.includes('<!--SNIPEND-->');
      if (end) {
        snip.end = i;
        console.log(snip);
        output.push(' * ```ts');
        output.push(...snips[snip.id].map((l) => ` * ${l}`));
        output.push(' * ```');
        snip = undefined;
      } else {
        output.push(line);
      }
    } else {
      const start = line.match(/<\!--SNIPSTART (\S+)-->/);
      if (start) {
        foundSnip = true;
        snip = { start: i, id: start[1] };
      } else {
        output.push(line);
      }
    }
  }
  if (foundSnip) {
    writeFileSync(target, output.join('\n'));
  }
}
