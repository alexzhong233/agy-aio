// Terminal UI helpers. No npm dependencies.

import { createInterface } from 'node:readline/promises';

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

const colorEnabled = !(
  !process.stdout.isTTY ||
  Boolean(process.env.NO_COLOR) ||
  process.env.FORCE_COLOR === '0'
);

function wrap(open, close = '\x1b[0m') {
  return value => (colorEnabled ? `${open}${value == null ? '' : String(value)}${close}` : String(value ?? ''));
}

export const c = {
  bold: wrap('\x1b[1m'),
  dim: wrap('\x1b[2m'),
  red: wrap('\x1b[31m'),
  green: wrap('\x1b[32m'),
  yellow: wrap('\x1b[33m'),
  blue: wrap('\x1b[34m'),
  cyan: wrap('\x1b[36m'),
  gray: wrap('\x1b[90m'),
  reset: colorEnabled ? '\x1b[0m' : ''
};

function isWideCodePoint(cp) {
  return (
    cp >= 0x1100 &&
    (cp <= 0x115f ||
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f64f) ||
      (cp >= 0x1f900 && cp <= 0x1f9ff) ||
      (cp >= 0x20000 && cp <= 0x3fffd))
  );
}

function stripAnsi(text) {
  return String(text ?? '').replace(ANSI_PATTERN, '');
}

function displayWidth(text) {
  const plain = stripAnsi(text);
  let width = 0;
  for (const char of plain) {
    const cp = char.codePointAt(0);
    if (cp === 0x200d || (cp >= 0x0300 && cp <= 0x036f)) continue;
    width += isWideCodePoint(cp) ? 2 : 1;
  }
  return width;
}

function padRight(text, width) {
  const value = String(text ?? '');
  const missing = width - displayWidth(value);
  return missing > 0 ? `${value}${' '.repeat(missing)}` : value;
}

export function banner(title, subtitle = '') {
  const heading = String(title ?? '');
  const sub = String(subtitle ?? '');
  const innerWidth = Math.max(40, displayWidth(heading) + 4, displayWidth(sub) + 4);
  const row = text => c.cyan('│') + ' ' + padRight(text, innerWidth - 2) + ' ' + c.cyan('│');
  const lines = [
    c.cyan(`╭${'─'.repeat(innerWidth)}╮`),
    row(c.bold(heading))
  ];
  if (sub) lines.push(row(c.dim(sub)));
  lines.push(c.cyan(`╰${'─'.repeat(innerWidth)}╯`));
  console.log(lines.join('\n'));
}

export function section(title) {
  const label = `▸ ${String(title ?? '')}`;
  const width = Math.max(18, displayWidth(label) + 2);
  console.log(`\n${c.bold(c.cyan(label))}\n${c.dim('─'.repeat(width))}`);
}

export function info(msg) {
  console.log(`${c.cyan('i')} ${msg}`);
}

export function ok(msg) {
  console.log(`${c.green('+')} ${msg}`);
}

export function warn(msg) {
  console.log(`${c.yellow('!')} ${msg}`);
}

export function err(msg) {
  console.log(`${c.red('x')} ${msg}`);
}

export function step(index, total, msg) {
  console.log(`${c.dim(`[${index}/${total}]`)} ${msg}`);
}

export function table(rows, headers) {
  const matrix = [];
  if (Array.isArray(headers) && headers.length > 0) {
    matrix.push(headers.map(value => String(value ?? '')));
  }
  for (const row of Array.isArray(rows) ? rows : []) {
    matrix.push((Array.isArray(row) ? row : [row]).map(value => String(value ?? '')));
  }
  if (matrix.length === 0) return '';

  const columnCount = Math.max(...matrix.map(row => row.length));
  const widths = Array.from({ length: columnCount }, (_, index) =>
    Math.max(0, ...matrix.map(row => displayWidth(row[index])))
  );

  const formatRow = row =>
    row
      .map((cell, index) => padRight(cell, widths[index]))
      .join('  ')
      .replace(/\s+$/, '');

  const lines = [];
  if (Array.isArray(headers) && headers.length > 0) {
    lines.push(c.dim(formatRow(matrix[0])));
    lines.push(c.dim(widths.map(width => '─'.repeat(width)).join('  ')));
    for (let index = 1; index < matrix.length; index += 1) lines.push(formatRow(matrix[index]));
  } else {
    for (const row of matrix) lines.push(formatRow(row));
  }

  const output = lines.join('\n');
  console.log(output);
  return output;
}

export async function confirm(question, { yes = false, defaultYes = true } = {}) {
  if (yes === true) return true;
  if (!process.stdin.isTTY) return defaultYes;

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const hint = defaultYes ? 'Y/n' : 'y/N';
    const answer = String(await rl.question(`${question} [${hint}] `)).trim().toLowerCase();
    if (!answer) return defaultYes;
    if (answer === 'y' || answer === 'yes') return true;
    if (answer === 'n' || answer === 'no') return false;
    return defaultYes;
  } finally {
    rl.close();
  }
}
