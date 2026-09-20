// ==UserScript==
// @name         Prompt Safety Net for ChatGPT
// @namespace    https://chatgpt.com/
// @version      0.6.3
// @description  Auto-save ChatGPT prompts, archive submitted prompts, restore after refresh, and warn about offline/stalled responses.
// @author       ChatGPT
// @homepageURL  https://github.com/Matrixqlc/prompt-safety-net
// @supportURL   https://github.com/Matrixqlc/prompt-safety-net/issues
// @updateURL    https://raw.githubusercontent.com/Matrixqlc/prompt-safety-net/main/chatgpt_prompt_safety_net.user.js
// @downloadURL  https://raw.githubusercontent.com/Matrixqlc/prompt-safety-net/main/chatgpt_prompt_safety_net.user.js
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// ==/UserScript==

(() => {
  'use strict';

  // ---------- Configuration ----------
  const CFG = {
    draftDebounceMs: 250,
    autosaveHeartbeatMs: 2000,
    stallWarnMs: 120_000, // 2 min without visible response progress => "possibly stuck"
    autoRestoreMaxAgeMs: 24 * 60 * 60 * 1000,
    pendingResumeMaxAgeMs: 2 * 60 * 60 * 1000,
    regularHistoryLimit: 200, // favorites are kept outside this cap
    panelViewportRatio: 0.88, // approximate maximum panel height before making another page
    minPageContentHeight: 220,
    pollMs: 2000,
  };

  const K = {
    HISTORY: 'cgpt_psn_history_v3',
    LAST_SENT: 'cgpt_psn_last_sent_v3',
    UI_COLLAPSED: 'cgpt_psn_ui_collapsed_v3',
    DRAFT_PREFIX: 'cgpt_psn_draft_v3:',
  };

  let currentRouteKey = '';
  let currentPending = null;
  let saveTimer = null;
  let lastCapturedText = '';
  let lastCapturedAt = 0;
  let lastUiStatus = '';
  let lastProgressFingerprint = '';
  let lastProgressAt = 0;
  let responseStarted = false;
  let editorTouchedThisSession = false;
  let historyPage = 0;

  // ---------- Storage ----------
  const read = (key, fallback = null) => {
    try {
      const v = GM_getValue(key);
      return v === undefined ? fallback : v;
    } catch {
      return fallback;
    }
  };

  const write = (key, value) => {
    try { GM_setValue(key, value); } catch {}
  };

  const remove = (key) => {
    try { GM_deleteValue(key); } catch {}
  };

  function routeKey() {
    const m = location.pathname.match(/^\/c\/([^/?#]+)/);
    if (m) return `c:${m[1]}`;
    return `path:${location.pathname || '/'}`;
  }

  const draftKey = (rk = routeKey()) => K.DRAFT_PREFIX + rk;

  function normalizePromptText(text) {
    return String(text || '').replace(/\r\n?/g, '\n').trim();
  }

  function normalizeHistory(items) {
    const byText = new Map();

    for (const raw of Array.isArray(items) ? items : []) {
      if (!raw?.text) continue;

      const key = normalizePromptText(raw.text);
      if (!key) continue;

      const count = Number.isFinite(raw.useCount) && raw.useCount > 0
        ? Math.floor(raw.useCount)
        : 1;
      const sentAt = Number(raw.sentAt) || 0;
      const firstSentAt = Number(raw.firstSentAt) || sentAt || Date.now();
      const current = byText.get(key);

      if (!current) {
        byText.set(key, {
          ...raw,
          useCount: count,
          favorite: !!raw.favorite,
          firstSentAt,
        });
        continue;
      }

      const currentSentAt = Number(current.sentAt) || 0;
      const newest = sentAt >= currentSentAt ? raw : current;
      const oldestSentAt = Math.min(
        Number(current.firstSentAt) || currentSentAt || firstSentAt,
        firstSentAt
      );

      byText.set(key, {
        ...current,
        ...newest,
        id: newest.id || current.id,
        text: newest.text || current.text,
        useCount: (Number(current.useCount) || 1) + count,
        favorite: !!(current.favorite || raw.favorite),
        firstSentAt: oldestSentAt,
      });
    }

    return [...byText.values()].sort((a, b) => {
      if (!!a.favorite !== !!b.favorite) return a.favorite ? -1 : 1;
      return (Number(b.sentAt) || 0) - (Number(a.sentAt) || 0);
    });
  }

  function pruneHistory(items) {
    const normalized = normalizeHistory(items);
    const favorites = normalized.filter(item => item.favorite);
    const regular = normalized
      .filter(item => !item.favorite)
      .slice(0, CFG.regularHistoryLimit);

    return [...favorites, ...regular];
  }

  function getHistory() {
    const raw = read(K.HISTORY, []);
    const pruned = pruneHistory(raw);

    // Migrate old duplicated records and apply the new retention rule in place.
    try {
      if (JSON.stringify(raw) !== JSON.stringify(pruned)) {
        write(K.HISTORY, pruned);
      }
    } catch {}

    return pruned;
  }

  function setHistory(h) {
    write(K.HISTORY, pruneHistory(h));
  }

  function upsertHistory(item) {
    const h = getHistory();
    const i = h.findIndex(x => x.id === item.id);
    if (i >= 0) h[i] = { ...h[i], ...item };
    else h.unshift(item);
    setHistory(h);
  }

  function findHistoryByText(text) {
    const key = normalizePromptText(text);
    if (!key) return null;
    return getHistory().find(x => normalizePromptText(x.text) === key) || null;
  }

  function deleteHistoryItem(id) {
    const h = getHistory();
    const item = h.find(x => x.id === id);
    if (!item) return;

    setHistory(h.filter(x => x.id !== id));

    const last = read(K.LAST_SENT, null);
    const sameAsLast = last && (
      last.id === id ||
      normalizePromptText(last.text) === normalizePromptText(item.text)
    );
    if (sameAsLast) remove(K.LAST_SENT);

    if (currentPending && (
      currentPending.id === id ||
      normalizePromptText(currentPending.text) === normalizePromptText(item.text)
    )) {
      currentPending = null;
    }

    updatePanel();
    toast('已删除这条 Prompt');
  }

  function toggleFavorite(id) {
    const h = getHistory();
    const i = h.findIndex(x => x.id === id);
    if (i < 0) return;

    h[i] = { ...h[i], favorite: !h[i].favorite };
    setHistory(h);
    historyPage = 0;
    updatePanel();
    toast(h[i].favorite ? '已收藏' : '已取消收藏');
  }

  function exportHistory() {
    const prompts = getHistory().map(item => ({
      text: item.text || '',
      favorite: !!item.favorite,
      useCount: Number(item.useCount) || 1,
      firstSentAt: Number(item.firstSentAt) || Number(item.sentAt) || null,
      sentAt: Number(item.sentAt) || null,
      status: item.status || 'saved',
      routeKey: item.routeKey || null,
      url: item.url || null,
    }));

    if (!prompts.length) {
      toast('还没有可导出的 Prompt');
      return;
    }

    const payload = {
      format: 'prompt-safety-net',
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      promptCount: prompts.length,
      prompts,
    };

    const now = new Date();
    const pad = n => String(n).padStart(2, '0');
    const filename =
      `prompt-safety-net-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.json`;

    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    toast(`已导出 ${prompts.length} 条 Prompt`);
  }

  // ---------- DOM helpers ----------
  function getEditor() {
    const selectors = [
      '#prompt-textarea[contenteditable="true"]',
      '[data-testid="prompt-textarea"][contenteditable="true"]',
      'form [contenteditable="true"][data-lexical-editor="true"]',
      'form div.ProseMirror[contenteditable="true"]',
      'textarea[data-testid="prompt-textarea"]',
      'textarea[placeholder*="Message"]',
      'textarea[placeholder*="消息"]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && isVisible(el)) return el;
    }
    return null;
  }

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function editorText(el = getEditor()) {
    if (!el) return '';
    if ('value' in el && typeof el.value === 'string') return el.value;
    return (el.innerText || el.textContent || '').replace(/\u00a0/g, ' ');
  }

  function setEditorText(text) {
    const el = getEditor();
    if (!el) return false;

    el.focus();

    if ('value' in el && typeof el.value === 'string') {
      const proto = Object.getPrototypeOf(el);
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc?.set) desc.set.call(el, text);
      else el.value = text;
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true, inputType: 'insertText', data: text
      }));
      return true;
    }

    // Use the browser editing pipeline first; ProseMirror/Lexical usually notices this
    // more reliably than simply assigning textContent.
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      const ok = document.execCommand('insertText', false, text);
      sel.removeAllRanges();
      if (ok) {
        el.dispatchEvent(new InputEvent('input', {
          bubbles: true, inputType: 'insertText', data: text
        }));
        return true;
      }
    } catch {}

    // Fallback if execCommand is unavailable.
    try {
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', {
        bubbles: true, inputType: 'insertText', data: text
      }));
      return true;
    } catch {
      return false;
    }
  }

  function sendButtonFromTarget(target) {
    return target?.closest?.(
      'button[data-testid="send-button"], #composer-submit-button, button[aria-label="Send prompt"], button[aria-label="发送提示词"], button[aria-label="发送"]'
    );
  }

  function isGenerating() {
    const selectors = [
      'button[data-testid="stop-button"]',
      'button[aria-label="Stop generating"]',
      'button[aria-label="Stop"]',
      'button[aria-label="停止生成"]',
      'button[aria-label="停止"]',
    ];
    return selectors.some(sel => {
      const el = document.querySelector(sel);
      return el && isVisible(el);
    });
  }

  function assistantNodes() {
    const selectors = [
      '[data-message-author-role="assistant"]',
      '[data-turn="assistant"]',
    ];
    for (const sel of selectors) {
      const nodes = [...document.querySelectorAll(sel)];
      if (nodes.length) return nodes;
    }
    return [];
  }

  function progressFingerprint() {
    const nodes = assistantNodes();
    const last = nodes.at(-1);
    const text = last ? (last.innerText || last.textContent || '') : '';
    return `${nodes.length}:${text.length}:${text.slice(-80)}`;
  }

  // ---------- Saving ----------
  function saveDraftNow() {
    const el = getEditor();
    if (!el) return;
    const text = editorText(el);
    const existing = read(draftKey(), null);
    // During a reload ChatGPT may create an empty editor before our restore runs.
    // Never let that transient empty state erase a previously saved non-empty draft.
    if (!text && existing?.text && !editorTouchedThisSession) return;
    write(draftKey(), {
      text,
      savedAt: Date.now(),
      url: location.href,
      routeKey: routeKey(),
    });
    updatePanel();
  }

  function scheduleDraftSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveDraftNow, CFG.draftDebounceMs);
  }

  function makeId(text, ts) {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return `${ts}_${(h >>> 0).toString(16)}`;
  }

  function captureSubmittedPrompt(reason) {
    const text = editorText().trimEnd();
    if (!text.trim()) return;

    const now = Date.now();

    // A single Enter may trigger keydown + click + submit. De-duplicate them.
    if (text === lastCapturedText && now - lastCapturedAt < 1500) return;
    lastCapturedText = text;
    lastCapturedAt = now;

    const existing = findHistoryByText(text);
    const item = existing ? {
      ...existing,
      text,
      sentAt: now,
      url: location.href,
      routeKey: routeKey(),
      reason,
      status: 'pending',
      useCount: (Number(existing.useCount) || 1) + 1,
      firstSentAt: existing.firstSentAt || existing.sentAt || now,
      favorite: !!existing.favorite,
    } : {
      id: makeId(text, now),
      text,
      sentAt: now,
      firstSentAt: now,
      url: location.href,
      routeKey: routeKey(),
      reason,
      status: 'pending',
      useCount: 1,
      favorite: false,
    };

    write(K.LAST_SENT, item);
    upsertHistory(item);
    historyPage = 0;

    // Once submitted, it is no longer an "unsent draft"; keep it safely in history.
    remove(draftKey());

    currentPending = item;
    responseStarted = false;
    lastProgressFingerprint = progressFingerprint();
    lastProgressAt = now;

    setStatus('已备份刚发送的 Prompt', 'ok');
    toast('已备份本次 Prompt');
    updatePanel();
  }

  function markPendingResponseSeen() {
    if (!currentPending || currentPending.status !== 'pending') return;
    currentPending = {
      ...currentPending,
      status: 'response-seen',
      responseSeenAt: Date.now(),
    };
    write(K.LAST_SENT, currentPending);
    upsertHistory(currentPending);
    updatePanel();
  }

  // ---------- Recovery ----------
  function restoreUnsentDraft(silent = false) {
    const d = read(draftKey(), null);
    if (!d?.text) {
      if (!silent) toast('当前会话没有可恢复的未发送草稿');
      return false;
    }
    const ok = setEditorText(d.text);
    if (ok) {
      if (!silent) toast('已恢复未发送草稿');
      updatePanel();
    } else if (!silent) {
      toast('暂时找不到输入框，稍后再试');
    }
    return ok;
  }

  function restoreLastSent() {
    const item = read(K.LAST_SENT, null);
    if (!item?.text) return toast('没有找到已发送 Prompt 的备份');
    if (setEditorText(item.text)) {
      toast('已把上次发送的 Prompt 放回输入框（不会自动发送）');
    } else {
      toast('暂时找不到输入框，稍后再试');
    }
  }

  async function copyLastSent() {
    const item = read(K.LAST_SENT, null);
    if (!item?.text) return toast('没有找到已发送 Prompt 的备份');
    try {
      await navigator.clipboard.writeText(item.text);
      toast('已复制上次发送的 Prompt');
    } catch {
      toast('浏览器拒绝剪贴板权限，可点“恢复上次发送”后手动复制');
    }
  }

  function maybeAutoRestore() {
    const d = read(draftKey(), null);
    if (!d?.text) return;
    if (Date.now() - d.savedAt > CFG.autoRestoreMaxAgeMs) return;

    const tryRestore = () => {
      const el = getEditor();
      if (!el) return false;
      if (editorText(el).trim()) return true; // Don't overwrite ChatGPT/user content.
      if (setEditorText(d.text)) {
        toast('已自动恢复刷新前的未发送草稿');
        updatePanel();
        return true;
      }
      return false;
    };

    if (tryRestore()) return;
    let attempts = 0;
    const t = setInterval(() => {
      attempts++;
      if (tryRestore() || attempts > 20) clearInterval(t);
    }, 500);
  }

  // ---------- Connectivity / stall detection ----------
  function resumeRecentPending() {
    const last = read(K.LAST_SENT, null);
    if (!last || last.status !== 'pending') return;
    if (Date.now() - last.sentAt > CFG.pendingResumeMaxAgeMs) return;

    currentPending = last;
    lastProgressFingerprint = progressFingerprint();
    lastProgressAt = last.sentAt;
    responseStarted = false;
  }

  function monitorConnectionAndProgress() {
    if (!navigator.onLine) {
      setStatus('浏览器已离线；Prompt 备份仍在', 'bad');
      return;
    }

    if (!currentPending || currentPending.status !== 'pending') {
      if (lastUiStatus.startsWith('浏览器已离线')) {
        setStatus('网络已恢复', 'ok');
      }
      return;
    }

    const fp = progressFingerprint();
    if (fp !== lastProgressFingerprint) {
      lastProgressFingerprint = fp;
      lastProgressAt = Date.now();
      responseStarted = true;
      markPendingResponseSeen();
      setStatus('已看到助手响应；Prompt 备份已保留', 'ok');
      return;
    }

    const idleMs = Date.now() - lastProgressAt;
    const ageMs = Date.now() - currentPending.sentAt;

    // Before any assistant text appears, a long silent interval is suspicious.
    // During generation, only warn if the UI still looks like generation is active.
    const suspicious =
      (!responseStarted && ageMs >= CFG.stallWarnMs) ||
      (responseStarted && isGenerating() && idleMs >= CFG.stallWarnMs);

    if (suspicious) {
      const sec = Math.floor(Math.max(ageMs, idleMs) / 1000);
      setStatus(`疑似卡住：约 ${sec}s 没有可见响应进展`, 'warn');
    }
  }

  // ---------- UI ----------
  let uiRoot, uiButton, uiPanel, uiStatus, uiList, uiPager;

  function injectStyle() {
    if (document.getElementById('cgpt-psn-style')) return;
    const st = document.createElement('style');
    st.id = 'cgpt-psn-style';
    st.textContent = `
      #cgpt-psn-root { position: fixed; right: 18px; bottom: 88px; z-index: 2147483646; font: 13px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color: #111; }
      #cgpt-psn-button { border: 1px solid rgba(0,0,0,.16); background: rgba(255,255,255,.96); color: #111; border-radius: 999px; padding: 8px 12px; box-shadow: 0 6px 24px rgba(0,0,0,.14); cursor: pointer; }
      #cgpt-psn-button[data-tone="warn"] { border-color: #b7791f; }
      #cgpt-psn-button[data-tone="bad"] { border-color: #c53030; }
      #cgpt-psn-panel { width: min(430px, calc(100vw - 36px)); height:auto; overflow:visible; margin-bottom: 8px; border: 1px solid rgba(0,0,0,.14); background: rgba(255,255,255,.985); border-radius: 14px; box-shadow: 0 12px 38px rgba(0,0,0,.20); padding: 12px; display:none; }
      #cgpt-psn-panel.open { display:block; }
      .cgpt-psn-title { font-weight: 700; margin-bottom: 5px; }
      .cgpt-psn-status { padding: 7px 8px; border-radius: 9px; background: rgba(0,0,0,.05); margin-bottom: 9px; word-break: break-word; }
      .cgpt-psn-actions { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:10px; }
      .cgpt-psn-actions button, .cgpt-psn-pagination button { border:1px solid rgba(0,0,0,.15); background:#fff; border-radius:8px; padding:6px 8px; cursor:pointer; }
      .cgpt-psn-item button { border:1px solid rgba(0,0,0,.15); background:#fff; border-radius:7px; padding:4px 6px; font-size:11px; line-height:1.2; cursor:pointer; }
      .cgpt-psn-pagination button:disabled { opacity:.38; cursor:default; }
      .cgpt-psn-item { border-top:1px solid rgba(0,0,0,.09); padding:9px 0; }
      .cgpt-psn-item[data-favorite="true"] .cgpt-psn-meta { opacity:.9; font-weight:600; }
      .cgpt-psn-meta { opacity:.58; font-size:10.5px; margin-bottom:5px; }
      .cgpt-psn-preview { display:flex; align-items:flex-start; gap:7px; white-space:pre-wrap; max-height:none; overflow:visible; word-break:break-word; margin-bottom:8px; font-size:14px; line-height:1.55; font-weight:450; }
      .cgpt-psn-seq { flex:0 0 auto; min-width:1.7em; text-align:right; font-size:11px; line-height:1.95; opacity:.48; font-variant-numeric:tabular-nums; }
      .cgpt-psn-prompt-text { min-width:0; flex:1 1 auto; }
      .cgpt-psn-item-actions { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:6px; }
      .cgpt-psn-pagination { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px 0 2px; margin-top:4px; border-top:1px solid rgba(0,0,0,.09); background:rgba(255,255,255,.985); }
      .cgpt-psn-page-info { flex:1; text-align:center; font-size:11px; opacity:.7; white-space:nowrap; }
      .cgpt-psn-foot { opacity:.55; font-size:11px; margin-top:8px; }
      #cgpt-psn-toast { position:fixed; left:50%; bottom:26px; transform:translateX(-50%); z-index:2147483647; background:rgba(0,0,0,.82); color:#fff; border-radius:9px; padding:8px 12px; font:13px system-ui; pointer-events:none; opacity:0; transition:opacity .18s; }
      @media (prefers-color-scheme: dark) {
        #cgpt-psn-root { color:#eee; }
        #cgpt-psn-button, #cgpt-psn-panel { background:rgba(31,31,31,.97); color:#eee; border-color:rgba(255,255,255,.16); }
        .cgpt-psn-status { background:rgba(255,255,255,.08); }
        .cgpt-psn-actions button, .cgpt-psn-item button, .cgpt-psn-pagination button { background:#282828; color:#eee; border-color:rgba(255,255,255,.16); }
        .cgpt-psn-item { border-top-color:rgba(255,255,255,.11); }
        .cgpt-psn-pagination { background:rgba(31,31,31,.97); border-top-color:rgba(255,255,255,.11); }
      }
      @media (max-width: 640px) {
        #cgpt-psn-root { left:8px; right:8px; bottom:76px; }
        #cgpt-psn-button { float:right; }
        #cgpt-psn-panel { width:100%; height:auto; max-height:none; overflow:visible; box-sizing:border-box; padding:10px; }
        .cgpt-psn-actions button { flex:1 1 calc(50% - 3px); padding:6px 5px; }
        .cgpt-psn-preview { max-height:none; overflow:visible; font-size:13.5px; line-height:1.55; }
        .cgpt-psn-item-actions { gap:4px; }
        .cgpt-psn-item-actions button { min-width:0; padding:4px 2px; font-size:10.5px; }
      }
    `;
    document.head?.appendChild(st);
  }

  function ensureUI() {
    if (!document.body || document.getElementById('cgpt-psn-root')) return;

    injectStyle();

    uiRoot = document.createElement('div');
    uiRoot.id = 'cgpt-psn-root';
    uiRoot.innerHTML = `
      <div id="cgpt-psn-panel">
        <div class="cgpt-psn-title">Prompt 安全网</div>
        <div class="cgpt-psn-status" id="cgpt-psn-status">正在保护输入内容</div>
        <div class="cgpt-psn-actions">
          <button data-act="restore-draft">恢复未发送草稿</button>
          <button data-act="restore-last">恢复上次发送</button>
          <button data-act="copy-last">复制上次发送</button>
          <button data-act="export">导出</button>
          <button data-act="clear">清空记录</button>
        </div>
        <div id="cgpt-psn-list"></div>
        <div id="cgpt-psn-pagination" class="cgpt-psn-pagination" hidden></div>
        <div class="cgpt-psn-foot">仅保存文字 Prompt；附件/图片不会被备份。普通历史最多保留 200 条，收藏不参与自动淘汰。数据保存在 Tampermonkey 本地脚本存储中。</div>
      </div>
      <button id="cgpt-psn-button" title="Prompt 安全网">Prompt 安全网</button>
    `;

    document.body.appendChild(uiRoot);
    uiPanel = uiRoot.querySelector('#cgpt-psn-panel');
    uiButton = uiRoot.querySelector('#cgpt-psn-button');
    uiStatus = uiRoot.querySelector('#cgpt-psn-status');
    uiList = uiRoot.querySelector('#cgpt-psn-list');
    uiPager = uiRoot.querySelector('#cgpt-psn-pagination');

    uiButton.addEventListener('click', () => {
      uiPanel.classList.toggle('open');
      updatePanel();
    });

    uiPanel.addEventListener('click', async (e) => {
      const b = e.target.closest('button');
      if (!b) return;

      const act = b.dataset.act;
      if (act === 'restore-draft') restoreUnsentDraft();
      if (act === 'restore-last') restoreLastSent();
      if (act === 'copy-last') await copyLastSent();
      if (act === 'export') exportHistory();

      if (act === 'clear') {
        try {
          for (const key of GM_listValues()) {
            if (key.startsWith(K.DRAFT_PREFIX)) remove(key);
          }
        } catch {
          remove(draftKey());
        }
        remove(K.HISTORY);
        remove(K.LAST_SENT);
        currentPending = null;
        historyPage = 0;
        setStatus('本地 Prompt 记录已清空', 'ok');
        updatePanel();
        toast('记录已清空');
      }

      if (act === 'restore-history') {
        const id = b.dataset.id;
        const item = getHistory().find(x => x.id === id);
        if (item?.text && setEditorText(item.text)) {
          toast('已恢复到输入框（不会自动发送）');
        }
      }

      if (act === 'copy-history') {
        const id = b.dataset.id;
        const item = getHistory().find(x => x.id === id);
        if (item?.text) {
          try {
            await navigator.clipboard.writeText(item.text);
            toast('已复制');
          } catch {
            toast('剪贴板权限被浏览器拒绝');
          }
        }
      }

      if (act === 'delete-history') {
        const id = b.dataset.id;
        if (window.confirm('删除这条 Prompt 记录？')) {
          deleteHistoryItem(id);
        }
      }

      if (act === 'toggle-favorite') {
        toggleFavorite(b.dataset.id);
      }

      if (act === 'page-prev') {
        historyPage = Math.max(0, historyPage - 1);
        updatePanel();
      }

      if (act === 'page-next') {
        historyPage += 1;
        updatePanel();
      }
    });

    updatePanel();
  }

  function setStatus(msg, tone = 'ok') {
    lastUiStatus = msg;
    ensureUI();
    if (uiStatus) uiStatus.textContent = msg;
    if (uiButton) {
      uiButton.dataset.tone = tone;
      uiButton.textContent =
        tone === 'bad' ? 'Prompt 安全网 · 离线' :
        tone === 'warn' ? 'Prompt 安全网 · 疑似卡住' :
        'Prompt 安全网';
    }
  }

  function fmtTime(ts) {
    try {
      return new Date(ts).toLocaleString(undefined, { hour12: false });
    } catch {
      return '';
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  }

  function historyItemHtml(item, absoluteIndex) {
    return `
      <div class="cgpt-psn-item" data-favorite="${item.favorite ? 'true' : 'false'}">
        <div class="cgpt-psn-meta">${item.favorite ? '★ 已收藏 · ' : ''}${escapeHtml(fmtTime(item.sentAt))} · 已使用 ${escapeHtml(Number(item.useCount) || 1)} 次 · ${escapeHtml(item.status || 'saved')}</div>
        <div class="cgpt-psn-preview">
          <span class="cgpt-psn-seq">${absoluteIndex + 1}.</span>
          <span class="cgpt-psn-prompt-text">${escapeHtml(item.text || '')}</span>
        </div>
        <div class="cgpt-psn-item-actions">
          <button data-act="restore-history" data-id="${escapeHtml(item.id)}">恢复</button>
          <button data-act="copy-history" data-id="${escapeHtml(item.id)}">复制</button>
          <button data-act="delete-history" data-id="${escapeHtml(item.id)}">删除</button>
          <button data-act="toggle-favorite" data-id="${escapeHtml(item.id)}">${item.favorite ? '取消收藏' : '收藏'}</button>
        </div>
      </div>
    `;
  }

  function adaptivePageContentBudget() {
    const viewportTarget = Math.floor(window.innerHeight * CFG.panelViewportRatio);
    const panelHeight = uiPanel?.getBoundingClientRect().height || 0;
    const listHeight = uiList?.getBoundingClientRect().height || 0;
    const nonListHeight = panelHeight > 0
      ? Math.max(150, panelHeight - listHeight)
      : 190;

    // Reserve room for pagination because it appears only when multiple pages exist.
    return Math.max(
      CFG.minPageContentHeight,
      viewportTarget - nonListHeight - 44
    );
  }

  function buildAdaptivePages(hist) {
    if (!hist.length) return [];

    const width = Math.max(
      260,
      Math.floor(uiList?.getBoundingClientRect().width || uiPanel?.getBoundingClientRect().width || 406)
    );
    const measure = document.createElement('div');
    measure.style.cssText = `
      position:fixed;
      left:-10000px;
      top:0;
      width:${width}px;
      visibility:hidden;
      pointer-events:none;
      z-index:-1;
    `;
    measure.innerHTML = hist.map((item, index) => historyItemHtml(item, index)).join('');
    document.body.appendChild(measure);

    const heights = [...measure.children].map(el => Math.ceil(el.getBoundingClientRect().height));
    measure.remove();

    const budget = adaptivePageContentBudget();
    const pages = [];
    let start = 0;
    let used = 0;

    for (let i = 0; i < heights.length; i++) {
      const h = heights[i];

      // Always allow at least one full Prompt per page, even if it alone is tall.
      if (i > start && used + h > budget) {
        pages.push({ start, end: i });
        start = i;
        used = 0;
      }
      used += h;
    }

    pages.push({ start, end: hist.length });
    return pages;
  }

  function updatePanel() {
    ensureUI();
    if (!uiList || !uiPager) return;

    const hist = getHistory();
    if (!hist.length) {
      historyPage = 0;
      uiList.innerHTML = '<div class="cgpt-psn-meta">还没有发送历史。</div>';
      uiPager.hidden = true;
      uiPager.innerHTML = '';
      return;
    }

    const pages = buildAdaptivePages(hist);
    const totalPages = Math.max(1, pages.length);
    historyPage = Math.min(Math.max(0, historyPage), totalPages - 1);
    const page = pages[historyPage] || { start: 0, end: hist.length };
    const pageItems = hist.slice(page.start, page.end);

    uiList.innerHTML = pageItems
      .map((item, index) => historyItemHtml(item, page.start + index))
      .join('');

    uiPager.hidden = totalPages <= 1;
    uiPager.innerHTML = totalPages <= 1 ? '' : `
      <button data-act="page-prev" ${historyPage === 0 ? 'disabled' : ''}>‹ 上一页</button>
      <span class="cgpt-psn-page-info">${historyPage + 1} / ${totalPages} · ${page.start + 1}-${page.end} / ${hist.length} 条</span>
      <button data-act="page-next" ${historyPage >= totalPages - 1 ? 'disabled' : ''}>下一页 ›</button>
    `;
  }

  let toastTimer = null;
  function toast(msg) {
    if (!document.body) return;
    let el = document.getElementById('cgpt-psn-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'cgpt-psn-toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.opacity = '0'; }, 2200);
  }

  // ---------- Event wiring ----------
  function onDocumentInput(e) {
    const el = getEditor();
    if (!el) return;
    if (e.target === el || el.contains?.(e.target)) {
      editorTouchedThisSession = true;
      scheduleDraftSave();
    }
  }

  function onDocumentKeydown(e) {
    const el = getEditor();
    if (!el) return;
    if (!(e.target === el || el.contains?.(e.target))) return;
    if (e.isComposing) return;

    // ChatGPT normally uses Enter to submit and Shift+Enter for newline.
    if (e.key === 'Enter' && !e.shiftKey) {
      captureSubmittedPrompt('keydown');
    }
  }

  function onDocumentClick(e) {
    if (sendButtonFromTarget(e.target)) {
      captureSubmittedPrompt('click');
    }
  }

  function onDocumentSubmit(e) {
    const el = getEditor();
    if (el && e.target?.contains?.(el)) {
      captureSubmittedPrompt('submit');
    }
  }

  function routeWatcher() {
    const rk = routeKey();
    if (rk === currentRouteKey) return;
    currentRouteKey = rk;
    setTimeout(maybeAutoRestore, 300);
  }

  function initAfterDom() {
    ensureUI();
    currentRouteKey = routeKey();
    resumeRecentPending();
    maybeAutoRestore();

    window.addEventListener('online', () => setStatus('网络已恢复', 'ok'));
    window.addEventListener('offline', () => setStatus('浏览器已离线；Prompt 备份仍在', 'bad'));

    setInterval(routeWatcher, 700);
    setInterval(saveDraftNow, CFG.autosaveHeartbeatMs);
    setInterval(monitorConnectionAndProgress, CFG.pollMs);
    window.addEventListener('beforeunload', saveDraftNow);

    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        historyPage = 0;
        updatePanel();
      }, 160);
    });

    if (!navigator.onLine) setStatus('浏览器已离线；Prompt 备份仍在', 'bad');
    else setStatus('正在保护输入内容', 'ok');
  }

  document.addEventListener('input', onDocumentInput, true);
  document.addEventListener('keydown', onDocumentKeydown, true);
  document.addEventListener('click', onDocumentClick, true);
  document.addEventListener('submit', onDocumentSubmit, true);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAfterDom, { once: true });
  } else {
    initAfterDom();
  }
})();
