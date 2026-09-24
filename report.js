#!/usr/bin/env node
/**
 * Summarises the answer history that statusline.js records: totals, a daily chart,
 * answers per reported model, and every mismatch.
 * Run: node report.js [days]   (default: 30)
 *
 * Also rebuilds summary.json, the daily counts the status line shows.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'routing-detector');
const HISTORY_FILE = path.join(DATA_DIR, 'history.jsonl');
const SUMMARY_FILE = path.join(DATA_DIR, 'summary.json');
const DAY_MS = 24 * 60 * 60 * 1000;
const BAR_WIDTH = 20;

const days = Number(process.argv[2] || 30);
if (!Number.isInteger(days) || days <= 0) {
  console.error('usage: node report.js [days]');
  process.exit(2);
}

const pad2 = n => String(n).padStart(2, '0');
function dayKey(ms) {
  const t = new Date(ms);
  return t.getFullYear() + '-' + pad2(t.getMonth() + 1) + '-' + pad2(t.getDate());
}
function localTime(ms) {
  const t = new Date(ms);
  return dayKey(ms) + ' ' + pad2(t.getHours()) + ':' + pad2(t.getMinutes());
}
const n = x => x.toLocaleString('en-US');

/** Every recorded answer, oldest first. Two status line runs can record the same answer; keep one. */
function readRecords() {
  let text;
  try {
    text = fs.readFileSync(HISTORY_FILE, 'utf8');
  } catch (e) {
    return [];
  }
  const seen = new Set();
  const records = [];
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
    records.push(Object.assign({}, rec, { time }));
  }
  return records.sort((a, b) => a.time - b.time);
}

/** Same format statusline.js writes: { days: { "YYYY-MM-DD": [checked, mismatched] } }. */
function rebuildSummary(records) {
  const summaryDays = {};
  const oldest = dayKey(Date.now() - 60 * DAY_MS);
  for (const r of records) {
    const key = dayKey(r.time);
    if (key < oldest) continue;
    const day = (summaryDays[key] = summaryDays[key] || [0, 0]);
    day[0]++;
    if (r.match === false) day[1]++;
  }
  try {
    const tmp = SUMMARY_FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ days: summaryDays }));
    fs.renameSync(tmp, SUMMARY_FILE);
  } catch (e) {}
}

const all = readRecords();
if (all.length) rebuildSummary(all);

const firstDay = dayKey(Date.now() - (days - 1) * DAY_MS);
const records = all.filter(r => dayKey(r.time) >= firstDay);
const period = 'Last ' + days + (days === 1 ? ' day' : ' days');
if (records.length === 0) {
  console.log(period + ': no answers recorded.');
  console.log('History file: ' + HISTORY_FILE);
  process.exit(0);
}

const mismatches = records.filter(r => r.match === false);
const share = ((mismatches.length / records.length) * 100).toFixed(2).replace(/\.?0+$/, '');
console.log(
  period + ': ' + n(records.length) + (records.length === 1 ? ' answer' : ' answers') + ' checked, ' +
    n(mismatches.length) + ' reported a model other than the one selected (' + share + '%).'
);

// Daily chart, from the first day with answers to today; days without answers stay as empty rows.
const perDay = new Map();
for (const r of records) {
  const key = dayKey(r.time);
  const day = perDay.get(key) || { checked: 0, mismatched: 0 };
  day.checked++;
  if (r.match === false) day.mismatched++;
  perDay.set(key, day);
}
const max = Math.max(...[...perDay.values()].map(d => d.checked));
const countWidth = String(max).length;
console.log('');
const today = dayKey(Date.now());
// Step by calendar date at noon, so a daylight saving change never skips or repeats a day.
const cursor = new Date(records[0].time);
cursor.setHours(12, 0, 0, 0);
for (; dayKey(cursor.getTime()) <= today; cursor.setDate(cursor.getDate() + 1)) {
  const key = dayKey(cursor.getTime());
  const day = perDay.get(key) || { checked: 0, mismatched: 0 };
  const filled = day.checked ? Math.max(1, Math.round((day.checked / max) * BAR_WIDTH)) : 0;
  console.log(
    key.slice(5) + '  ' + '■'.repeat(filled).padEnd(BAR_WIDTH) + ' ' + String(day.checked).padStart(countWidth) +
      (day.mismatched ? '  ⚠ ' + day.mismatched : '')
  );
}

const perModel = new Map();
for (const r of records) perModel.set(r.actual, (perModel.get(r.actual) || 0) + 1);
const models = [...perModel.entries()].sort((a, b) => b[1] - a[1]);
const nameWidth = Math.max(...models.map(([m]) => String(m).length));
const modelCountWidth = n(models[0][1]).length;
console.log('');
console.log('Answers by reported model:');
for (const [model, count] of models) {
  console.log('  ' + String(model).padEnd(nameWidth) + '  ' + n(count).padStart(modelCountWidth));
}

if (mismatches.length) {
  console.log('');
  console.log('Mismatches:');
  for (const r of mismatches) {
    console.log('  ' + localTime(r.time) + '  selected ' + r.selected + '  reported ' + r.actual + (r.cwd ? '  ' + r.cwd : ''));
  }
}
