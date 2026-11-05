'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_FILES = 8;

function fail(message, code = 'CBC_EVIDENCE_CACHE') {
  const error = new Error(`CBC evidence cache: ${message}`);
  error.code = code;
  throw error;
}

function cacheKey(file) {
  if (typeof file !== 'string' || !file) fail('file path is required');
  const resolved = path.resolve(file);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function metadata(stat) {
  return {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    size: Number(stat.size),
    mtime: (stat.mtimeNs ?? BigInt(Math.trunc(stat.mtimeMs * 1e6))).toString(),
    ctime: (stat.ctimeNs ?? BigInt(Math.trunc(stat.ctimeMs * 1e6))).toString(),
  };
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameMetadata(left, right) {
  return sameIdentity(left, right) && left.size === right.size
    && left.mtime === right.mtime && left.ctime === right.ctime;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function parseCompleteLines(bytes) {
  const lastNewline = bytes.lastIndexOf(0x0a);
  const completeBytes = lastNewline + 1;
  const records = [];
  let start = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });

  for (let end = 0; end < completeBytes; end += 1) {
    if (bytes[end] !== 0x0a) continue;
    let line = bytes.subarray(start, end);
    if (line.at(-1) === 0x0d) line = line.subarray(0, line.length - 1);
    start = end + 1;
    if (!line.length) continue;
    let record;
    try {
      const text = decoder.decode(line);
      if (!text.trim()) continue;
      record = JSON.parse(text);
    } catch {
      fail('complete JSONL record is invalid', 'CBC_EVIDENCE_INVALID_LINE');
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      fail('complete JSONL record is not an object', 'CBC_EVIDENCE_INVALID_LINE');
    }
    records.push(deepFreeze(record));
  }

  return { records, completeBytes };
}

function readRange(descriptor, start, length) {
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    let count;
    try { count = fs.readSync(descriptor, bytes, offset, length - offset, start + offset); }
    catch { fail('file read failed', 'CBC_EVIDENCE_READ'); }
    if (count === 0) fail('file changed while reading the measured snapshot', 'CBC_EVIDENCE_RACE');
    offset += count;
  }
  return bytes;
}

function createReader({ maxBytes = DEFAULT_MAX_BYTES, maxFiles = DEFAULT_MAX_FILES, onRead } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError('maxBytes must be a positive safe integer');
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) throw new TypeError('maxFiles must be a positive safe integer');
  const cache = new Map();

  function noteRead(file, mode, bytesRead, bytesParsed) {
    if (typeof onRead !== 'function') return;
    try { onRead({ file: path.resolve(file), mode, bytesRead, bytesParsed }); } catch {}
  }

  function touch(key, entry) {
    cache.delete(key);
    cache.set(key, entry);
  }

  function store(key, entry) {
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > maxFiles) cache.delete(cache.keys().next().value);
  }

  function readJsonlSnapshot(file) {
    const key = cacheKey(file);
    let pathStat;
    try { pathStat = fs.lstatSync(file, { bigint: true }); }
    catch { fail('file is unavailable', 'CBC_EVIDENCE_READ'); }
    if (!pathStat.isFile() || pathStat.isSymbolicLink()) fail('file is not a regular non-symlink file', 'CBC_EVIDENCE_FILE_TYPE');

    let descriptor;
    try { descriptor = fs.openSync(file, 'r'); }
    catch { fail('file is unavailable', 'CBC_EVIDENCE_READ'); }
    try {
      let openedStat;
      try { openedStat = fs.fstatSync(descriptor, { bigint: true }); }
      catch { fail('opened file metadata is unavailable', 'CBC_EVIDENCE_READ'); }
      if (!openedStat.isFile() || openedStat.dev !== pathStat.dev || openedStat.ino !== pathStat.ino) {
        fail('file identity changed while opening', 'CBC_EVIDENCE_FILE_REPLACED');
      }
      const current = metadata(openedStat);
      if (current.size > maxBytes) fail('file exceeds the configured size limit', 'CBC_EVIDENCE_TOO_LARGE');

      const prior = cache.get(key);
      if (prior) {
        if (!sameIdentity(prior.metadata, current)) fail('cached file was replaced', 'CBC_EVIDENCE_FILE_REPLACED');
        if (current.size < prior.metadata.size) fail('cached file became smaller', 'CBC_EVIDENCE_FILE_SHRUNK');
        if (sameMetadata(prior.metadata, current)) {
          touch(key, prior);
          noteRead(file, 'reuse', 0, 0);
          return prior.records;
        }
      }

      const mode = prior && current.size > prior.metadata.size ? 'append' : 'full';
      const start = mode === 'append' ? prior.completeOffset : 0;
      const bytesRead = current.size - start;
      const bytes = readRange(descriptor, start, bytesRead);
      let afterRead;
      try { afterRead = fs.fstatSync(descriptor, { bigint: true }); }
      catch { fail('opened file metadata changed during read', 'CBC_EVIDENCE_RACE'); }
      if (afterRead.size > BigInt(maxBytes)) fail('file exceeds the configured size limit', 'CBC_EVIDENCE_TOO_LARGE');
      if (afterRead.dev !== openedStat.dev || afterRead.ino !== openedStat.ino
          || afterRead.size < openedStat.size
          || afterRead.size === openedStat.size
            && (afterRead.mtimeNs !== openedStat.mtimeNs || afterRead.ctimeNs !== openedStat.ctimeNs)) {
        fail('file changed during the measured snapshot', 'CBC_EVIDENCE_RACE');
      }

      const parsed = parseCompleteLines(bytes);
      const records = Object.freeze(mode === 'append' ? prior.records.concat(parsed.records) : parsed.records);
      const entry = {
        metadata: current,
        completeOffset: start + parsed.completeBytes,
        records,
      };
      store(key, entry);
      noteRead(file, mode, bytesRead, parsed.completeBytes);
      return records;
    } finally {
      try { fs.closeSync(descriptor); } catch {}
    }
  }

  return readJsonlSnapshot;
}

const defaultReader = createReader();

function readJsonlSnapshot(file) {
  return defaultReader(file);
}

module.exports = { createReader, readJsonlSnapshot };
