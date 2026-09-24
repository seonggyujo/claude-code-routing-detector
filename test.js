#!/usr/bin/env node
/**
 * Feeds fake status line input to statusline.js and checks the first line.
 * Run: node test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'statusline.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-detector-'));

const user = () => JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: 'hi' } });
const assistant = (model, isSidechain = false) =>
  JSON.stringify({ type: 'assistant', isSidechain, message: { model, role: 'assistant', content: [] } });

function transcript(name, lines) {
  const file = path.join(dir, name + '.jsonl');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

/** Model segment only: the text before the first " · " separator on line 1. */
function modelSegment(transcriptPath, modelId) {
  const input = JSON.stringify({
    transcript_path: transcriptPath,
    model: { id: modelId, display_name: 'Opus 5.5' },
  });
  const out = execFileSync('node', [SCRIPT], { input, encoding: 'utf8' });
  return out.replace(/\x1b\[[0-9;]*m/g, '').split('\n')[0].split(' · ')[0];
}

const cases = [
  {
    name: 'match (ignores [1m] suffix, subagent and <synthetic> entries)',
    file: transcript('match', [
      user(),
      assistant('claude-opus-5-5'),
      assistant('claude-haiku-4-5-20251001', true),
      assistant('<synthetic>'),
    ]),
    model: 'claude-opus-5-5[1m]',
    expect: '✓ Opus 5.5',
  },
  {
    name: 'mismatch',
    file: transcript('mismatch', [user(), assistant('claude-opus-5-5'), user(), assistant('claude-sonnet-5')]),
    model: 'claude-opus-5-5',
    expect: '⚠  selected:claude-opus-5-5 / actual:claude-sonnet-5',
  },
  {
    name: 'no response yet',
    file: transcript('noresp', [user()]),
    model: 'claude-opus-5-5',
    expect: '… Opus 5.5',
  },
  {
    name: 'answer outside the first read chunk',
    file: transcript('big', [user(), assistant('claude-opus-5-5'), ...Array(3000).fill(user())]),
    model: 'claude-opus-5-5',
    expect: '✓ Opus 5.5',
  },
  {
    name: 'missing transcript',
    file: path.join(dir, 'missing.jsonl'),
    model: 'claude-opus-5-5',
    expect: '… Opus 5.5',
  },
];

let failed = 0;
try {
  for (const t of cases) {
    const got = modelSegment(t.file, t.model);
    try {
      assert.strictEqual(got, t.expect);
      console.log('ok   ' + t.name);
    } catch (e) {
      failed++;
      console.log('FAIL ' + t.name + '\n     expected: ' + t.expect + '\n     got:      ' + got);
    }
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

process.exitCode = failed ? 1 : 0;
