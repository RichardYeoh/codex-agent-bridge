#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ROOT, ensureDir, homePath, now, readJson, writeJsonAtomic } = require('../lib/util');
const OWNED_SKILLS = ['delegate-worker'];

const events = {
  SessionStart: 'startup|resume|clear|compact',
  UserPromptSubmit: null,
  PreToolUse: null,
  PostToolUse: null,
  PostToolUseFailure: null,
  Stop: null,
  Notification: 'permission_prompt',
  SessionEnd: null,
};

function hookCommand() {
  return `node "${path.join(ROOT, 'hooks', 'herdr-codebuddy.js').replace(/\\/g, '/')}"`;
}

function removeHook(entries, command) {
  return entries.flatMap(entry => {
    if (!Array.isArray(entry?.hooks)) return [entry];
    const hooks = entry.hooks.filter(hook => hook.command !== command);
    if (hooks.length === entry.hooks.length) return [entry];
    return hooks.length ? [{ ...entry, hooks }] : [];
  });
}

function copyTree(source, destination) {
  if (!fs.existsSync(source)) return;
  fs.cpSync(source, destination, { recursive: true, force: true });
}

function backupTree(source, destination) {
  if (fs.existsSync(source)) fs.cpSync(source, destination, { recursive: true });
}

function renderSkillText(text) {
  return text.replaceAll('{{AGENT_BRIDGE_ROOT}}', ROOT);
}

function sameTree(source, target) {
  if (!fs.existsSync(source) || !fs.existsSync(target)) return false;
  const left = fs.lstatSync(source);
  const right = fs.lstatSync(target);
  // Preserve modified resources and refuse symlink traversal. / 保留已修改资源，不跟随符号链接。
  if (left.isSymbolicLink() || right.isSymbolicLink()) return false;
  if (left.isFile() && right.isFile()) {
    const expected = source.endsWith('.md')
      ? Buffer.from(renderSkillText(fs.readFileSync(source, 'utf8'))) : fs.readFileSync(source);
    return expected.equals(fs.readFileSync(target));
  }
  if (!left.isDirectory() || !right.isDirectory()) return false;
  const names = fs.readdirSync(source).sort();
  if (JSON.stringify(names) !== JSON.stringify(fs.readdirSync(target).sort())) return false;
  return names.every(name => sameTree(path.join(source, name), path.join(target, name)));
}

function installSkills(backupDir) {
  const sourceRoot = path.join(ROOT, 'skills');
  if (!fs.existsSync(sourceRoot)) return [];
  const targetRoot = homePath('.agents', 'skills');
  const installed = [];
  for (const name of OWNED_SKILLS) {
    const source = path.join(sourceRoot, name, 'SKILL.md');
    if (!fs.existsSync(source)) continue;
    const target = path.join(targetRoot, name);
    backupTree(target, path.join(backupDir, 'agents-skills', name));
    ensureDir(target);
    copyTree(path.dirname(source), target);
    for (const file of ['SKILL.md', 'references/task-brief-template.md']) {
      const installedFile = path.join(target, file);
      if (fs.existsSync(installedFile)) {
        fs.writeFileSync(installedFile, renderSkillText(fs.readFileSync(installedFile, 'utf8')));
      }
    }
    installed.push(target);
  }
  return installed;
}

function main() {
  const action = process.argv[2] || 'install';
  if (action === 'install-skills') {
    const backupDir = ensureDir(path.join(ROOT, 'backups', `${now().replace(/[:.]/g, '-')}-skills`));
    const skills = installSkills(backupDir);
    writeJsonAtomic(path.join(backupDir, 'manifest.json'), { timestamp: now(), action, skills });
    process.stdout.write(`${JSON.stringify({ ok: true, action, skills, backupDir }, null, 2)}\n`);
    return;
  }
  if (!['install', 'uninstall'].includes(action)) throw new Error('Usage: node scripts/install.js [install|install-skills|uninstall]');
  const settingsFile = homePath('.codebuddy', 'settings.json');
  const originalText = fs.readFileSync(settingsFile, 'utf8');
  const settings = JSON.parse(originalText);
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('settings.json must contain an object');
  if (settings.hooks !== undefined && (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks))) {
    throw new Error('settings.hooks must be an object');
  }

  const command = hookCommand();
  const hooks = { ...(settings.hooks || {}) };
  for (const [name, matcher] of Object.entries(events)) {
    const entries = settings.hooks?.[name] ?? [];
    if (!Array.isArray(entries)) throw new Error(`settings.hooks.${name} must be an array`);
    const remaining = removeHook(entries, command);
    if (action === 'install') {
      const entry = { hooks: [{ type: 'command', command }] };
      if (matcher) entry.matcher = matcher;
      hooks[name] = [...remaining, entry];
    } else if (remaining.length) {
      hooks[name] = remaining;
    } else if (entries.length) {
      delete hooks[name];
    }
  }

  const stamp = now().replace(/[:.]/g, '-');
  const backupDir = path.join(ROOT, 'backups', `${stamp}-${action}`);
  const updated = { ...settings, hooks };
  if (action === 'uninstall' && settings.hooks === undefined && Object.keys(hooks).length === 0) delete updated.hooks;
  const changed = JSON.stringify(settings) !== JSON.stringify(updated);
  if (changed) {
    ensureDir(backupDir);
    fs.copyFileSync(settingsFile, path.join(backupDir, 'codebuddy-settings.json'));
    writeJsonAtomic(settingsFile, updated);
  }

  let skills = [];
  if (action === 'install') {
    ensureDir(backupDir);
    skills = installSkills(backupDir);
  } else {
    for (const name of OWNED_SKILLS) {
      const source = path.join(ROOT, 'skills', name);
      const target = path.join(homePath('.agents', 'skills'), name);
      if (sameTree(source, target)) {
        fs.rmSync(target, { recursive: true, force: true });
      }
    }
  }

  writeJsonAtomic(path.join(backupDir, 'manifest.json'), {
    timestamp: now(), action, settingsFile, settingsChanged: changed, hookCommand: command, skills,
  });
  process.stdout.write(`${JSON.stringify({ ok: true, action, backupDir, settingsChanged: changed, skills }, null, 2)}\n`);
  if (action === 'install') process.stdout.write('Restart CodeBuddy CLI sessions to load hooks; restart Codex to discover skills.\n');
}

if (require.main === module) try {
  main();
} catch (error) {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
}

module.exports = { sameTree, renderSkillText, OWNED_SKILLS };
