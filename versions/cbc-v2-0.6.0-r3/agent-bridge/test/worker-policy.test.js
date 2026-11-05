'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  POLICY_VERSION, SPEC_VERSION, normalizeTaskSpec, renderRoundInstructions,
  renderSubmissionPointer, renderTaskSpec, renderWorkerPolicy, writeWorkerPolicy,
} = require('../lib/worker-policy');

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bridge-policy-'));
const PROJECT_CONTEXT = '本项目是 Codex 主控的 Agent 桥接工程，执行端通过 Herdr 承载。';
const SESSION_ID = 'sess-verified-001';
const CONTEXT_HASH = 'a'.repeat(64);
const SEPARATOR = '=== 任务与验收要求 ===';

test.after(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function baseSpec(overrides) {
  return Object.assign({
    goal: '实现统一的执行协议与任务规格渲染',
    background: '主控需要一个可独立审查的纯模块',
    inputs: [{ path: 'agent-bridge/lib/worker-policy.js', purpose: '现有实现与导出接口' }],
    allowedChanges: ['agent-bridge/lib/worker-policy.js', 'agent-bridge/test/worker-policy.test.js'],
    requirements: ['提供 normalizeTaskSpec 与 renderTaskSpec', '稳定规则不写入单轮信息'],
    acceptance: [{ command: 'node --test agent-bridge/test/worker-policy.test.js', expected: '全部用例通过' }],
    deliverables: ['策略模块与测试', '交付报告'],
  }, overrides);
}

function baseTask(overrides) {
  return Object.assign({
    id: 'task-policy-case',
    agent: 'cbc',
    round: 1,
    cwd: path.join(stateDir, 'project'),
    stateDir,
    promptPath: path.join(stateDir, 'tasks', 'task-policy-case', 'round-001-prompt.md'),
    deliveryPath: path.join(stateDir, 'tasks', 'task-policy-case', 'deliveries', 'round-001.md'),
    taskSpec: baseSpec(),
  }, overrides);
}

function deltaTask(overrides) {
  return baseTask(Object.assign({
    round: 2,
    taskSpec: baseSpec({ projectContext: PROJECT_CONTEXT }),
    workerSessionId: SESSION_ID,
    promptContext: {
      mode: 'delta',
      sessionId: SESSION_ID,
      previousTaskId: 'task-policy-earlier',
      previousRound: 1,
      projectContextSha256: CONTEXT_HASH,
      delta: ['把稳定规则改为会话级协议', '新增任务规格渲染'],
    },
  }, overrides));
}

test('renderTaskSpec 呈现完整规格并始终带 task-spec-v1', () => {
  const text = renderTaskSpec(baseSpec({
    projectContext: PROJECT_CONTEXT,
    nonGoals: ['不改动其他模块'],
    steps: ['先读现有实现', '再补测试'],
    edgeCases: ['空数组必须报错'],
    examples: ['单条输入仍要渲染'],
    preserve: ['既有导出名称不变'],
    stopConditions: ['输入文件不可读时停止'],
    followupChanges: ['下次补充性能用例'],
  }));
  assert.match(text, /^# 任务规格（task-spec-v1）/);
  for (const section of [
    '## 目标', '## 背景', '## 项目稳定背景', '## 输入（路径与用途）', '## 允许修改（文件或目录）',
    '## 实施要求', '## 执行步骤', '## 不可改变项', '## 边界与示例', '## 客观验收（逐条执行并核对）',
    '## 输出与交付物', '## 明确不做', '## 阻塞与停止条件', '## 后续变更',
  ]) assert.ok(text.includes(section), '缺少章节：' + section);
  assert.ok(text.includes('agent-bridge/lib/worker-policy.js —— 现有实现与导出接口'));
  assert.ok(text.includes('命令：node --test agent-bridge/test/worker-policy.test.js'));
  assert.ok(text.includes('期望：全部用例通过'));
  assert.ok(text.includes('边界：空数组必须报错'));
  assert.ok(text.includes('示例：单条输入仍要渲染'));
  assert.ok(text.includes('1. 提供 normalizeTaskSpec 与 renderTaskSpec'));
  assert.equal(SPEC_VERSION, 'task-spec-v1');
  const normalized = normalizeTaskSpec(baseSpec({ stopConditions: ['不可读时停止'] }));
  assert.deepEqual(JSON.parse(JSON.stringify(normalized)), normalized);
  assert.equal(normalized.version, 'task-spec-v1');
  assert.deepEqual(normalized.nonGoals, []);
  assert.equal(normalized.projectContext, null);
});

test('缺少必填项、空字符串与错误类型逐项列出，不自行脑补', () => {
  assert.throws(() => normalizeTaskSpec({}), error => {
    for (const field of ['goal', 'background', 'inputs', 'allowedChanges', 'requirements', 'acceptance', 'deliverables']) {
      assert.match(error.message, new RegExp(field + ': 必填字段缺失'), '未报告必填项：' + field);
    }
    return true;
  });
  assert.throws(() => normalizeTaskSpec(baseSpec({ goal: '   ' })), /goal: 不能是空字符串/);
  assert.throws(() => normalizeTaskSpec(baseSpec({ inputs: [] })), /inputs: 至少需要一条/);
  assert.throws(() => normalizeTaskSpec(baseSpec({ acceptance: [{ command: 'npm test' }] })),
    /acceptance\[0\]\.expected: 必填字段缺失/);
  assert.throws(() => normalizeTaskSpec(baseSpec({ requirements: ['有效要求', ''] })),
    /requirements\[1\]: 不能是空字符串/);
  assert.throws(() => normalizeTaskSpec(baseSpec({ requirements: ['有效要求', 3] })),
    /requirements\[1\]: 必须是字符串/);
  assert.throws(() => normalizeTaskSpec(baseSpec({ inputs: 'agent-bridge/lib' })), /inputs: 必须是数组/);
  assert.throws(() => normalizeTaskSpec(baseSpec({ deliverables: '报告' })), /deliverables: 必须是数组/);
  assert.throws(() => renderTaskSpec(baseSpec({ goal: '' })), /goal/);
});

test('危险键与未知字段被拒绝，且不污染原型', () => {
  const polluted = JSON.parse('{"goal":"g","background":"b","inputs":[{"path":"p","purpose":"u"}],'
    + '"allowedChanges":["a"],"requirements":["r"],"acceptance":[{"command":"c","expected":"e"}],'
    + '"deliverables":["d"],"__proto__":{"polluted":true}}');
  assert.throws(() => normalizeTaskSpec(polluted), /危险键/);
  assert.equal({}.polluted, undefined);
  assert.throws(() => normalizeTaskSpec(baseSpec({ constructor: { evil: true } })), /危险键/);
  assert.throws(() => normalizeTaskSpec(baseSpec({ notes: '额外说明' })), /未知字段/);
  assert.throws(() => normalizeTaskSpec(baseSpec({
    acceptance: [{ command: 'npm test', expected: '通过', extra: '越界' }],
  })), /acceptance\[0\]\.extra: 未知字段/);
});

test('稳定规则对 cbc 与 zcode 一致，且不含任务ID、交付路径与单轮白名单', () => {
  const task = baseTask({
    id: 'task-policy-stable',
    allowedWritePaths: ['agent-bridge/lib/worker-policy.js'],
    deliveryPath: path.join(stateDir, 'tasks', 'task-policy-stable', 'deliveries', 'round-001.md'),
  });
  const cbc = renderWorkerPolicy(task);
  const zcode = renderWorkerPolicy(Object.assign({}, task, { agent: 'zcode' }));
  assert.equal(cbc, zcode);
  for (const phrase of ['worker-policy-v1', 'task-spec-v1', '不是操作系统沙箱', 'accept',
    'Git 写操作', '凭据', 'workerSessionId', '同一执行端（例如 cbc）不等于同一会话']) {
    assert.ok(cbc.includes(phrase), '缺少规则：' + phrase);
  }
  assert.ok(!cbc.includes('task-policy-stable'));
  assert.ok(!cbc.includes(path.resolve(task.deliveryPath)));
  assert.ok(!cbc.includes('agent-bridge/lib/worker-policy.js'));
  assert.ok(!cbc.includes('每轮完整重发'));
  assert.ok(!cbc.includes('同前'));
  assert.equal(POLICY_VERSION, 'worker-policy-v1');
});

test('首次派工使用 full：完整稳定规则、完整规格与本轮范围', () => {
  const task = baseTask({
    taskSpec: baseSpec({ projectContext: PROJECT_CONTEXT }),
    allowedWritePaths: ['agent-bridge/lib/worker-policy.js'],
    protectedPaths: ['agent-bridge/lib/util.js'],
    authorizedOperations: ['运行 npm test 并收集输出'],
  });
  const text = renderRoundInstructions(task);
  assert.ok(text.includes(renderWorkerPolicy(task).trimEnd()), '必须先给出完整稳定规则');
  assert.ok(text.includes('任务规格（task-spec-v1）'));
  assert.ok(text.includes(PROJECT_CONTEXT));
  assert.ok(text.includes('规格模式：full'));
  assert.ok(text.includes(path.resolve(task.cwd, 'agent-bridge/lib/worker-policy.js')));
  assert.ok(text.includes(path.resolve(task.cwd, 'agent-bridge/lib/util.js')));
  assert.ok(text.includes('主控显式授权：运行 npm test 并收集输出'));
  assert.ok(text.includes(path.resolve(task.deliveryPath)));
  assert.ok(!text.includes('已降级'));
  assert.ok(text.trimEnd().endsWith(SEPARATOR));
});

test('同一真实会话的合法 delta 只给差量与引用，不重复项目背景和全套规则', () => {
  const task = deltaTask({ taskSpec: baseSpec({ projectContext: PROJECT_CONTEXT }) });
  const text = renderRoundInstructions(task);
  assert.match(text, /^# 本轮任务（增量模式，task-spec-v1）/);
  assert.ok(text.includes('规格模式：delta'));
  assert.ok(text.includes(path.join(stateDir, 'tasks', task.id, 'worker-policy.md')));
  assert.ok(text.includes(SESSION_ID));
  assert.ok(text.includes('task-policy-earlier'));
  assert.ok(text.includes('第 1 轮'));
  assert.ok(text.includes(CONTEXT_HASH));
  assert.ok(text.includes('把稳定规则改为会话级协议'));
  assert.ok(text.includes('新增任务规格渲染'));
  assert.ok(text.includes('同一执行端不等于同一会话'));
  assert.ok(text.includes('命令：node --test agent-bridge/test/worker-policy.test.js'));
  assert.ok(text.includes('## 本轮交付物'));
  assert.ok(text.includes(path.resolve(task.deliveryPath)));
  assert.ok(!text.includes('## 必要底线'));
  assert.ok(!text.includes(PROJECT_CONTEXT));
  assert.ok(!text.includes(renderWorkerPolicy(task).trim()));
  assert.ok(text.trimEnd().endsWith(SEPARATOR));
  assert.ok(text.length < renderRoundInstructions(deltaTask({ promptContext: undefined })).length);
});

test('会话身份或引用不完整时降级 full 并注明原因', () => {
  const cases = [
    [{ sessionId: 'sess-other' }, /不一致/],
    [{ previousTaskId: undefined }, /previousTaskId/],
    [{ previousRound: undefined }, /previousRound/],
    [{ projectContextSha256: 'too-short' }, /projectContextSha256/],
    [{ delta: [] }, /差量/],
  ];
  for (const [patch, pattern] of cases) {
    const task = deltaTask({ promptContext: Object.assign({}, deltaTask().promptContext, patch) });
    const text = renderRoundInstructions(task);
    assert.ok(text.includes('已降级为完整模式'), '应降级：' + JSON.stringify(patch));
    assert.match(text, pattern);
    assert.ok(text.includes('## 必要底线'));
    assert.ok(text.includes('任务规格（task-spec-v1）'));
    assert.ok(text.includes(PROJECT_CONTEXT));
    assert.ok(text.includes('规格模式：full'));
    assert.ok(text.trimEnd().endsWith(SEPARATOR));
  }
  const wrongSession = deltaTask({ workerSessionId: 'sess-other' });
  assert.match(renderRoundInstructions(wrongSession), /不一致/);
  const noSpec = deltaTask({ taskSpec: undefined });
  assert.match(renderRoundInstructions(noSpec), /task\.taskSpec/);
  const unknownMode = deltaTask({ promptContext: Object.assign({}, deltaTask().promptContext, { mode: 'compact' }) });
  assert.match(renderRoundInstructions(unknownMode), /未知的上下文模式/);
  const noSession = deltaTask({ workerSessionId: undefined });
  assert.match(renderRoundInstructions(noSession), /workerSessionId/);
});

test('提交指针简短、含任务/轮次/模式与本轮文件，且不复制整套规则', () => {
  const task = deltaTask({ id: 'task-policy-pointer', promptPath: path.join(stateDir, 'tasks', 'task-policy-pointer', 'round-002-prompt.md') });
  const pointer = renderSubmissionPointer(task);
  assert.ok(pointer.includes('task-policy-pointer'));
  assert.ok(pointer.includes('第 2 轮'));
  assert.ok(pointer.includes('规格模式：delta'));
  assert.ok(pointer.includes(path.resolve(task.promptPath)));
  for (const phrase of ['Codex 唯一主控', 'accept/rework/dispatch', '不泄露凭据', '不是 OS 沙箱', '读取本轮任务文件']) {
    assert.ok(pointer.includes(phrase), '指针缺少边界：' + phrase);
  }
  assert.ok(!pointer.includes('## 必要底线'));
  assert.ok(pointer.length < 900, '指针应保持简短，实际长度 ' + pointer.length);
  assert.equal(pointer.trim().split('\n').length, 4);

  const fullPointer = renderSubmissionPointer(baseTask({ promptPath: path.join(stateDir, 'first.md') }));
  assert.ok(fullPointer.includes('规格模式：full'));
  assert.throws(() => renderSubmissionPointer(baseTask({ promptPath: '' })), /promptPath/);
  assert.throws(() => renderSubmissionPointer({ id: 'task-policy-pointer' }), /promptPath/);
});

test('writeWorkerPolicy 落盘稳定规则、哈希对应真实文件且只设置策略字段', () => {
  const id = 'task-policy-write';
  const dir = path.join(stateDir, 'tasks', id);
  const task = baseTask({
    id,
    stateDir,
    allowedWritePaths: ['agent-bridge/lib/worker-policy.js'],
    deliveryPath: path.join(dir, 'deliveries', 'round-001.md'),
  });
  const file = writeWorkerPolicy(task);
  assert.equal(file, path.join(dir, 'worker-policy.md'));
  const disk = fs.readFileSync(file);
  assert.equal(task.workerPolicySha256, crypto.createHash('sha256').update(disk).digest('hex'));
  assert.equal(task.workerPolicyPath, file);
  assert.equal(task.workerPolicyVersion, 'worker-policy-v1');
  const content = disk.toString('utf8');
  assert.equal(content, renderWorkerPolicy(task));
  assert.ok(!content.includes(task.id));
  assert.ok(!content.includes(path.resolve(task.deliveryPath)));
  assert.ok(!content.includes('agent-bridge/lib/worker-policy.js'));
  assert.ok(!fs.existsSync(path.join(dir, 'task.json')));
  assert.deepEqual(Object.keys(task).sort(), [
    'agent', 'allowedWritePaths', 'cwd', 'deliveryPath', 'id', 'promptPath', 'round', 'stateDir',
    'taskSpec', 'workerPolicyPath', 'workerPolicySha256', 'workerPolicyVersion',
  ]);
});

test('非法 task.id 被拒绝，不创建目录也不越界写文件', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bridge-policy-bad-'));
  try {
    for (const id of ['../escape', 'task/../escape', '..', '.', 'x', 'Bad-Id', 'task..x', '']) {
      const task = { id, stateDir: root, cwd: root };
      assert.throws(() => writeWorkerPolicy(task), /Invalid task id/, String(id));
      assert.equal(task.workerPolicyPath, undefined);
    }
    assert.deepEqual(fs.readdirSync(root), []);
    assert.ok(!fs.existsSync(path.join(root, 'escape')));
    assert.throws(() => writeWorkerPolicy({ id: 'task-policy-nostate', cwd: root }), /stateDir/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
