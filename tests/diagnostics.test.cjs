'use strict';
// Node >= 18; no dependencies. VM hooks exist only in this test, never in the userscript.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'chatgpt_prompt_safety_net.user.js'), 'utf8');
const LOG = 'cgpt_psn_diagnostics_v1';
const HISTORY = 'cgpt_psn_history_v3';
const LAST = 'cgpt_psn_last_sent_v3';
const DRAFT = 'cgpt_psn_draft_v3:c:private-conversation-id';

function harness(options = {}) {
  let now = options.now ?? 1_800_000_000_000;
  const storage = options.storage || new Map();
  const failures = { read: new Set(), write: new Set(), silent: new Set() };
  const writes = [], warnings = [], timers = new Map(), downloads = [];
  let nextTimer = 0;
  const editor = { value: '', contains: node => node === editor,
    getBoundingClientRect: () => ({ width: 600, height: 100 }) };
  const state = { editor };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const fail = () => { const error = new Error('PRIVATE_PROMPT token=SECRET https://private.example');
    error.name = 'QuotaExceededError'; throw error; };
  const document = {
    readyState: 'loading', body: null, visibilityState: 'visible',
    getElementById: () => null,
    querySelector: selector => selector.startsWith('#prompt-textarea') ? state.editor : null,
    querySelectorAll: () => [], addEventListener() {},
    createElement: () => ({ style: {}, click() { downloads.push(this.download); }, remove() {} }),
  };
  const sandbox = {
    Date: Clock, TextEncoder, Blob, URL, Map, Set, Math, JSON,
    navigator: { onLine: true }, document,
    location: { pathname: '/c/private-conversation-id', href: 'https://chatgpt.com/c/private-conversation-id?token=SECRET' },
    window: { addEventListener() {} },
    console: { warn: (...args) => warnings.push(args) },
    setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id), setInterval: () => ++nextTimer, clearInterval() {},
    GM_getValue(key, fallback) {
      if (failures.read.has(key)) fail();
      return storage.has(key) ? structuredClone(storage.get(key)) : fallback;
    },
    GM_setValue(key, value) {
      if (failures.write.has(key)) fail();
      if (!failures.silent.has(key)) storage.set(key, structuredClone(value));
      writes.push({ key, value });
    },
    GM_deleteValue: key => storage.delete(key), GM_listValues: () => [...storage.keys()],
  };
  let program = source;
  if (options.smallBudget) program = program.replace('maxBytes: 256 * 1024', `maxBytes: ${options.smallBudget}`);
  program = program.replace(/\}\)\(\);\s*$/, `
    globalThis.__test = { DIAG, diagnosticEvent, flushDiagnostics, diagnosticEnvelope,
      readDiagnosticStore, clearDiagnostics, diagnosticData, diagnosticGuard,
      captureSubmittedPrompt, saveDraftNow, onDocumentInput, onDocumentKeydown,
      onDocumentClick, onDocumentSubmit, exportDiagnostics,
      get pending() { return diagPending; }, get suppressed() { return diagSuppressed; },
      get throttleSize() { return diagThrottle.size; },
      get persistence() { return diagPersistence; }, get status() { return lastUiStatus; }
    };
  })();`);
  vm.createContext(sandbox);
  vm.runInContext(program, sandbox, { filename: 'chatgpt_prompt_safety_net.user.js' });
  return { api: sandbox.__test, storage, failures, editor, state, document, sandbox,
    warnings, writes, timers, downloads, advance(ms) { now += ms; },
    log() { return JSON.parse(storage.get(LOG)); },
    dump() { let disk = { events: [], clearedAt: 0 };
      try { disk = sandbox.__test.readDiagnosticStore(); } catch {}
      return JSON.stringify(sandbox.__test.diagnosticEnvelope(
        [...disk.events, ...sandbox.__test.pending], disk.clearedAt, true)); },
  };
}

test('500-event cap applies to memory and persistent storage; newest events survive', () => {
  const h = harness();
  for (let i = 0; i < 2000; i++) {
    h.advance(1100);
    h.api.diagnosticEvent('send-event', { via: 'click', chars: i });
  }
  assert.equal(h.api.pending.length, 500);
  assert.equal(h.api.flushDiagnostics(), true);
  assert.equal(h.log().events.length, 500);
  assert.equal(h.log().events.at(-1).data.chars, 1999);
  assert.ok(Buffer.byteLength(h.storage.get(LOG), 'utf8') <= 256 * 1024);
  assert.equal([...h.storage.keys()].filter(key => key.startsWith('cgpt_psn_diagnostics')).length, 1);
});

test('byte budget prunes independently of count, including exported metadata', () => {
  const h = harness({ smallBudget: 8192 });
  for (let i = 0; i < 500; i++) {
    h.advance(1100);
    h.api.diagnosticEvent('capture-result', { via: 'click', result: 'saved',
      chars: i, lastSaved: true, historySaved: true });
  }
  h.api.flushDiagnostics();
  assert.ok(h.log().events.length > 0 && h.log().events.length < 500);
  assert.equal(h.log().events.at(-1).data.chars, 499);
  assert.ok(Buffer.byteLength(h.storage.get(LOG)) <= 8192);
  assert.ok(Buffer.byteLength(h.dump()) <= 8192);
});

test('events older than 7 days expire, including idle cleanup without new events', () => {
  const h = harness();
  h.api.flushDiagnostics();
  h.advance(8 * 86400_000);
  h.api.flushDiagnostics();
  assert.equal(h.log().events.length, 0);
  h.api.diagnosticEvent('ready');
  h.api.flushDiagnostics();
  assert.equal(h.log().events.length, 1);
});

test('repeated exceptions are throttled; total event rate and throttle map are bounded', () => {
  const h = harness();
  for (let i = 0; i < 10000; i++) {
    h.api.diagnosticEvent('storage-error', { area: 'history', operation: 'write', error: 'Error' }, 30_000);
  }
  assert.equal(h.api.pending.filter(e => e.event === 'storage-error').length, 1);
  assert.ok(h.api.suppressed >= 9999);
  for (let i = 0; i < 10000; i++) h.api.diagnosticEvent('send-event', { chars: i });
  assert.ok(h.api.pending.length <= 120);
  assert.ok(h.api.throttleSize <= 64);
});

test('input and unchanged heartbeat do not emit a stream of diagnostic records', () => {
  const h = harness();
  for (let i = 0; i < 1000; i++) {
    h.api.onDocumentInput({ target: h.editor });
    h.api.saveDraftNow();
  }
  assert.equal(h.api.pending.filter(e => e.event === 'editor-state').length, 1);
  assert.equal(h.api.pending.filter(e => e.event === 'draft-saved').length, 0);
  h.editor.value = 'PRIVATE_PROMPT';
  for (let i = 0; i < 1000; i++) h.api.saveDraftNow();
  assert.equal(h.api.pending.filter(e => e.event === 'draft-saved').length, 1);
});

test('diagnostic write failure retains bounded exportable memory without recursive retries', () => {
  const h = harness();
  h.failures.write.add(LOG);
  for (let i = 0; i < 200; i++) assert.equal(h.api.flushDiagnostics(), false);
  assert.equal(h.api.persistence, 'error');
  assert.ok(h.api.pending.length <= 3);
  assert.ok(h.timers.size <= 1);
  assert.equal(h.warnings.length, 1);
  assert.ok(h.dump().includes('diagnostics-error'));
  assert.ok(!h.dump().includes('PRIVATE_PROMPT'));
  h.failures.write.clear();
  assert.equal(h.api.flushDiagnostics(), true);
  assert.equal(h.api.persistence, 'ok');
});

test('diagnostic read failure does not overwrite the persistent log', () => {
  const h = harness();
  h.api.flushDiagnostics();
  const before = h.storage.get(LOG);
  h.failures.read.add(LOG);
  h.api.diagnosticEvent('send-event', { chars: 5 });
  assert.equal(h.api.flushDiagnostics(), false);
  assert.equal(h.storage.get(LOG), before);
  assert.ok(h.api.pending.length > 0);
});

test('diagnostics omit prompt bodies, IDs, URLs, tokens, and raw exception text/stack', () => {
  const h = harness();
  h.editor.value = 'PRIVATE_PROMPT';
  h.api.captureSubmittedPrompt('click');
  h.api.diagnosticEvent('storage-error', { area: 'history', operation: 'write',
    error: 'PRIVATE_PROMPT', text: 'PRIVATE_PROMPT', url: h.sandbox.location.href,
    token: 'SECRET', stack: 'PRIVATE_STACK', routeKey: 'private-conversation-id' });
  h.api.diagnosticGuard('input', () => { throw new Error('PRIVATE_EXCEPTION_TEXT'); })();
  h.api.flushDiagnostics();
  const dump = h.dump() + JSON.stringify(h.warnings);
  for (const secret of ['PRIVATE_PROMPT', 'PRIVATE_EXCEPTION_TEXT', 'PRIVATE_STACK',
    'private-conversation-id', 'SECRET', 'https://chatgpt.com']) assert.ok(!dump.includes(secret), secret);
  assert.equal(h.storage.get(HISTORY)[0].text, 'PRIVATE_PROMPT');
});

test('empty text and missing editor have distinct reasons, not bogus saved prompts', () => {
  const h = harness();
  h.api.captureSubmittedPrompt('click');
  h.state.editor = null;
  h.api.captureSubmittedPrompt('click');
  assert.ok(h.api.pending.some(e => e.data.result === 'empty'));
  assert.ok(h.api.pending.some(e => e.data.result === 'missing-editor'));
  assert.ok(!h.storage.has(HISTORY));
});

test('Enter, click, submit deduplicate one send; later reuse preserves favorites and increments count', () => {
  const h = harness();
  h.editor.value = 'PRIVATE_PROMPT';
  h.api.captureSubmittedPrompt('keydown');
  h.api.captureSubmittedPrompt('click');
  h.api.captureSubmittedPrompt('submit');
  assert.equal(h.storage.get(HISTORY).length, 1);
  assert.equal(h.storage.get(HISTORY)[0].useCount, 1);
  assert.equal(h.api.pending.filter(e => e.data.result === 'duplicate').length, 2);
  const history = h.storage.get(HISTORY);
  history[0].favorite = true;
  h.storage.set(HISTORY, history);
  h.advance(1600);
  h.api.captureSubmittedPrompt('click');
  assert.equal(h.storage.get(HISTORY)[0].useCount, 2);
  assert.equal(h.storage.get(HISTORY)[0].favorite, true);
});

test('failed prompt writes are reported as failed, not saved; immediate draft removal is skipped', () => {
  const h = harness();
  h.editor.value = 'PRIVATE_PROMPT';
  h.storage.set(DRAFT, { text: 'PRIVATE_PROMPT' });
  h.failures.write.add(HISTORY);
  h.failures.write.add(LAST);
  h.api.captureSubmittedPrompt('click');
  assert.ok(h.api.pending.some(e => e.data.result === 'failed'));
  assert.ok(!h.api.pending.some(e => e.data.result === 'saved'));
  assert.ok(h.api.status.includes('备份失败'));
  assert.equal(h.storage.get(DRAFT).text, 'PRIVATE_PROMPT');
});

test('failed history reads abort capture without replacing existing records with an empty list', () => {
  const h = harness();
  const previous = [{ id: 'old', text: 'KEEP_ME', useCount: 1, sentAt: 1 }];
  h.storage.set(HISTORY, previous);
  h.failures.read.add(HISTORY);
  h.editor.value = 'PRIVATE_PROMPT';
  h.api.captureSubmittedPrompt('click');
  assert.deepEqual(h.storage.get(HISTORY), previous);
  assert.ok(!h.storage.has(LAST));
  assert.ok(h.api.pending.some(e => e.data.result === 'read-failed'));
});

test('silent storage no-op is caught by API read-back', () => {
  const h = harness();
  h.editor.value = 'PRIVATE_PROMPT';
  h.failures.silent.add(HISTORY);
  h.api.captureSubmittedPrompt('click');
  assert.ok(h.api.pending.some(e => e.data.error === 'ReadbackMismatch'));
  assert.ok(h.api.pending.some(e => e.data.result === 'partial'));
});

test('clearing diagnostics leaves history, favorites, last sent and drafts unchanged', () => {
  const h = harness();
  h.editor.value = 'PRIVATE_PROMPT';
  h.api.captureSubmittedPrompt('click');
  h.storage.set(DRAFT, { text: 'UNSENT' });
  const before = new Map([...h.storage].filter(([key]) => key !== LOG));
  h.advance(1);
  h.api.clearDiagnostics();
  assert.equal(h.log().events.length, 0);
  assert.equal(h.api.pending.length, 0);
  assert.deepEqual(new Map([...h.storage].filter(([key]) => key !== LOG)), before);
});

test('sequential tabs merge one shared log; clear cutoff prevents resurrection of old buffers', () => {
  const shared = new Map();
  const a = harness({ storage: shared }), b = harness({ storage: shared });
  a.api.flushDiagnostics();
  b.api.diagnosticEvent('send-event', { chars: 42 });
  a.advance(10);
  a.api.clearDiagnostics();
  b.advance(20);
  b.api.diagnosticEvent('send-event', { chars: 99 });
  b.api.flushDiagnostics();
  assert.ok(!b.log().events.some(e => e.data.chars === 42));
  assert.ok(b.log().events.some(e => e.data.chars === 99));
  a.advance(20);
  a.api.diagnosticEvent('ready');
  a.api.flushDiagnostics();
  assert.ok(a.log().events.some(e => e.data.chars === 99));
  assert.equal([...shared.keys()].filter(key => key.startsWith('cgpt_psn_diagnostics')).length, 1);
});

test('corrupt or oversized diagnostic storage is replaced with a bounded valid envelope', () => {
  for (const raw of ['{bad json', 'x'.repeat(300 * 1024), '{}']) {
    const h = harness();
    h.storage.set(LOG, raw);
    assert.equal(h.api.flushDiagnostics(), true);
    assert.ok(h.log().events.some(e => e.data.error === 'InvalidData'));
    assert.ok(Buffer.byteLength(h.storage.get(LOG)) <= 256 * 1024);
  }
});

test('steady idle flush does not keep rewriting identical logs', () => {
  const h = harness();
  h.api.flushDiagnostics();
  const before = h.writes.length;
  for (let i = 0; i < 60; i++) {
    h.advance(60_000);
    h.api.flushDiagnostics();
  }
  assert.equal(h.writes.length, before);
});

test('unsolicited page errors are not collected as security-net diagnostics', () => {
  assert.ok(!source.includes("addEventListener('error'"));
  assert.ok(!source.includes("addEventListener('unhandledrejection'"));
  assert.ok(!source.includes('fetch('));
  assert.ok(!source.includes('XMLHttpRequest'));
});
