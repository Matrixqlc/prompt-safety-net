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
  const makeNode = (text = '', properties = {}) => {
    const node = {
      nodeType: 1, tagName: 'DIV', isConnected: true, hidden: false,
      innerText: text, textContent: text, disabled: false, readOnly: false,
      contentEditable: 'true', isContentEditable: true,
      contains: candidate => candidate === node,
      closest: () => null,
      getAttribute(name) {
        if (name === 'contenteditable') return this.contentEditable;
        if (name === 'aria-hidden') return this.hidden ? 'true' : null;
        return null;
      },
      getBoundingClientRect() { return this.hidden ? { width: 0, height: 0 } : { width: 600, height: 100 }; },
      getClientRects() { return this.hidden ? [] : [this.getBoundingClientRect()]; },
      ...properties,
    };
    return node;
  };
  const editor = makeNode('', { value: '' });
  const stopButton = makeNode('', { tagName: 'BUTTON', isContentEditable: false });
  const state = { editor, assistants: [], users: [], generating: false, selectors: new Map() };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  const fail = () => { const error = new Error('PRIVATE_PROMPT token=SECRET https://private.example');
    error.name = 'QuotaExceededError'; throw error; };
  const document = {
    readyState: 'loading', body: null, visibilityState: 'visible',
    getElementById: () => null,
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },
    querySelectorAll(selector) {
      if (state.selectors.has(selector)) return state.selectors.get(selector);
      if (selector.startsWith('#prompt-textarea')) return state.editor ? [state.editor] : [];
      if (selector === '[data-message-author-role="assistant"]' || selector === '[data-turn="assistant"]') return state.assistants;
      if (selector === '[data-message-author-role="user"]' || selector === '[data-turn="user"]') return state.users;
      if (/stop-button|Stop generating|aria-label="Stop"|停止生成|aria-label="停止"/.test(selector)) return state.generating ? [stopButton] : [];
      return [];
    },
    addEventListener() {},
    createElement: () => ({ style: {}, click() { downloads.push(this.download); }, remove() {} }),
  };
  const sandbox = {
    Date: Clock, TextEncoder, Blob, URL, Map, Set, Math, JSON,
    navigator: { onLine: true }, document,
    location: { pathname: '/c/private-conversation-id', href: 'https://chatgpt.com/c/private-conversation-id?token=SECRET' },
    window: { addEventListener() {},
      getComputedStyle: node => ({ display: node.hidden ? 'none' : 'block', visibility: node.hidden ? 'hidden' : 'visible' }) },
    getComputedStyle: node => ({ display: node.hidden ? 'none' : 'block', visibility: node.hidden ? 'hidden' : 'visible' }),
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
    currentRouteKey = routeKey();
    let testPanelUpdates = 0;
    let testStatusTone = 'ok';
    const originalSetStatus = setStatus;
    setStatus = (message, tone = 'ok') => {
      testStatusTone = tone;
      return originalSetStatus(message, tone);
    };
    globalThis.__test = { DIAG, diagnosticEvent, flushDiagnostics, diagnosticEnvelope,
      readDiagnosticStore, clearDiagnostics, diagnosticData, diagnosticGuard,
      captureSubmittedPrompt, saveDraftNow, onDocumentInput, onDocumentKeydown,
      onDocumentClick, onDocumentSubmit, exportDiagnostics,
      getEditor, resumeRecentPending, monitorConnectionAndProgress, routeWatcher,
      markPendingResponseSeen, stopCurrentMonitoring,
      get tone() { return testStatusTone; },
      get monitoring() { return currentPending; }, get progressAt() { return lastProgressAt; },
      spyPanelUpdates() { updatePanel = () => { testPanelUpdates++; }; },
      get panelUpdates() { return testPanelUpdates; },
      countClosedPanelMeasurements() {
        let calls = 0;
        uiPanel = { classList: { contains: () => false } };
        uiList = { innerHTML: '' };
        uiPager = { innerHTML: '', hidden: true };
        buildAdaptivePages = () => { calls++; return [{ start: 0, end: 1 }]; };
        updatePanel();
        return calls;
      },
      get pending() { return diagPending; }, get suppressed() { return diagSuppressed; },
      get throttleSize() { return diagThrottle.size; },
      get persistence() { return diagPersistence; }, get status() { return lastUiStatus; }
    };
  })();`);
  vm.createContext(sandbox);
  vm.runInContext(program, sandbox, { filename: 'chatgpt_prompt_safety_net.user.js' });
  return { api: sandbox.__test, storage, failures, editor, state, document, sandbox, makeNode,
    warnings, writes, timers, downloads, advance(ms) { now += ms; },
    now() { return now; },
    navigate(pathname) {
      sandbox.location.pathname = pathname;
      sandbox.location.href = 'https://chatgpt.com' + pathname;
    },
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

function seedPending(h, overrides = {}) {
  const item = {
    id: 'submission-a', text: 'BACKED_UP_PROMPT', status: 'pending',
    sentAt: h.now() - 4452_000, firstSentAt: h.now() - 4452_000,
    routeKey: 'c:private-conversation-id',
    url: 'https://chatgpt.com/c/private-conversation-id',
    useCount: 1, favorite: true, ...overrides,
  };
  h.storage.set(LAST, structuredClone(item));
  h.storage.set(HISTORY, [structuredClone(item)]);
  return item;
}

function submit(h, text = 'BACKED_UP_PROMPT') {
  h.editor.value = text;
  h.api.captureSubmittedPrompt('click');
  h.state.users.push(h.makeNode(text));
  h.editor.value = '';
}

test('4452-second old pending from another route is not adopted or declared stalled', () => {
  const h = harness();
  const item = seedPending(h);
  h.navigate('/dots/home');
  h.state.editor = null;
  h.api.resumeRecentPending();
  h.api.monitorConnectionAndProgress();
  assert.equal(h.api.monitoring, null);
  assert.notEqual(h.api.tone, 'warn');
  assert.deepEqual(h.storage.get(LAST), item);
  assert.deepEqual(h.storage.get(HISTORY), [item]);
});

test('reload on the same route does not infer an active request from a saved pending alone', () => {
  const h = harness();
  const item = seedPending(h);
  h.state.assistants = [h.makeNode('A reply that was already present at reload')];
  h.api.resumeRecentPending();
  h.api.monitorConnectionAndProgress();
  assert.equal(h.api.monitoring, null);
  assert.notEqual(h.api.tone, 'warn');
  assert.deepEqual(h.storage.get(LAST), item);
});

test('observed generation on the same route resumes with a fresh observation clock', () => {
  const h = harness();
  const item = seedPending(h);
  h.state.generating = true;
  h.api.resumeRecentPending();
  assert.equal(h.api.monitoring?.id, item.id);
  assert.equal(h.api.progressAt, h.now());
  h.api.monitorConnectionAndProgress();
  assert.notEqual(h.api.tone, 'warn');
  h.advance(119_000);
  h.api.monitorConnectionAndProgress();
  assert.notEqual(h.api.tone, 'warn');
  h.advance(2_000);
  h.api.monitorConnectionAndProgress();
  assert.equal(h.api.tone, 'warn');
  assert.ok(!h.api.status.includes('4452'));
});

test('switching conversation drops the old monitor and its warning without changing backups', () => {
  const h = harness();
  submit(h);
  h.state.generating = true;
  h.api.monitorConnectionAndProgress();
  h.advance(121_000);
  h.api.monitorConnectionAndProgress();
  assert.equal(h.api.tone, 'warn');
  const before = structuredClone(h.storage.get(LAST));
  h.navigate('/c/different-conversation');
  h.state.assistants = [h.makeNode('An unrelated conversation reply')];
  h.state.generating = false;
  h.api.routeWatcher();
  h.api.monitorConnectionAndProgress();
  assert.equal(h.api.monitoring, null);
  assert.notEqual(h.api.tone, 'warn');
  assert.deepEqual(h.storage.get(LAST), before);
  assert.equal(h.storage.get(HISTORY)[0].status, 'pending');
});

test('a first send can follow its matching new conversation even when progress polls before route watcher', () => {
  const h = harness();
  h.navigate('/');
  h.api.routeWatcher();
  submit(h, 'NEW_CONVERSATION_PROMPT');
  const id = h.storage.get(LAST).id;
  h.state.generating = true;
  h.navigate('/c/newly-created-conversation');
  // The 2-second progress and 700ms route intervals have no guaranteed order.
  h.api.monitorConnectionAndProgress();
  assert.equal(h.api.monitoring?.id, id);
  assert.equal(h.api.monitoring?.routeKey, 'c:newly-created-conversation');
  assert.equal(h.storage.get(LAST).routeKey, 'c:newly-created-conversation');
  assert.equal(h.storage.get(HISTORY)[0].useCount, 1);
});

test('a home-page submission is not transferred into a conversation with unrelated user text', () => {
  const h = harness();
  h.navigate('/');
  h.api.routeWatcher();
  submit(h, 'NEW_CONVERSATION_PROMPT');
  const backup = structuredClone(h.storage.get(LAST));
  h.navigate('/c/unrelated-conversation');
  h.state.users = [h.makeNode('UNRELATED_PROMPT')];
  h.api.routeWatcher();
  assert.equal(h.api.monitoring, null);
  assert.deepEqual(h.storage.get(LAST), backup);
  assert.notEqual(h.api.tone, 'warn');
});

test('an unobservable page pauses warning time; restored observation starts a new window', () => {
  const h = harness();
  submit(h);
  h.state.editor = null;
  h.advance(121_000);
  h.api.monitorConnectionAndProgress();
  assert.notEqual(h.api.tone, 'warn');
  h.advance(4452_000);
  h.api.monitorConnectionAndProgress();
  assert.notEqual(h.api.tone, 'warn');
  h.state.editor = h.editor;
  h.state.generating = true;
  h.api.monitorConnectionAndProgress();
  assert.notEqual(h.api.tone, 'warn');
  h.advance(121_000);
  h.api.monitorConnectionAndProgress();
  assert.equal(h.api.tone, 'warn');
});

test('a current observable generation still warns when its first reply never progresses', () => {
  const h = harness();
  submit(h);
  h.state.generating = true;
  h.api.monitorConnectionAndProgress();
  h.advance(121_000);
  h.api.monitorConnectionAndProgress();
  assert.equal(h.api.tone, 'warn');
});

test('monitoring continues after the first response fragment and clears warning on new progress', () => {
  const h = harness();
  submit(h);
  h.state.generating = true;
  const reply = h.makeNode('first response fragment');
  h.state.assistants.push(reply);
  h.api.monitorConnectionAndProgress();
  assert.equal(h.storage.get(HISTORY)[0].status, 'response-seen');
  h.advance(121_000);
  h.api.monitorConnectionAndProgress();
  assert.equal(h.api.tone, 'warn');
  reply.innerText = reply.textContent = 'first response fragment, followed by additional progress';
  h.api.monitorConnectionAndProgress();
  assert.notEqual(h.api.tone, 'warn');
});

test('returning to a visible page clears a stale post-fragment warning without new reply text', () => {
  const h = harness();
  submit(h);
  h.state.generating = true;
  h.state.assistants.push(h.makeNode('unchanged first response fragment'));
  h.api.monitorConnectionAndProgress();
  h.advance(121_000);
  h.api.monitorConnectionAndProgress();
  assert.equal(h.api.tone, 'warn');
  h.document.visibilityState = 'hidden';
  h.api.monitorConnectionAndProgress();
  h.advance(4452_000);
  h.document.visibilityState = 'visible';
  h.api.monitorConnectionAndProgress();
  assert.equal(h.api.tone, 'ok');
  assert.equal(h.api.progressAt, h.now());
  assert.ok(h.api.monitoring);
});

test('editor lookup skips an earlier hidden candidate and uses the visible composer', () => {
  const h = harness();
  const hidden = h.makeNode('', { value: 'HIDDEN_EDITOR_CONTENT', hidden: true });
  h.state.selectors.set('#prompt-textarea[contenteditable="true"]', [hidden, h.editor]);
  h.editor.value = 'VISIBLE_EDITOR_CONTENT';
  assert.equal(h.api.getEditor(), h.editor);
  h.api.captureSubmittedPrompt('click');
  assert.equal(h.storage.get(LAST).text, 'VISIBLE_EDITOR_CONTENT');
});

test('unchanged draft heartbeats neither write again nor rebuild the history panel', () => {
  const h = harness();
  h.editor.value = 'PRESERVE_THIS_DRAFT';
  h.api.spyPanelUpdates();
  h.api.saveDraftNow();
  const before = h.storage.get(DRAFT);
  const writesBefore = h.writes.filter(w => w.key === DRAFT).length;
  for (let i = 0; i < 100; i++) {
    h.advance(2_000);
    h.api.saveDraftNow();
  }
  assert.equal(h.writes.filter(w => w.key === DRAFT).length, writesBefore);
  assert.deepEqual(h.storage.get(DRAFT), before);
  assert.equal(h.api.panelUpdates, 0);
});

test('a collapsed history panel does not measure every saved prompt', () => {
  const h = harness();
  seedPending(h);
  assert.equal(h.api.countClosedPanelMeasurements(), 0);
});

test('an old tab observing its reply cannot replace a newer last-sent backup', () => {
  const shared = new Map();
  const a = harness({ storage: shared });
  const b = harness({ storage: shared, now: a.now() + 5_000 });
  submit(a, 'FIRST_PROMPT');
  submit(b, 'SECOND_PROMPT');
  const latest = structuredClone(shared.get(LAST));
  a.state.generating = true;
  a.state.assistants.push(a.makeNode('Response to the first prompt'));
  a.api.monitorConnectionAndProgress();
  assert.deepEqual(shared.get(LAST), latest);
  assert.equal(shared.get(HISTORY).find(item => item.text === 'SECOND_PROMPT').status, 'pending');
});

test('old response cannot regress a newer same-text send that reused the same history id', () => {
  const shared = new Map();
  const a = harness({ storage: shared });
  const b = harness({ storage: shared, now: a.now() + 5_000 });
  submit(a, 'REUSED_PROMPT');
  const earlierId = shared.get(LAST).id;
  submit(b, 'REUSED_PROMPT');
  const latest = structuredClone(shared.get(LAST));
  assert.equal(latest.id, earlierId);
  assert.equal(latest.useCount, 2);
  a.state.generating = true;
  a.state.assistants.push(a.makeNode('Response to the earlier send'));
  a.api.monitorConnectionAndProgress();
  assert.deepEqual(shared.get(LAST), latest);
  assert.deepEqual(shared.get(HISTORY), [latest]);
});

test('stopping a stalled monitor preserves prompt text, favorites and drafts', () => {
  const h = harness();
  submit(h);
  h.storage.set(DRAFT, { text: 'ANOTHER_UNSENT_PROMPT', savedAt: h.now() });
  const saved = h.storage.get(HISTORY);
  saved[0].favorite = true;
  h.storage.set(HISTORY, saved);
  h.state.generating = true;
  h.advance(121_000);
  h.api.monitorConnectionAndProgress();
  h.api.stopCurrentMonitoring();
  assert.equal(h.api.monitoring, null);
  assert.notEqual(h.api.tone, 'warn');
  assert.equal(h.storage.get(HISTORY)[0].text, 'BACKED_UP_PROMPT');
  assert.equal(h.storage.get(HISTORY)[0].favorite, true);
  assert.equal(h.storage.get(DRAFT).text, 'ANOTHER_UNSENT_PROMPT');
});

