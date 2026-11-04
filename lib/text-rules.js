// Small text rules for the main process, separate from Electron so they can be
// tested directly.

// Detects a model stuck repeating one fragment. Returns the fragment, or null.
// Real output can repeat too (a zero-filled array, a divider, base64 runs), so
// very short units need a far longer run before they count as a spiral.
function detectRepetitionLoop(text) {
  const RUN_CHARS = 4000;
  const SHORT_UNIT_RUN_CHARS = 20000;
  const SHORT_UNIT = 8;
  const MIN_REPEATS = 20;
  const MAX_UNIT = 200;
  const tail = text.slice(-(SHORT_UNIT_RUN_CHARS + MAX_UNIT));
  const n = tail.length;
  for (let p = 1; p <= MAX_UNIT; p++) {
    if (n < p * MIN_REPEATS) break;
    const unit = tail.slice(n - p);
    if (!unit.trim()) continue;
    let reps = 1;
    for (let i = n - p; i - p >= 0 && tail.slice(i - p, i) === unit; i -= p) reps++;
    const needed = p < SHORT_UNIT ? SHORT_UNIT_RUN_CHARS : RUN_CHARS;
    if (reps >= MIN_REPEATS && reps * p >= needed) return unit;
  }
  return null;
}

// Splits streamed process output into complete lines. Windows programs end lines
// with \r\n, so comparing a raw line to a marker fails there without the trim.
function splitOutputLines(buffer) {
  const parts = buffer.split('\n');
  const rest = parts.pop();
  return { lines: parts.map(l => l.replace(/\r$/, '')), rest };
}

// Quotes one argument for a command run through cmd.exe. Inside double quotes,
// spaces and & | stay literal. A double quote inside the value would end the
// quoting and let the rest reach the shell, so that's refused outright.
function quoteWindowsArg(arg) {
  const text = String(arg ?? '');
  if (/^[\w\-.:\\/=@+,]+$/.test(text)) return text;
  if (text.includes('"')) throw new Error(`can't safely pass an argument containing a double quote on Windows: ${text}`);
  return `"${text.replace(/(\\+)$/, '$1$1')}"`;
}

function encodePowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

module.exports = { detectRepetitionLoop, splitOutputLines, quoteWindowsArg, encodePowerShell };
