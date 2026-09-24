#!/usr/bin/env node
/**
 * Claude Code status line
 *
 * Line 1: model check (selected vs. model that actually answered) · effort · git branch · session cost
 * Line 2: context window usage
 * Line 3: 5-hour limit usage
 * Line 4: 7-day (weekly) limit usage
 *
 * Input: status line JSON on stdin (see `statusLine` in ~/.claude/settings.json).
 * Must stay fast and must never throw: any failure degrades to a plain fallback line.
 */
'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');

// ---------- ansi helpers ----------
const ESC = '\x1b[';
const R = ESC + '0m';
const c = (code, s) => ESC + code + 'm' + s + R;
const bold = s => c('1', s);
// Green palette. Red stays only for real alarms (model mismatch, limits at 90%+).
const leaf = s => c('38;5;120', s); // bright: selected model OK
const green = s => c('38;5;42', s); // main: branch, healthy bars
const mint = s => c('38;5;158', s); // pale: effort
const lime = s => c('38;5;148', s); // yellow-green: usage warning
const moss = s => c('38;5;71', s); // muted: labels, waiting state
const sage = s => c('38;5;108', s); // soft: cost, token counts, reset times
const pine = s => c('38;5;28', s); // dark: separators
const deep = s => c('38;5;22', s); // darkest: empty bar cells
const red = s => c('38;5;203', s);

const SEP = pine(' · ');
const LABEL_WIDTH = 4;

// ---------- formatting helpers ----------
function tokens(n) {
  if (!Number.isFinite(n)) return '?';
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return Math.round(n / 1e3) + 'k';
  return String(n);
}

function money(n) {
  if (n >= 100) return '$' + n.toFixed(0);
  if (n >= 10) return '$' + n.toFixed(1);
  return '$' + n.toFixed(2);
}

/** Time until an epoch-seconds timestamp: 3d 4h / 2h 13m / 47m / now */
function until(epochSeconds) {
  if (!Number.isFinite(epochSeconds)) return null;
  const ms = epochSeconds * 1000 - Date.now();
  if (ms <= 0) return 'now';
  const totalMin = Math.floor(ms / 60000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return d + 'd ' + h + 'h';
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm';
}

function pctColor(pct) {
  if (pct >= 90) return red;
  if (pct >= 70) return lime;
  return green;
}

function bar(pct, width) {
  const p = Math.max(0, Math.min(100, pct));
  const filled = Math.round((p / 100) * width);
  // Same glyph for filled and empty cells; only the colour differs. "■" leaves a gap on every side,
  // so cells stay separate and stacked bars do not merge the way full blocks (█) do.
  return pctColor(p)('■'.repeat(filled)) + deep('■'.repeat(width - filled));
}

/** One aligned meter row: "5h  ■■■■■■■■■■■■■■  23% reset 2h 13m" */
function meter(label, pct, width, trailing) {
  const p = Math.round(pct);
  return (
    moss(label.padEnd(LABEL_WIDTH)) +
    bar(p, width) +
    ' ' +
    pctColor(p)(String(p).padStart(3) + '%') +
    (trailing ? ' ' + trailing : '')
  );
}

// ---------- model check ----------
/** "claude-opus-5-5[1m]" and "claude-haiku-4-5-20251001" compare as their base ids. */
function baseModelId(id) {
  return String(id)
    .replace(/\[.*\]$/, '')
    .replace(/-\d{8}$/, '')
    .toLowerCase();
}

/**
 * Model recorded on the most recent main-thread assistant message.
 * Reads the transcript backwards in growing chunks so large files stay cheap.
 * Skips sidechain (subagent) entries and "<synthetic>" placeholders.
 */
function lastAnsweredModel(transcriptPath) {
  if (!transcriptPath) return null;
  let fd;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const size = fs.fstatSync(fd).size;
    const MAX_BYTES = 4 * 1024 * 1024;
    for (let chunk = 64 * 1024; ; chunk *= 4) {
      const len = Math.min(size, chunk, MAX_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString('utf8').split('\n');
      // The first line is usually cut mid-record unless we read from the file start.
      const start = len < size ? 1 : 0;
      for (let i = lines.length - 1; i >= start; i--) {
        const line = lines[i];
        if (!line.includes('"assistant"')) continue;
        let rec;
        try {
          rec = JSON.parse(line);
        } catch (e) {
          continue;
        }
        if (rec.type !== 'assistant' || rec.isSidechain) continue;
        const model = rec.message && rec.message.model;
        if (model && model !== '<synthetic>') return model;
      }
      if (len >= size || len >= MAX_BYTES) return null;
    }
  } catch (e) {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch (e) {}
    }
  }
}

function modelSegment(d) {
  const model = d.model || {};
  const name = model.display_name || model.id || 'model?';
  const actual = lastAnsweredModel(d.transcript_path);
  if (!actual || !model.id) return moss('… ' + name);
  if (baseModelId(actual) === baseModelId(model.id)) return leaf(bold('✓ ' + name));
  // Two spaces: terminals that draw ⚠ as a wide emoji (Windows Terminal) cover the first one.
  return red(bold('⚠  selected:' + model.id + ' / actual:' + actual));
}

// ---------- git ----------
function gitBranch(cwd) {
  const git = args =>
    execFileSync('git', ['--no-optional-locks'].concat(args), {
      cwd,
      encoding: 'utf8',
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
  try {
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    if (!branch) return null;
    // Detached HEAD reports the literal "HEAD", so show the commit instead.
    if (branch !== 'HEAD') return branch;
    return '(' + git(['rev-parse', '--short', 'HEAD']) + ')';
  } catch (e) {
    return null;
  }
}

// ---------- render ----------
function render(d) {
  const cols = Number(process.env.COLUMNS) || 120;
  const narrow = cols < 80;
  const barWidth = narrow ? 8 : 14;
  const lines = [];

  // --- line 1: model check · effort · branch · cost ---
  const head = [modelSegment(d)];

  const effort = d.effort && d.effort.level;
  if (effort) head.push(mint(effort));

  const branch = gitBranch((d.workspace && d.workspace.current_dir) || d.cwd || process.cwd());
  if (branch) head.push(green('⎇ ' + branch));

  const cost = d.cost && Number(d.cost.total_cost_usd);
  if (Number.isFinite(cost)) head.push(sage(money(cost)));
  lines.push(head.join(SEP));

  // --- line 2: context window ---
  const cw = d.context_window;
  if (cw && Number.isFinite(Number(cw.used_percentage)) && cw.used_percentage !== null) {
    const detail = narrow
      ? ''
      : sage(tokens(Number(cw.total_input_tokens)) + ' / ' + tokens(Number(cw.context_window_size)));
    lines.push(meter('ctx', Number(cw.used_percentage), barWidth, detail));
  }

  // --- lines 3-4: rate limit windows (only for Pro/Max, after the first response) ---
  const rl = d.rate_limits || {};
  for (const [key, label] of [['five_hour', '5h'], ['seven_day', '7d']]) {
    const w = rl[key];
    if (!w || w.used_percentage === null || !Number.isFinite(Number(w.used_percentage))) continue;
    const reset = until(Number(w.resets_at));
    lines.push(meter(label, Number(w.used_percentage), barWidth, reset ? sage('reset ' + reset) : ''));
  }

  return lines.join('\n');
}

// ---------- main ----------
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => (raw += chunk));
process.stdin.on('end', () => {
  let out;
  try {
    out = render(JSON.parse(raw));
  } catch (e) {
    out = moss('… statusline');
  }
  process.stdout.write(out);
});
