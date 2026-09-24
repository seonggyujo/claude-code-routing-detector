#!/usr/bin/env node
/**
 * Plugin helper for the routing-detector status line.
 *
 *   node setup.js sync           SessionStart hook: turn the status line on when there is no other
 *                                one, and refresh the installed copy after a plugin update
 *   node setup.js first-run      UserPromptSubmit hook: "sync" once, so a plugin installed
 *                                mid-session sets up the status line before the next restart
 *   node setup.js apply <mode>   /routing-detector:setup choice:
 *                                  only-if-none  on only when there is no status line of your own
 *                                  merge         keep your status line and add a model-check line
 *                                  replace       use it instead of yours
 *                                  off           turn it off and keep it off
 *   node setup.js enable [merge] turn it on (replace, or merge)
 *   node setup.js disable        same as "apply off"
 *   node setup.js status         one line describing the current setup
 *
 * settings.json points at a copy in ~/.claude/routing-detector/, not into the plugin, because
 * the plugin's install path contains its version and changes on every update.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const SETTINGS_FILE = path.join(CONFIG_DIR, 'settings.json');
const DATA_DIR = path.join(CONFIG_DIR, 'routing-detector');
const PREVIOUS_FILE = path.join(DATA_DIR, 'previous-statusline.json');
// Written when the user turns the status line off, so the next session start leaves it off.
const DISABLED_FILE = path.join(DATA_DIR, 'disabled');
// Written after the one-time note at the first session start.
const NOTIFIED_FILE = path.join(DATA_DIR, 'notified');
// Written by the first sync, so the per-message hook can stop early.
const INITIALIZED_FILE = path.join(DATA_DIR, 'initialized');
// Claude Code reads statusLine when it starts: one added later shows only after a restart.
const RESTART = ' If it does not show up, restart Claude Code.';
const PLUGIN_ROOT = path.join(__dirname, '..');
const SCRIPTS = ['statusline.js', 'report.js'];
const INSTALLED = path.join(DATA_DIR, 'statusline.js');
// Forward slashes: the command runs in a shell, and backslashes break it on Windows.
const COMMAND = 'node "' + INSTALLED.split(path.sep).join('/') + '"';
const MERGE_COMMAND = COMMAND + ' --merge';

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** Copies the plugin's scripts to DATA_DIR when they differ. */
function copyScripts() {
  for (const name of SCRIPTS) {
    const source = fs.readFileSync(path.join(PLUGIN_ROOT, name), 'utf8');
    const target = path.join(DATA_DIR, name);
    let current = null;
    try {
      current = fs.readFileSync(target, 'utf8');
    } catch (e) {}
    if (current !== source) writeAtomic(target, source);
  }
}

/** Parsed settings plus the indent used in the file, so a rewrite keeps its style. */
function readSettings() {
  let text;
  try {
    text = fs.readFileSync(SETTINGS_FILE, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { settings: {}, indent: 2 };
    throw e;
  }
  const indentMatch = text.match(/^([ \t]+)"/m);
  let settings;
  try {
    settings = text.trim() ? JSON.parse(text) : {};
  } catch (e) {
    throw new Error(SETTINGS_FILE + ' is not valid JSON, so it was left unchanged: ' + e.message);
  }
  return { settings, indent: indentMatch ? indentMatch[1] : 2 };
}

function writeSettings({ settings, indent }) {
  writeAtomic(SETTINGS_FILE, JSON.stringify(settings, null, indent) + '\n');
}

/** "replace", "merge", or null when statusLine is not ours. */
function ourMode(statusLine) {
  const command = statusLine && statusLine.command;
  if (command === COMMAND) return 'replace';
  if (command === MERGE_COMMAND) return 'merge';
  return null;
}

function savedStatusLine() {
  try {
    return JSON.parse(fs.readFileSync(PREVIOUS_FILE, 'utf8')).statusLine || null;
  } catch (e) {
    return null;
  }
}

/** True when there is a status line of the user's own, current or saved, to merge with. */
function hasOwnStatusLine(file) {
  const current = file.settings.statusLine;
  if (!current) return false;
  return ourMode(current) ? Boolean(savedStatusLine()) : true;
}

/** Sets our statusLine. Returns false when it was already set that way. */
function turnOn(file, mode) {
  const current = file.settings.statusLine;
  if (ourMode(current) === mode) return false;
  // Keep whatever the user had, so turning off can put it back. Switching between our own
  // modes keeps the saved one.
  if (!ourMode(current)) {
    writeAtomic(PREVIOUS_FILE, JSON.stringify({ statusLine: current === undefined ? null : current }, null, 2) + '\n');
  }
  copyScripts();
  file.settings.statusLine = { type: 'command', command: mode === 'merge' ? MERGE_COMMAND : COMMAND, refreshInterval: 20 };
  writeSettings(file);
  return true;
}

/** Restores the saved statusLine. Returns null when statusLine was not ours. */
function turnOff(file) {
  if (!ourMode(file.settings.statusLine)) return null;
  const previous = savedStatusLine();
  if (previous) file.settings.statusLine = previous;
  else delete file.settings.statusLine;
  writeSettings(file);
  for (const name of SCRIPTS) fs.rmSync(path.join(DATA_DIR, name), { force: true });
  fs.rmSync(PREVIOUS_FILE, { force: true });
  return previous ? 'restored' : 'removed';
}

/** Applies one of the /routing-detector:setup choices and returns what happened. */
function apply(mode) {
  const file = readSettings();
  if (mode === 'off') {
    const result = turnOff(file);
    writeAtomic(DISABLED_FILE, '');
    if (result === 'restored') return 'Turned off. Your own status line is back.';
    if (result === 'removed') return 'Turned off. statusLine was removed from settings.json.';
    return 'The routing-detector status line was not on, and it will stay off.';
  }
  fs.rmSync(DISABLED_FILE, { force: true });
  const hadNone = !file.settings.statusLine;
  const own = hasOwnStatusLine(file);
  if (mode === 'only-if-none') {
    if (own) {
      const result = turnOff(file);
      return result ? 'Your own status line is back; routing-detector is not shown.' : 'You have your own status line, so it was left as is.';
    }
    return turnOn(file, 'replace') ? 'Turned on the routing-detector status line.' + (hadNone ? RESTART : '') : 'The routing-detector status line is already on.';
  }
  // Merge needs a status line of the user's own; without one it is the same as replace.
  if (mode === 'merge' && !own) mode = 'replace';
  if (!turnOn(file, mode)) return 'The routing-detector status line is already set up that way.';
  if (mode === 'merge') return 'Your status line stays, with a model-check line added below it.';
  return own
    ? 'Replaced your status line. Your own one was saved; /routing-detector:disable brings it back.'
    : 'Turned on the routing-detector status line.' + (hadNone ? RESTART : '');
}

function status() {
  const file = readSettings();
  const mode = ourMode(file.settings.statusLine);
  if (mode === 'merge') return 'Current setup: your own status line with a routing-detector line below it.';
  if (mode === 'replace') return 'Current setup: the routing-detector status line' + (savedStatusLine() ? ' (your own one is saved).' : '.');
  if (file.settings.statusLine) return 'Current setup: your own status line; routing-detector is not shown.';
  return 'Current setup: no status line.';
}

/**
 * Runs at every session start. Turns the status line on when there is no other one (unless the
 * user turned it off), and keeps an enabled install on the plugin's current version.
 * Prints only once, at the first session start: that output goes into Claude's context.
 */
function sync() {
  try {
    const file = readSettings();
    const current = file.settings.statusLine;
    let note = null;
    if (!fs.existsSync(DISABLED_FILE) && !current) {
      turnOn(file, 'replace');
      note =
        'routing-detector plugin: turned on its status line (there was none before). It shows after Claude Code restarts.' +
        ' In your next reply, tell the user once to restart Claude Code to see it, and that /routing-detector:setup changes how it is set up.';
    } else if (current && !ourMode(current)) {
      note =
        "routing-detector plugin: the user's own status line was left unchanged." +
        ' In your next reply, mention once that /routing-detector:setup can add a model-check line to it or replace it.';
    }
    if (ourMode(readSettings().settings.statusLine)) copyScripts();
    if (!fs.existsSync(INITIALIZED_FILE)) writeAtomic(INITIALIZED_FILE, '');
    if (note && !fs.existsSync(NOTIFIED_FILE)) {
      writeAtomic(NOTIFIED_FILE, '');
      console.log(note);
    }
  } catch (e) {}
}

/**
 * Runs on every message, so a plugin installed mid-session writes statusLine right away and one
 * restart shows it; session start hooks run too late for the session they start in.
 * After the first run this only checks one file.
 */
function firstRun() {
  if (!fs.existsSync(INITIALIZED_FILE)) sync();
}

const MODES = ['only-if-none', 'merge', 'replace', 'off'];
const [action, arg] = process.argv.slice(2);
try {
  if (action === 'sync') sync();
  else if (action === 'first-run') firstRun();
  else if (action === 'apply' && MODES.includes(arg)) console.log(apply(arg));
  else if (action === 'enable') console.log(apply(arg === 'merge' ? 'merge' : 'replace'));
  else if (action === 'disable') console.log(apply('off'));
  else if (action === 'status') console.log(status());
  else {
    // stderr and exit code 1, never 2: from a hook, exit code 2 blocks the user's prompt.
    console.error('usage: node setup.js sync | first-run | apply <' + MODES.join('|') + '> | enable [merge] | disable | status');
    process.exitCode = 1;
  }
} catch (e) {
  console.log('Failed: ' + e.message);
  process.exitCode = 1;
}
