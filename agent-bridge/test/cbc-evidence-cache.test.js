'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createReader, readJsonlSnapshot } = require('../lib/cbc-evidence-cache');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cbc-evidence-cache-'));
let serial = 0;
test.after(() => {
  const target = path.resolve(root);
  assert.ok(target.startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(target, { recursive: true, force: true });
});

const row = value => Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
function filePath(name = `journal-${++serial}.jsonl`) {
  const file = path.join(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return file;
}

test('module default reader returns parsed JSON objects', () => {
  const file = filePath();
  fs.writeFileSync(file, row({ moduleDefault: true }));
  assert.deepEqual(readJsonlSnapshot(file), [{ moduleDefault: true }]);
});

test('partial UTF-8 rows are retained raw and completed by an incremental append', () => {
  const file = filePath();
  const reads = [];
  const read = createReader({ onRead: value => reads.push(value) });
  const first = row({ id: 1 });
  const second = row({ id: 2, text: '東京猫' });
  const utf8 = Buffer.from('猫', 'utf8');
  const split = second.indexOf(utf8) + 1;
  fs.writeFileSync(file, Buffer.concat([first, second.subarray(0, split)]));

  assert.deepEqual(read(file), [{ id: 1 }]);
  assert.equal(reads[0].mode, 'full');
  assert.equal(reads[0].bytesParsed, first.length);
  fs.appendFileSync(file, second.subarray(split));
  assert.deepEqual(read(file), [{ id: 1 }, { id: 2, text: '東京猫' }]);
  assert.equal(reads[1].mode, 'append');
  assert.equal(reads[1].bytesRead, second.length);
  assert.equal(reads[1].bytesParsed, second.length);
  assert.deepEqual(read(file), [{ id: 1 }, { id: 2, text: '東京猫' }]);
  assert.equal(reads[2].mode, 'reuse');
  assert.equal(reads[2].bytesRead, 0);
  assert.equal(reads[2].bytesParsed, 0);
  assert.equal(Object.isFrozen(read(file)[0]), true);
  assert.equal(Object.isFrozen(read(file)), true);
});

test('unchanged snapshots reuse parsed rows and appends read and parse only the new suffix', () => {
  const file = filePath();
  const events = [];
  const read = createReader({ onRead: event => events.push(event) });
  const first = Buffer.concat([row({ id: 'a' }), row({ id: 'b' })]);
  const appended = row({ id: 'c' });
  fs.writeFileSync(file, first);

  assert.equal(read(file).length, 2);
  assert.equal(read(file).length, 2);
  fs.appendFileSync(file, appended);
  assert.deepEqual(read(file), [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  assert.deepEqual(events.map(event => event.mode), ['full', 'reuse', 'append']);
  assert.equal(events[0].bytesRead, first.length);
  assert.equal(events[0].bytesParsed, first.length);
  assert.equal(events[1].bytesRead, 0);
  assert.equal(events[1].bytesParsed, 0);
  assert.equal(events[2].bytesRead, appended.length);
  assert.equal(events[2].bytesParsed, appended.length);
});

test('complete malformed rows do not advance the cache and a repaired suffix is parsed', () => {
  const file = filePath();
  const events = [];
  const read = createReader({ onRead: event => events.push(event) });
  const prefix = row({ id: 'stable' });
  const malformed = Buffer.from('S3CR3T!\n', 'utf8');
  const repaired = row({ b: 2 });
  assert.equal(malformed.length, repaired.length);
  fs.writeFileSync(file, prefix);
  assert.deepEqual(read(file), [{ id: 'stable' }]);

  fs.appendFileSync(file, malformed);
  assert.throws(() => read(file), error => {
    assert.equal(error.code, 'CBC_EVIDENCE_INVALID_LINE');
    assert.ok(!error.message.includes('S3CR3T!'));
    assert.ok(error.message.length < 100);
    return true;
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].mode, 'full');

  fs.writeFileSync(file, Buffer.concat([prefix, repaired]));
  assert.deepEqual(read(file), [{ id: 'stable' }, { b: 2 }]);
  assert.equal(events[1].mode, 'append');
  assert.equal(events[1].bytesRead, repaired.length);
  assert.equal(events[1].bytesParsed, repaired.length);
});

test('read failures leave existing cache metadata unchanged', () => {
  const file = filePath();
  const events = [];
  const read = createReader({ onRead: event => events.push(event) });
  const content = row({ id: 'persisted' });
  fs.writeFileSync(file, content);
  assert.deepEqual(read(file), [{ id: 'persisted' }]);
  const moved = `${file}.temporarily-unavailable`;
  fs.renameSync(file, moved);
  assert.throws(() => read(file), { code: 'CBC_EVIDENCE_READ' });
  assert.equal(events.length, 1);
  fs.renameSync(moved, file);
  assert.deepEqual(read(file), [{ id: 'persisted' }]);
});

test('same-size metadata changes trigger a full reread so edits cannot hide behind the cache', () => {
  const file = filePath();
  const events = [];
  const read = createReader({ onRead: event => events.push(event) });
  const oldRow = row({ n: 1 });
  const newRow = row({ n: 2 });
  assert.equal(oldRow.length, newRow.length);
  fs.writeFileSync(file, oldRow);
  assert.deepEqual(read(file), [{ n: 1 }]);

  fs.writeFileSync(file, newRow);
  const changed = new Date(Date.now() + 5000);
  fs.utimesSync(file, changed, changed);
  assert.deepEqual(read(file), [{ n: 2 }]);
  assert.equal(events[1].mode, 'full');
  assert.equal(events[1].bytesRead, newRow.length);
  assert.equal(events[1].bytesParsed, newRow.length);
});

test('shrink and replacement are explicit errors instead of cache resets', () => {
  const file = filePath();
  const read = createReader();
  const content = Buffer.concat([row({ a: 1 }), row({ a: 2 })]);
  fs.writeFileSync(file, content);
  assert.equal(read(file).length, 2);

  fs.truncateSync(file, row({ a: 1 }).length);
  assert.throws(() => read(file), { code: 'CBC_EVIDENCE_FILE_SHRUNK' });

  fs.writeFileSync(file, content);
  const replacement = `${file}.replacement`;
  fs.writeFileSync(replacement, content);
  try {
    fs.renameSync(replacement, file);
  } catch {
    fs.rmSync(file, { force: true });
    fs.renameSync(replacement, file);
  }
  assert.throws(() => read(file), { code: 'CBC_EVIDENCE_FILE_REPLACED' });
});

test('oversized and symlink inputs are rejected before parsing or caching', t => {
  const target = filePath();
  const events = [];
  const read = createReader({ maxBytes: 16, onRead: event => events.push(event) });
  fs.writeFileSync(target, Buffer.alloc(17, 0x20));
  assert.throws(() => read(target), { code: 'CBC_EVIDENCE_TOO_LARGE' });
  assert.equal(events.length, 0);

  const link = filePath('symlink.jsonl');
  try { fs.symlinkSync(target, link, 'file'); }
  catch { t.skip('filesystem does not permit creating a test symlink'); return; }
  assert.throws(() => read(link), { code: 'CBC_EVIDENCE_FILE_TYPE' });
  assert.equal(events.length, 0);
});

test('default reader enforces the 64 MiB per-file bound', () => {
  const file = filePath();
  const read = createReader();
  fs.writeFileSync(file, Buffer.alloc(0));
  fs.truncateSync(file, 64 * 1024 * 1024 + 1);
  assert.throws(() => read(file), { code: 'CBC_EVIDENCE_TOO_LARGE' });
});

test('LRU retains the most recently used files and fully rereads an evicted file', () => {
  const events = [];
  const read = createReader({ maxFiles: 2, onRead: event => events.push(event) });
  const a = filePath('a.jsonl'), b = filePath('b.jsonl'), c = filePath('c.jsonl');
  fs.writeFileSync(a, row({ id: 'a' }));
  fs.writeFileSync(b, row({ id: 'b' }));
  fs.writeFileSync(c, row({ id: 'c' }));

  read(a);
  read(b);
  read(a);
  read(c);
  read(b);
  assert.deepEqual(events.map(event => event.mode), ['full', 'full', 'reuse', 'full', 'full']);
  assert.equal(events[4].bytesRead, row({ id: 'b' }).length);
});
