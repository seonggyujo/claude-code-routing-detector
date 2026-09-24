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
 *
 * History: each new main-thread answer is checked once and appended to
 * ~/.claude/routing-detector/history.jsonl (see report.js).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');

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

function sameModel(a, b) {
  return baseModelId(a) === baseModelId(b);
}

/**
 * The answer on one transcript line, or null for anything else.
 * Skips sidechain (subagent) entries and "<synthetic>" placeholders.
 * One API response is written as several lines (thinking, text, tool_use) that share message.id.
 */
function answerOf(line) {
  if (!line.includes('"assistant"')) return null;
  let rec;
  try {
    rec = JSON.parse(line);
  } catch (e) {
    return null;
  }
  if (!rec || rec.type !== 'assistant' || rec.isSidechain) return null;
  const msg = rec.message || {};
  if (!msg.model || msg.model === '<synthetic>') return null;
  return { id: msg.id || rec.uuid || null, model: msg.model, ts: rec.timestamp || null };
}

/**
 * Most recent main-thread answer.
 * Reads the transcript backwards in growing chunks so large files stay cheap.
 */
function lastAnswer(fd, size) {
  const MAX_BYTES = 4 * 1024 * 1024;
  for (let chunk = 64 * 1024; ; chunk *= 4) {
    const len = Math.min(size, chunk, MAX_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    // The first line is usually cut mid-record unless we read from the file start.
    const start = len < size ? 1 : 0;
    for (let i = lines.length - 1; i >= start; i--) {
      const answer = answerOf(lines[i]);
      if (answer) return answer;
    }
    if (len >= size || len >= MAX_BYTES) return null;
  }
}

/**
 * Answers written after byte `from`, one per response.
 * Reads complete lines only, so a line still being written is picked up on the next run.
 */
function newAnswers(fd, from, size, lastId) {
  const buf = Buffer.alloc(size - from);
  fs.readSync(fd, buf, 0, buf.length, from);
  const end = buf.lastIndexOf(0x0a) + 1;
  const answers = [];
  let prevId = lastId;
  for (const line of buf.toString('utf8', 0, end).split('\n')) {
    const answer = answerOf(line);
    if (!answer || (answer.id && answer.id === prevId)) continue;
    answers.push(answer);
    prevId = answer.id;
  }
  return { answers, offset: from + end };
}

// ---------- history ----------
// Each answer is checked once, the first time the status line sees it, against the model selected
// at that moment. Checking only new answers keeps a later /model switch from counting as a
// mismatch. Per-transcript state holds the read offset and the latest answer.
const DATA_DIR = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'routing-detector');
const HISTORY_FILE = path.join(DATA_DIR, 'history.jsonl');
const STATE_DIR = path.join(DATA_DIR, 'state');
const SUMMARY_FILE = path.join(DATA_DIR, 'summary.json');
const SUMMARY_DAYS = 30;
const MAX_NEW_BYTES = 16 * 1024 * 1024;
const STATE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function stateFile(transcriptPath) {
  const key = crypto.createHash('sha1').update(transcriptPath).digest('hex').slice(0, 16);
  return path.join(STATE_DIR, key + '.json');
}

function readState(file, transcriptPath) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    return state && state.transcript === transcriptPath && Number.isFinite(state.offset) ? state : null;
  } catch (e) {
    return null;
  }
}

/** Replaces the file in one step, so a reader never sees half of it. */
function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    return false;
  }
}

const writeState = writeJson;

/** Drops state files of transcripts that have not been seen for a month. */
function pruneStates() {
  try {
    const cutoff = Date.now() - STATE_MAX_AGE_MS;
    for (const name of fs.readdirSync(STATE_DIR)) {
      const file = path.join(STATE_DIR, name);
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    }
  } catch (e) {}
}

function appendHistory(d, selected, answers) {
  const cwd = (d.workspace && d.workspace.current_dir) || d.cwd || null;
  const records = answers.map(a => ({
    ts: a.ts || new Date().toISOString(),
    session: d.session_id || null,
    cwd,
    selected,
    actual: a.model,
    id: a.id,
    match: sameModel(a.model, selected),
  }));
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(HISTORY_FILE, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  } catch (e) {
    return;
  }
  updateSummary(records);
}

// ---------- summary ----------
// Daily [checked, mismatched] counts, so the status line never reads the whole history.
// Two sessions writing at the same moment can drop a count; report.js rebuilds it from history.
const pad2 = n => String(n).padStart(2, '0');
function dayKey(ms) {
  const t = new Date(ms);
  return t.getFullYear() + '-' + pad2(t.getMonth() + 1) + '-' + pad2(t.getDate());
}

function readSummary() {
  try {
    const summary = JSON.parse(fs.readFileSync(SUMMARY_FILE, 'utf8'));
    return summary && summary.days && typeof summary.days === 'object' ? summary : null;
  } catch (e) {
    return null;
  }
}

function summaryFromHistory() {
  const days = {};
  const seen = new Set();
  let text = '';
  try {
    text = fs.readFileSync(HISTORY_FILE, 'utf8');
  } catch (e) {}
  for (const line of text.split('\n')) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch (e) {
      continue;
    }
    const time = Date.parse(rec && rec.ts);
    if (!Number.isFinite(time)) continue;
    if (rec.id) {
      const key = (rec.session || '') + '|' + rec.id;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    const day = (days[dayKey(time)] = days[dayKey(time)] || [0, 0]);
    day[0]++;
    if (rec.match === false) day[1]++;
  }
  return { days };
}

function updateSummary(records) {
  let summary = readSummary();
  if (!summary) {
    // First summary, or an unreadable one: count everything, including the records just appended.
    summary = summaryFromHistory();
  } else {
    for (const r of records) {
      const key = dayKey(Date.parse(r.ts) || Date.now());
      const day = (summary.days[key] = summary.days[key] || [0, 0]);
      day[0]++;
      if (!r.match) day[1]++;
    }
  }
  const oldest = dayKey(Date.now() - 2 * SUMMARY_DAYS * 24 * 60 * 60 * 1000);
  for (const key of Object.keys(summary.days)) if (key < oldest) delete summary.days[key];
  writeJson(SUMMARY_FILE, summary);
}

/** "30d 0/1,240": mismatches out of answers checked in the last 30 days. */
function summarySegment() {
  const summary = readSummary();
  if (!summary) return null;
  const since = dayKey(Date.now() - (SUMMARY_DAYS - 1) * 24 * 60 * 60 * 1000);
  let checked = 0;
  let mismatched = 0;
  for (const [key, counts] of Object.entries(summary.days)) {
    if (key < since || !Array.isArray(counts)) continue;
    checked += Number(counts[0]) || 0;
    mismatched += Number(counts[1]) || 0;
  }
  if (!checked) return null;
  // The mismatch count is always red so it stands out, even at 0.
  return (
    sage(SUMMARY_DAYS + 'd ') +
    red(mismatched.toLocaleString('en-US')) +
    sage('/' + checked.toLocaleString('en-US')) +
    (mismatched ? red(' ⚠') : '')
  );
}

/**
 * Records answers that appeared since the last run and returns
 * { last, checkedWith }: the latest answer and the model selected when it was checked
 * (null when it was already there before the status line started watching).
 */
function checkAnswers(d) {
  const transcriptPath = d.transcript_path;
  const selected = d.model && d.model.id;
  if (!transcriptPath || !selected) return null;
  const file = stateFile(transcriptPath);
  let fd;
  try {
    try {
      fd = fs.openSync(transcriptPath, 'r');
    } catch (e) {
      fd = undefined;
    }
    const size = fd === undefined ? 0 : fs.fstatSync(fd).size;
    let state = readState(file, transcriptPath);

    if (!state || size < state.offset || size - state.offset > MAX_NEW_BYTES) {
      // First look at this transcript (resumed session, fresh install) or too much to scan.
      // The model selected for the answers already there is unknown, so they are not recorded.
      state = {
        transcript: transcriptPath,
        offset: size,
        last: fd === undefined ? null : lastAnswer(fd, size),
        checkedWith: null,
      };
      pruneStates();
      // Without saved state every run lands here; compare against the current selection instead.
      if (!writeState(file, state)) state.checkedWith = selected;
      return state;
    }

    if (size > state.offset) {
      const found = newAnswers(fd, state.offset, size, state.last && state.last.id);
      if (found.answers.length) {
        appendHistory(d, selected, found.answers);
        state.last = found.answers[found.answers.length - 1];
        state.checkedWith = selected;
      }
      if (found.offset !== state.offset) {
        state.offset = found.offset;
        writeState(file, state);
      }
    }
    return state;
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
  const check = checkAnswers(d);
  const last = check && check.last;
  if (!last || !model.id) return moss('… ' + name);
  if (sameModel(last.model, model.id)) return leaf(bold('✓ ' + name));
  // The selection changed after this answer (e.g. /model), or the answer predates this watcher:
  // wait for the next answer instead of flagging it.
  if (!check.checkedWith || !sameModel(check.checkedWith, model.id)) return moss('… ' + name);
  // Two spaces: terminals that draw ⚠ as a wide emoji (Windows Terminal) cover the first one.
  return red(bold('⚠  selected:' + model.id + ' / actual:' + last.model));
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

  const summary = summarySegment();
  if (summary) head.push(summary);
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

// ---------- merge mode (--merge) ----------
/**
 * Output of the user's own status line, saved by the plugin's setup.js when merge mode was
 * turned on. Null when there is none, or when it fails or takes longer than a second.
 */
function previousStatusLine(raw, done) {
  let command;
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'previous-statusline.json'), 'utf8')).statusLine;
    command = saved && saved.type === 'command' && saved.command;
  } catch (e) {}
  // Never run ourselves: that would recurse.
  if (!command || command.includes('routing-detector/statusline.js')) return done(null);

  let finished = false;
  const finish = out => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    done(out ? out.replace(/\s+$/, '') || null : null);
  };
  // Asynchronous with our own timer: killing the shell on Windows leaves its child running
  // with the pipe open, and a synchronous call would wait for that child.
  const timer = setTimeout(() => finish(null), 1000);
  const run = useShell => {
    // Status line commands are written for a POSIX shell (Git Bash on Windows): "~", quotes, etc.
    const child = useShell
      ? spawn(command, { shell: true, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
      : spawn(process.env.SHELL || (process.platform === 'win32' ? 'bash' : '/bin/sh'), ['-c', command], {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'ignore'],
        });
    let out = '';
    let retried = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => (out += chunk));
    child.on('error', e => {
      if (e.code === 'ENOENT' && !useShell) {
        retried = true;
        run(true);
      } else finish(null);
    });
    child.on('close', code => retried || finish(code === 0 ? out : null));
    child.stdin.on('error', () => {});
    child.stdin.end(raw);
  };
  run(false);
}

/** The user's status line, then one line of ours: model check and 30-day summary. */
function renderMerged(d, raw, done) {
  previousStatusLine(raw, previous => {
    if (!previous) return done(render(d));
    const ours = [modelSegment(d)];
    const summary = summarySegment();
    if (summary) ours.push(summary);
    done(previous + '\n' + ours.join(SEP));
  });
}

// ---------- main ----------
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => (raw += chunk));
process.stdin.on('end', () => {
  // Exit once written: in merge mode a slow status line of the user's own may still be running.
  const write = out => process.stdout.write(out, () => process.exit(0));
  try {
    const d = JSON.parse(raw);
    if (process.argv.includes('--merge')) renderMerged(d, raw, write);
    else write(render(d));
  } catch (e) {
    write(moss('… statusline'));
  }
});
