'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { config, homePath, readJson, loadTask, saveTask, writeJsonAtomic, now, event, processAlive } = require('./util');
const { leasePath } = require('./worker-lease');
const { renderSubmissionPointer } = require('./worker-policy');
const { api, resultPayload, startWatcher } = require('./herdr');
const { proveWorkerProcess } = require('./windows-worker-process');
const { nativeCbcBinary, resolveCbcExecutable, checkDialog } = require('./cbc-prompt');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const time = value => typeof value === 'number' ? value : Date.parse(value);
function requireProof(condition, message) { if (!condition) throw new Error('CBC reconciliation refused: ' + message); }
function jsonLines(file) {
  requireProof(fs.statSync(file).size <= 64 * 1024 * 1024, 'evidence exceeds 64 MiB bound');
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(x => x.trim()).map(JSON.parse);
}

function inspect(task, { nativeTranscript, transcriptRoot = homePath('.codebuddy', 'projects') } = {}) {
  requireProof(task.agent === 'cbc' && task.status === 'submission_unknown' && task.round > 0
    && task.submission?.status === 'uncertain', 'task is not an uncertain CBC submission');
  requireProof(task.workerSessionId && /^[a-zA-Z0-9:_-]+$/.test(task.workerSessionId)
    && task.paneId && task.terminalId && task.workerStartedAt, 'native binding is incomplete');
  const root = path.join(task.stateDir, 'tasks', task.id), round = String(task.round).padStart(3, '0');
  const taskFile = path.join(root, 'task.json');
  requireProof(JSON.stringify(readJson(taskFile)) === JSON.stringify(task), 'task snapshot changed');
  requireProof(typeof task.submission.attemptId === 'string' && /^[a-zA-Z0-9-]+$/.test(task.submission.attemptId), 'attempt ID missing');
  const attemptFile = path.join(root, `round-${round}-submission-${task.submission.attemptId}.json`);
  requireProof(task.submission.file && samePath(task.submission.file, attemptFile), 'attempt path mismatch');
  const attempt = readJson(attemptFile);
  requireProof(attempt.agent === 'cbc' && attempt.status === 'uncertain' && attempt.attemptId === task.submission.attemptId
    && ['taskId', 'round', 'herdrSession', 'paneId', 'terminalId', 'workerSessionId'].every(key =>
      attempt[key] === (key === 'taskId' ? task.id : task[key])), 'attempt binding mismatch');
  const attempts = fs.readdirSync(root).filter(f => f.startsWith(`round-${round}-submission-`) && f.endsWith('.json'))
    .map(f => readJson(path.join(root, f))).filter(x => x.status !== 'rejected-before-input');
  requireProof(attempts.length === 1 && attempts[0].attemptId === attempt.attemptId, 'ambiguous round attempts');
  requireProof(task.promptPath && samePath(task.promptPath, path.join(root, `round-${round}-prompt.md`)), 'prompt path mismatch');
  requireProof(sha(fs.readFileSync(task.promptPath)) === attempt.promptSha256, 'prompt bytes changed');
  const leaseFile = leasePath(task.stateDir, task.herdrSession, task.paneId), lease = readJson(leaseFile);
  requireProof(lease.taskId === task.id && lease.paneId === task.paneId && lease.herdrSession === task.herdrSession
    && lease.terminalId === task.terminalId && lease.workerSessionId === task.workerSessionId
    && lease.workerStartedAt === task.workerStartedAt, 'lease mismatch');
  requireProof(!require('./worker-scheduling').taskList(task.stateDir).some(x => x.id !== task.id && x.agent === 'cbc'
    && x.workerSessionId === task.workerSessionId && !['accepted', 'cancelled'].includes(x.status)), 'native session has another owner');
  requireProof(nativeTranscript && path.basename(nativeTranscript) === task.workerSessionId + '.jsonl', 'supply the exact native transcript filename');
  const resolvedRoot = fs.realpathSync(transcriptRoot), transcript = fs.realpathSync(nativeTranscript);
  const relative = path.relative(resolvedRoot, transcript);
  requireProof(relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    && !fs.lstatSync(nativeTranscript).isSymbolicLink(), 'transcript is outside the native project store');
  const records = jsonLines(transcript), started = time(attempt.createdAt);
  requireProof(Number.isFinite(started), 'attempt time invalid');
  const users = records.filter(x => x.type === 'message' && x.role === 'user' && time(x.timestamp) >= started);
  const pointer = renderSubmissionPointer(task);
  const matches = users.filter(x => Array.isArray(x.content) && x.content.length === 1
    && x.content[0].type === 'input_text' && x.content[0].text === pointer);
  requireProof(matches.length === 1 && users[0] === matches[0], 'no unique post-attempt native user message');
  const user = matches[0], nextUserAt = users[1] ? time(users[1].timestamp) : Infinity;
  requireProof(user.sessionId === task.workerSessionId && typeof user.cwd === 'string' && samePath(user.cwd, task.cwd)
    && Array.isArray(user.content) && user.content.length === 1 && user.content[0].type === 'input_text'
    && user.content[0].text === pointer, 'native user message is not the exact submitted pointer');
  const hooks = jsonLines(path.join(task.stateDir, 'hook-events.ndjson'));
  const scoped = hooks.filter(x => x.herdrSession === task.herdrSession && (x.paneId === task.paneId
    && x.terminalId === task.terminalId || x.sessionId === task.workerSessionId) && time(x.timestamp) >= started
    && time(x.timestamp) < nextUserAt);
  requireProof(scoped.length > 0 && scoped.every(x => x.identityBound === true && x.taskId === task.id
    && x.round === task.round && x.sessionId === task.workerSessionId && x.paneId === task.paneId
    && x.terminalId === task.terminalId), 'newer, foreign or unbound Hook identity');
  const submit = scoped.find(x => x.name === 'UserPromptSubmit');
  requireProof(submit && time(submit.timestamp) >= time(user.timestamp), 'bound native submission Hook missing');
  // A Stop followed by more same-turn activity is not the terminal boundary. / Stop之后仍有同轮活动时不能把该Stop当终态边界。
  let latest = scoped.at(-1), stopped = latest.name === 'Stop';
  if (task.cbcTurnProtocol === 1) {
    const turn = require('./cbc-turn').readTurn(task, { nativeTranscript: transcript, nativeTranscriptRoot: transcriptRoot });
    requireProof(['active', 'blocked', 'stopped'].includes(turn.state), `native turn is ${turn.state}: ${turn.reason || ''}`);
    stopped = turn.state === 'stopped';
    latest = stopped ? { name: 'Stop', timestamp: turn.stopAt } : scoped.at(-1);
  }
  requireProof(stopped || users.length === 1, 'later native input before a bound terminal Stop');
  requireProof(stopped || ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'Notification'].includes(latest.name),
    'latest Hook cannot attest current execution');
  let delivery = null;
  if (stopped) {
    requireProof(time(latest.timestamp) >= time(submit.timestamp), 'Stop predates submission');
    const expected = path.join(root, 'deliveries', `round-${round}.md`);
    requireProof(task.deliveryPath && samePath(task.deliveryPath, expected), 'delivery binding mismatch');
    if (fs.existsSync(expected)) {
      const stat = fs.statSync(expected);
      requireProof(stat.size > 0 && stat.mtimeMs <= time(latest.timestamp), 'delivery is empty or changed after Stop');
      delivery = { sha256: sha(fs.readFileSync(expected)), bytes: stat.size };
    }
  }
  return { state: 'executed', phase: stopped ? 'stopped' : latest.name === 'Notification' ? 'blocked' : 'active',
    taskId: task.id, round: task.round, attemptId: attempt.attemptId, promptSha256: attempt.promptSha256,
    taskSha256: sha(fs.readFileSync(taskFile)), attemptSha256: sha(fs.readFileSync(attemptFile)), leaseSha256: sha(fs.readFileSync(leaseFile)),
    nativeMessageSha256: sha(JSON.stringify(user)), pointerSha256: sha(pointer), nativeTranscript: transcript,
    submissionAt: new Date(time(user.timestamp)).toISOString(), hook: { name: latest.name, at: latest.timestamp },
    laterNativeInputAt: users.length > 1 ? new Date(time(users.at(-1).timestamp)).toISOString() : null,
    delivery, scope: 'native-turn-only; not technical acceptance or detached-job termination' };
}

async function liveProof(task, proof, { call = api, proveProcess = proveWorkerProcess } = {}) {
  const payload = async args => resultPayload(await call(task.herdrSession, args));
  const pane = (await payload(['pane', 'get', task.paneId]))?.pane;
  const agent = (await payload(['agent', 'get', task.paneId]))?.agent;
  const panes = (await payload(['pane', 'list']))?.panes, agents = (await payload(['agent', 'list']))?.agents;
  const allowed = proof.phase === 'observing' ? ['idle', 'done', 'working', 'blocked']
    : proof.phase === 'stopped' ? ['idle', 'done'] : proof.phase === 'blocked' ? ['blocked'] : ['working'];
  requireProof(pane?.pane_id === task.paneId && pane.terminal_id === task.terminalId
    && agent?.pane_id === task.paneId && agent.terminal_id === task.terminalId && agent.agent === 'codebuddy'
    && (!task.agentName || agent.name === task.agentName) && allowed.includes(agent.agent_status), 'current worker does not match execution evidence');
  requireProof(Array.isArray(panes) && Array.isArray(agents) && panes.filter(x => x.terminal_id === task.terminalId).length === 1
    && panes.filter(x => x.pane_id === task.paneId).length === 1 && agents.filter(x => x.pane_id === task.paneId).length === 1,
    'live ownership inventory ambiguous');
  for (const x of [pane, agent, ...panes, ...agents]) {
    if (x.agent_session == null) continue;
    const own = x.pane_id === task.paneId || x.terminal_id === task.terminalId;
    requireProof(typeof x.agent_session.value === 'string' && (!own || x.agent_session.value === task.workerSessionId)
      && (x.agent_session.value !== task.workerSessionId || x.pane_id === task.paneId && x.terminal_id === task.terminalId), 'live native reference conflicts');
  }
  if (proof.phase === 'stopped') {
    const visible = await payload(['pane', 'read', task.paneId, '--source', 'visible']);
    checkDialog(typeof visible === 'string' ? visible : visible?.read?.text ?? visible?.text);
  }
  const info = await payload(['pane', 'process-info', '--pane', task.paneId]);
  const binary = resolveCbcExecutable(nativeCbcBinary(task, {}), { nodeExecutable: task.nodeExecutable || process.execPath });
  const workerProcess = await proveProcess({ kind: 'cbc', processInfo: info?.process_info || info,
    executablePath: binary.executablePath, scriptPath: binary.scriptPath, expectedPid: task.workerPid });
  requireProof(workerProcess?.kind === 'cbc' && Number.isSafeInteger(workerProcess.pid) && Number.isSafeInteger(workerProcess.shellPid)
    && Number.isFinite(time(workerProcess.processStartedAt))
    && time(workerProcess.processStartedAt) <= time(proof.submissionAt), 'current process did not execute the submitted turn');
  return workerProcess;
}

async function recover(task, options = {}, deps = {}) {
  requireProof(!task.watcherPid || !processAlive(task.watcherPid), 'existing watcher must be reconciled first');
  const before = JSON.stringify(task), proof = inspect(task, options);
  const firstProcess = await liveProof(task, proof, deps);
  const again = inspect(task, options);
  requireProof(JSON.stringify(again) === JSON.stringify(proof), 'execution evidence changed during reconciliation');
  const secondProcess = await liveProof(task, proof, deps);
  requireProof(JSON.stringify(firstProcess) === JSON.stringify(secondProcess)
    && JSON.stringify(loadTask(task.id)) === before, 'worker or task changed during reconciliation');
  // Keep the uncertain attempt immutable; save a separate reconciliation receipt. / 不改写不确定尝试，另存对账回执。
  const file = path.join(task.stateDir, 'tasks', task.id,
    `round-${String(task.round).padStart(3, '0')}-cbc-reconciliation-${proof.attemptId}.json`);
  writeJsonAtomic(file, { ...proof, processProof: secondProcess, recordedAt: now() });
  task.submission = { ...task.submission, status: 'observed', reconciliationFile: file,
    reconciledFrom: 'uncertain', nativeTurnObserved: true };
  task.observerGeneration = (task.observerGeneration || 0) + 1; task.error = null; task.watcherPid = null;
  if (proof.laterNativeInputAt) task.contextInvalidatedAt = proof.laterNativeInputAt;
  task.status = proof.phase === 'stopped' ? proof.delivery ? 'review_pending' : 'delivery_missing'
    : proof.phase === 'blocked' ? 'blocked' : 'running';
  if (task.status === 'review_pending' || task.status === 'delivery_missing') task.settlementSeq = (task.settlementSeq || 0) + 1;
  task.history ||= [];
  task.history.push({ round: task.round, status: task.status, timestamp: now(), source: 'cbc-native-reconciliation', attemptId: proof.attemptId });
  saveTask(task); event(task, 'cbc_submission_reconciled', { phase: proof.phase, noPromptSent: true });
  if (task.status === 'running') { task.watcherPid = (deps.startWatcher || startWatcher)(task.id); saveTask(task); }
  if (task.status === 'review_pending' && !proof.laterNativeInputAt) require('./worker-context').recordContext(task);
  return task;
}

module.exports = { inspect, recover, liveProof };
