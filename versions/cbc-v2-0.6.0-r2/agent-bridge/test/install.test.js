'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { sameTree, renderSkillText, OWNED_SKILLS } = require('../scripts/install');
const { ROOT } = require('../lib/util');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-install-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('installer owns only the delegation skill, never the official Herdr skill', () => {
  assert.deepEqual(OWNED_SKILLS, ['delegate-worker']);
});

test('skill installation binds the checkout path and uninstall recognizes the rendered copy', () => {
  const source = path.join(root, 'template');
  const target = path.join(root, 'rendered');
  fs.mkdirSync(source);
  fs.mkdirSync(target);
  const template = 'Coordinator: {{AGENT_BRIDGE_ROOT}}/bin/agent-bridge.js';
  const rendered = renderSkillText(template);
  assert.equal(rendered, `Coordinator: ${ROOT}/bin/agent-bridge.js`);
  fs.writeFileSync(path.join(source, 'SKILL.md'), template);
  fs.writeFileSync(path.join(target, 'SKILL.md'), rendered);
  assert.equal(sameTree(source, target), true);
  fs.appendFileSync(path.join(target, 'SKILL.md'), '\nUser changes');
  assert.equal(sameTree(source, target), false);
});

test('uninstall preserves a skill with modified references or extra user files', () => {
  const source = path.join(root, 'source');
  const target = path.join(root, 'target');
  for (const dir of [source, target]) {
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'SKILL.md'), 'same main file');
    fs.writeFileSync(path.join(dir, 'reference.md'), 'original');
  }
  assert.equal(sameTree(source, target), true);
  fs.writeFileSync(path.join(target, 'reference.md'), 'user edit');
  assert.equal(sameTree(source, target), false);
  fs.writeFileSync(path.join(target, 'reference.md'), 'original');
  fs.writeFileSync(path.join(target, 'user-note.md'), 'keep me');
  assert.equal(sameTree(source, target), false);
});
