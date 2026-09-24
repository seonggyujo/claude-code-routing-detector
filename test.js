#!/usr/bin/env node
/**
 * Feeds fake status line input to statusline.js and checks the model segment and the history log.
 * Run: node test.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'statusline.js');
const REPORT = path.join(__dirname, 'report.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-detector-'));

const OPUS = 'claude-opus-5-5';
const SONNET = 'claude-sonnet-5';
const NAMES = { [OPUS]: 'Opus 5.5', [SONNET]: 'Sonnet 5' };

const user = () => JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: 'hi' } });
let nextId = 0;
const assistant = (model, { id = 'msg_' + ++nextId, isSidechain = false, ts = new Date().toISOString() } = {}) =>
  JSON.stringify({
    type: 'assistant',
    isSidechain,
    uuid: 'uuid-' + ++nextId,
    timestamp: ts,
    message: { id, model, role: 'assistant', content: [] },
  });

/** A transcript plus its own config dir, so state and history never leak between cases. */
function scenario() {
  const home = fs.mkdtempSync(path.join(dir, 'case-'));
  const file = path.join(home, 'transcript.jsonl');
  const env = Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: home });
  return {
    file,
    write: lines => fs.writeFileSync(file, lines.map(l => l + '\n').join('')),
    append: lines => fs.appendFileSync(file, lines.map(l => l + '\n').join('')),
    appendRaw: text => fs.appendFileSync(file, text),
    /** Line 1 without colours. */
    line1(modelId) {
      return this.raw(modelId).replace(/\x1b\[[0-9;]*m/g, '').split('\n')[0];
    },
    /** Whole output, colours included. */
    raw(modelId) {
      const input = JSON.stringify({
        session_id: 'session-1',
        transcript_path: file,
        // Not a real directory, so line 1 has no git branch.
        workspace: { current_dir: '/work/project' },
        model: { id: modelId, display_name: NAMES[modelId.replace(/\[.*\]$/, '')] || modelId },
      });
      return execFileSync('node', [SCRIPT], { input, encoding: 'utf8', env });
    },
    /** Model segment only: the text before the first " · " separator on line 1. */
    show(modelId) {
      return this.line1(modelId).split(' · ')[0];
    },
    summary() {
      const f = path.join(home, 'routing-detector', 'summary.json');
      return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
    },
    history() {
      const f = path.join(home, 'routing-detector', 'history.jsonl');
      if (!fs.existsSync(f)) return [];
      return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
    },
    writeHistory: records => {
      fs.mkdirSync(path.join(home, 'routing-detector'), { recursive: true });
      fs.writeFileSync(path.join(home, 'routing-detector', 'history.jsonl'), records.map(r => JSON.stringify(r) + '\n').join(''));
    },
    report: args => execFileSync('node', [REPORT].concat(args || []), { encoding: 'utf8', env }),
  };
}

const matches = records => records.map(r => r.match);

const OLD_STATUS_LINE = { type: 'command', command: 'node old.js' };

/** A copy of the plugin (so a test can change its scripts like an update would) and a config dir. */
function pluginSetup(settings) {
  const plugin = fs.mkdtempSync(path.join(dir, 'plugin-'));
  fs.mkdirSync(path.join(plugin, 'scripts'));
  for (const f of ['statusline.js', 'report.js', 'scripts/setup.js']) fs.copyFileSync(path.join(__dirname, f), path.join(plugin, f));
  const config = fs.mkdtempSync(path.join(dir, 'config-'));
  const settingsFile = path.join(config, 'settings.json');
  if (settings) fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + '\n');
  const env = Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: config });
  const installed = path.join(config, 'routing-detector', 'statusline.js');
  return {
    plugin,
    config,
    env,
    installed,
    command: 'node "' + installed.split(path.sep).join('/') + '"',
    settings: () => JSON.parse(fs.readFileSync(settingsFile, 'utf8')),
    setup: args => execFileSync('node', [path.join(plugin, 'scripts', 'setup.js')].concat(args), { encoding: 'utf8', env }),
  };
}

const cases = [
  {
    name: 'first look: match (ignores [1m] suffix, subagent and <synthetic> entries), nothing recorded',
    run() {
      const s = scenario();
      s.write([user(), assistant(OPUS), assistant('claude-haiku-4-5-20251001', { isSidechain: true }), assistant('<synthetic>')]);
      assert.strictEqual(s.show(OPUS + '[1m]'), '✓ Opus 5.5');
      assert.strictEqual(s.show(OPUS + '[1m]'), '✓ Opus 5.5');
      assert.deepStrictEqual(s.history(), []);
    },
  },
  {
    name: 'first look: an earlier answer from another model waits instead of flagging',
    run() {
      const s = scenario();
      s.write([user(), assistant(OPUS), user(), assistant(SONNET)]);
      assert.strictEqual(s.show(OPUS), '… Opus 5.5');
      // Later runs must not go back and record the answers that were already there.
      assert.strictEqual(s.show(OPUS), '… Opus 5.5');
      assert.deepStrictEqual(s.history(), []);
    },
  },
  {
    name: 'new mismatch is flagged, stays flagged, and is recorded once',
    run() {
      const s = scenario();
      s.write([user()]);
      assert.strictEqual(s.show(OPUS), '… Opus 5.5');
      s.append([assistant(OPUS)]);
      assert.strictEqual(s.show(OPUS), '✓ Opus 5.5');
      s.append([user(), assistant(SONNET)]);
      const flagged = '⚠  selected:claude-opus-5-5 / actual:claude-sonnet-5';
      assert.strictEqual(s.show(OPUS), flagged);
      assert.strictEqual(s.show(OPUS), flagged);
      assert.deepStrictEqual(matches(s.history()), [true, false]);
    },
  },
  {
    name: '/model switch waits for the next answer and records nothing',
    run() {
      const s = scenario();
      s.write([user()]);
      s.show(OPUS);
      s.append([assistant(OPUS)]);
      assert.strictEqual(s.show(OPUS), '✓ Opus 5.5');
      assert.strictEqual(s.show(SONNET), '… Sonnet 5');
      assert.strictEqual(s.show(SONNET), '… Sonnet 5');
      assert.strictEqual(s.show(OPUS), '✓ Opus 5.5');
      s.append([user(), assistant(SONNET)]);
      assert.strictEqual(s.show(SONNET), '✓ Sonnet 5');
      assert.deepStrictEqual(matches(s.history()), [true, true]);
    },
  },
  {
    name: 'one response written over several lines and runs counts once',
    run() {
      const s = scenario();
      s.write([user()]);
      s.show(OPUS);
      s.append([assistant(OPUS, { id: 'msg_a' }), assistant(OPUS, { id: 'msg_a' })]);
      s.show(OPUS);
      s.append([user(), assistant(OPUS, { id: 'msg_a' })]);
      s.show(OPUS);
      s.show(OPUS);
      assert.deepStrictEqual(s.history().map(r => r.id), ['msg_a']);
    },
  },
  {
    name: 'every response in a turn is recorded, not only the last',
    run() {
      const s = scenario();
      s.write([user()]);
      s.show(OPUS);
      s.append([assistant(OPUS), user(), assistant(SONNET), user(), assistant(OPUS)]);
      assert.strictEqual(s.show(OPUS), '✓ Opus 5.5');
      assert.deepStrictEqual(matches(s.history()), [true, false, true]);
    },
  },
  {
    name: 'a line still being written is read after its newline arrives',
    run() {
      const s = scenario();
      s.write([user()]);
      s.show(OPUS);
      s.appendRaw(assistant(OPUS));
      assert.strictEqual(s.show(OPUS), '… Opus 5.5');
      assert.deepStrictEqual(s.history(), []);
      s.appendRaw('\n');
      assert.strictEqual(s.show(OPUS), '✓ Opus 5.5');
      assert.strictEqual(s.history().length, 1);
    },
  },
  {
    name: 'new session: transcript created after the first run, first answer is recorded',
    run() {
      const s = scenario();
      assert.strictEqual(s.show(OPUS), '… Opus 5.5');
      s.write([user(), assistant(OPUS)]);
      assert.strictEqual(s.show(OPUS), '✓ Opus 5.5');
      assert.strictEqual(s.history().length, 1);
    },
  },
  {
    name: 'history record fields',
    run() {
      const s = scenario();
      s.write([user()]);
      s.show(OPUS);
      s.append([assistant(SONNET, { id: 'msg_x', ts: '2026-09-24T01:00:00.000Z' })]);
      s.show(OPUS + '[1m]');
      assert.deepStrictEqual(s.history(), [
        {
          ts: '2026-09-24T01:00:00.000Z',
          session: 'session-1',
          cwd: '/work/project',
          selected: OPUS + '[1m]',
          actual: SONNET,
          id: 'msg_x',
          match: false,
        },
      ]);
    },
  },
  {
    name: 'status line shows the 30-day summary',
    run() {
      const s = scenario();
      s.write([user()]);
      assert.strictEqual(s.line1(OPUS), '… Opus 5.5');
      s.append([assistant(OPUS)]);
      assert.strictEqual(s.line1(OPUS), '✓ Opus 5.5 · 30d 0/1');
      // The mismatch count is red even at 0.
      assert.ok(s.raw(OPUS).includes('\x1b[38;5;203m0\x1b[0m'));
      s.append([user(), assistant(SONNET), user(), assistant(OPUS)]);
      assert.strictEqual(s.line1(OPUS), '✓ Opus 5.5 · 30d 1/3 ⚠');
    },
  },
  {
    name: 'summary is rebuilt from history when missing',
    run() {
      const s = scenario();
      const old = { ts: new Date(Date.now() - 86400000).toISOString(), session: 'x', selected: OPUS, actual: SONNET, id: 'old', match: false };
      s.writeHistory([old]);
      s.write([user()]);
      s.show(OPUS);
      s.append([assistant(OPUS)]);
      assert.strictEqual(s.line1(OPUS), '✓ Opus 5.5 · 30d 1/2 ⚠');
      // The report corrects counts that a race between two sessions could have lost.
      fs.writeFileSync(path.join(s.file, '..', 'routing-detector', 'summary.json'), JSON.stringify({ days: {} }));
      assert.strictEqual(s.line1(OPUS), '✓ Opus 5.5');
      s.report();
      assert.strictEqual(s.line1(OPUS), '✓ Opus 5.5 · 30d 1/2 ⚠');
    },
  },
  {
    name: 'answer outside the first read chunk',
    run() {
      const s = scenario();
      s.write([user(), assistant(OPUS), ...Array(3000).fill(user())]);
      assert.strictEqual(s.show(OPUS), '✓ Opus 5.5');
    },
  },
  {
    name: 'missing transcript',
    run() {
      const s = scenario();
      assert.strictEqual(s.show(OPUS), '… Opus 5.5');
    },
  },
  {
    name: 'report: counts the window, drops duplicates, lists mismatches',
    run() {
      const s = scenario();
      const now = Date.now();
      const at = daysAgo => new Date(now - daysAgo * 86400000).toISOString();
      const rec = (id, daysAgo, match) => ({
        ts: at(daysAgo),
        session: 's',
        cwd: '/work/project',
        selected: OPUS,
        actual: match ? OPUS : SONNET,
        id,
        match,
      });
      s.writeHistory([rec('a', 1, true), rec('a', 1, true), rec('b', 2, false), rec('c', 3, true), rec('d', 40, false)]);
      const out = s.report();
      assert.ok(out.startsWith('Last 30 days: 3 answers checked, 1 reported a model other than the one selected (33.33%).'), out);
      assert.ok(out.includes('selected claude-opus-5-5  reported claude-sonnet-5  /work/project'), out);
      const day = daysAgo => {
        const t = new Date(now - daysAgo * 86400000);
        return String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
      };
      // Daily chart from the first day with answers to today, scaled to the busiest day.
      const chart = out.split('\n').filter(l => /^\d\d-\d\d  /.test(l));
      assert.deepStrictEqual(chart, [
        day(3) + '  ' + '■'.repeat(20) + ' 1',
        day(2) + '  ' + '■'.repeat(20) + ' 1  ⚠ 1',
        day(1) + '  ' + '■'.repeat(20) + ' 1',
        day(0) + '  ' + ' '.repeat(20) + ' 0',
      ]);
      assert.ok(/Answers by reported model:\n  claude-opus-5-5  +2\n  claude-sonnet-5  +1\n/.test(out), out);
      assert.ok(s.report(['60']).startsWith('Last 60 days: 4 answers checked, 2 reported'));
      assert.deepStrictEqual(Object.values(s.summary().days).sort(), [[1, 0], [1, 0], [1, 1], [1, 1]].sort());
    },
  },
  {
    name: 'plugin: enable, sync after an update, disable restores the previous status line',
    run() {
      const p = pluginSetup({ model: 'opus', statusLine: OLD_STATUS_LINE });
      assert.strictEqual(p.setup(['enable']), 'Replaced your status line. Your own one was saved; /routing-detector:disable brings it back.\n');
      assert.deepStrictEqual(p.settings(), { model: 'opus', statusLine: { type: 'command', command: p.command, refreshInterval: 20 } });
      assert.strictEqual(fs.readFileSync(p.installed, 'utf8'), fs.readFileSync(SCRIPT, 'utf8'));
      assert.ok(fs.existsSync(path.join(p.config, 'routing-detector', 'report.js')));
      assert.ok(p.setup(['enable']).includes('already set up that way'));

      fs.appendFileSync(path.join(p.plugin, 'statusline.js'), '// update\n');
      p.setup(['sync']);
      assert.ok(fs.readFileSync(p.installed, 'utf8').endsWith('// update\n'));

      assert.strictEqual(p.setup(['disable']), 'Turned off. Your own status line is back.\n');
      assert.deepStrictEqual(p.settings(), { model: 'opus', statusLine: OLD_STATUS_LINE });
      assert.ok(!fs.existsSync(p.installed));
      // Not enabled any more, so a session start must not bring the copy back.
      p.setup(['sync']);
      assert.ok(!fs.existsSync(p.installed));
    },
  },
  {
    name: 'plugin session start: on without a status line, existing one left alone, note only once',
    run() {
      const none = pluginSetup(null);
      const first = none.setup(['sync']);
      assert.ok(first.includes('turned on its status line') && first.includes('/routing-detector:setup'), first);
      assert.deepStrictEqual(none.settings().statusLine, { type: 'command', command: none.command, refreshInterval: 20 });
      assert.ok(fs.existsSync(none.installed));
      assert.strictEqual(none.setup(['sync']), '');

      const mine = pluginSetup({ statusLine: OLD_STATUS_LINE });
      assert.ok(mine.setup(['sync']).includes("user's own status line was left unchanged"));
      assert.strictEqual(mine.setup(['sync']), '');
      assert.deepStrictEqual(mine.settings(), { statusLine: OLD_STATUS_LINE });
      assert.ok(!fs.existsSync(mine.installed));
    },
  },
  {
    name: 'plugin: setup.js never exits with 2, which would block the prompt when run from a hook',
    run() {
      const p = pluginSetup(null);
      const unknown = spawnSync('node', [path.join(p.plugin, 'scripts', 'setup.js'), 'no-such-action'], { encoding: 'utf8', env: p.env });
      assert.strictEqual(unknown.status, 1);
      assert.strictEqual(unknown.stdout, '');
    },
  },
  {
    name: 'plugin installed mid-session: the next message sets up the status line, once',
    run() {
      const p = pluginSetup(null);
      const first = p.setup(['first-run']);
      assert.ok(first.includes('turned on its status line') && first.includes('restart Claude Code'), first);
      assert.strictEqual(p.settings().statusLine.command, p.command);
      // Later messages stop early: even a removed statusLine is left for the next session start.
      fs.writeFileSync(path.join(p.config, 'settings.json'), '{}\n');
      assert.strictEqual(p.setup(['first-run']), '');
      assert.deepStrictEqual(p.settings(), {});
      p.setup(['sync']);
      assert.strictEqual(p.settings().statusLine.command, p.command);

      const mine = pluginSetup({ statusLine: OLD_STATUS_LINE });
      assert.ok(mine.setup(['first-run']).includes("user's own status line was left unchanged"));
      assert.strictEqual(mine.setup(['first-run']), '');
      assert.deepStrictEqual(mine.settings(), { statusLine: OLD_STATUS_LINE });
    },
  },
  {
    name: 'plugin setup choices with a status line of your own',
    run() {
      const p = pluginSetup({ statusLine: OLD_STATUS_LINE });
      assert.strictEqual(p.setup(['apply', 'merge']), 'Your status line stays, with a model-check line added below it.\n');
      assert.strictEqual(p.settings().statusLine.command, p.command + ' --merge');
      p.setup(['apply', 'replace']);
      assert.strictEqual(p.settings().statusLine.command, p.command);
      assert.strictEqual(p.setup(['status']), 'Current setup: the routing-detector status line (your own one is saved).\n');
      assert.strictEqual(p.setup(['apply', 'only-if-none']), 'Your own status line is back; routing-detector is not shown.\n');
      assert.deepStrictEqual(p.settings(), { statusLine: OLD_STATUS_LINE });
      assert.strictEqual(p.setup(['apply', 'off']), 'The routing-detector status line was not on, and it will stay off.\n');
      p.setup(['sync']);
      assert.deepStrictEqual(p.settings(), { statusLine: OLD_STATUS_LINE });
    },
  },
  {
    name: 'plugin setup choices without a status line of your own',
    run() {
      const p = pluginSetup(null);
      assert.strictEqual(p.setup(['status']), 'Current setup: no status line.\n');
      // Merge with nothing to merge with is the same as replace.
      // Claude Code shows a status line added after it started only once it restarts.
      assert.strictEqual(p.setup(['apply', 'merge']), 'Turned on the routing-detector status line. If it does not show up, restart Claude Code.\n');
      assert.strictEqual(p.settings().statusLine.command, p.command);
      assert.strictEqual(p.setup(['apply', 'only-if-none']), 'The routing-detector status line is already on.\n');
      assert.strictEqual(p.setup(['apply', 'off']), 'Turned off. statusLine was removed from settings.json.\n');
      assert.strictEqual(p.settings().statusLine, undefined);
    },
  },
  {
    name: 'plugin: turning it off sticks across sessions until it is turned on again',
    run() {
      const p = pluginSetup(null);
      p.setup(['sync']);
      assert.ok(p.settings().statusLine);
      p.setup(['disable']);
      p.setup(['sync']);
      p.setup(['sync']);
      assert.strictEqual(p.settings().statusLine, undefined);
      p.setup(['apply', 'only-if-none']);
      assert.strictEqual(p.settings().statusLine.command, p.command);
      p.setup(['disable']);
      p.setup(['enable']);
      p.setup(['sync']);
      assert.strictEqual(p.settings().statusLine.command, p.command);
    },
  },
  {
    name: 'plugin: every command in the setup skill is one setup.js accepts',
    run() {
      const skill = fs.readFileSync(path.join(__dirname, 'skills', 'setup', 'SKILL.md'), 'utf8');
      const modes = [...skill.matchAll(/setup\.js" apply (\S+)`/g)].map(m => m[1]);
      assert.deepStrictEqual(modes, ['only-if-none', 'merge', 'replace', 'off']);
      for (const mode of modes) {
        const p = pluginSetup({ statusLine: OLD_STATUS_LINE });
        assert.ok(!p.setup(['apply', mode]).startsWith('usage'), mode);
      }
    },
  },
  {
    name: 'merge mode: the user status line first, then the model check',
    run() {
      const scripts = fs.mkdtempSync(path.join(dir, 'mine-'));
      const script = (name, body) => {
        const f = path.join(scripts, name);
        fs.writeFileSync(f, body);
        return 'node "' + f.split(path.sep).join('/') + '"';
      };
      const echo = script('echo.js', 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>console.log("MINE "+JSON.parse(s).model.id))');
      const input = JSON.stringify({ model: { id: OPUS, display_name: 'Opus 5.5' }, transcript_path: path.join(scripts, 'none.jsonl'), workspace: { current_dir: '/work/project' } });
      const run = p => execFileSync('node', [p.installed, '--merge'], { input, encoding: 'utf8', env: p.env }).replace(/\x1b\[[0-9;]*m/g, '');

      const p = pluginSetup({ statusLine: { type: 'command', command: echo } });
      p.setup(['enable', 'merge']);
      assert.strictEqual(p.settings().statusLine.command, p.command + ' --merge');
      assert.strictEqual(run(p), 'MINE claude-opus-5-5\n… Opus 5.5');

      // A failing or slow status line of the user's own falls back to the full routing-detector one.
      const failing = pluginSetup({ statusLine: { type: 'command', command: script('fail.js', 'process.exit(1)') } });
      failing.setup(['enable', 'merge']);
      assert.strictEqual(run(failing), '… Opus 5.5');
      const slow = pluginSetup({ statusLine: { type: 'command', command: script('slow.js', 'setTimeout(()=>console.log("late"),3000)') } });
      slow.setup(['enable', 'merge']);
      const started = Date.now();
      assert.strictEqual(run(slow), '… Opus 5.5');
      assert.ok(Date.now() - started < 2500, 'waited ' + (Date.now() - started) + ' ms');
    },
  },
  {
    name: 'plugin setup: settings.json that is not valid JSON is left alone',
    run() {
      const config = fs.mkdtempSync(path.join(dir, 'config-'));
      const env = Object.assign({}, process.env, { CLAUDE_CONFIG_DIR: config });
      const broken = '{ "model": "opus", }\n';
      fs.writeFileSync(path.join(config, 'settings.json'), broken);
      let out = '';
      try {
        execFileSync('node', [path.join(__dirname, 'scripts', 'setup.js'), 'enable'], { encoding: 'utf8', env });
        assert.fail('enable should exit with an error');
      } catch (e) {
        out = String(e.stdout);
      }
      assert.ok(out.includes('not valid JSON'), out);
      assert.strictEqual(fs.readFileSync(path.join(config, 'settings.json'), 'utf8'), broken);
    },
  },
  {
    name: 'report: no history yet',
    run() {
      const s = scenario();
      assert.ok(s.report().startsWith('Last 30 days: no answers recorded.'));
    },
  },
];

let failed = 0;
try {
  for (const t of cases) {
    try {
      t.run();
      console.log('ok   ' + t.name);
    } catch (e) {
      failed++;
      console.log('FAIL ' + t.name + '\n     ' + String(e.message).split('\n').join('\n     '));
    }
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

process.exitCode = failed ? 1 : 0;
