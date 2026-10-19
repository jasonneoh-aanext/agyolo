const NEW_SESSION_KEY = '__new__';

// Active session key currently displayed in the main viewport ('__new__', a sessionId, or a provisional turnId)
let activeViewKey = NEW_SESSION_KEY;

// Per-session view state store: Map<key, SessionViewState>
const sessionStates = new Map();

// Server session summaries from GET /api/sessions
let knownSessions = [];
let defaultWorkspace = '';

// Preserve user's option selections & write-in text per question across live transcript refreshes
const questionDrafts = new Map();

// Track active SSE stream readers so we don't attach duplicate streams for the same session/turn
const activeStreamAttachments = new Set();

// Map of turnId / sessionId -> stateRef ({ current: SessionViewState }) for routing Tauri IPC turn events
const tauriTurnRefs = new Map();

function isTauriRuntime() {
  return Boolean(
    window.__TAURI__ &&
      window.__TAURI__.core &&
      typeof window.__TAURI__.core.invoke === 'function'
  );
}

function tauriInvoke(cmd, args = {}) {
  return window.__TAURI__.core.invoke(cmd, args);
}

async function setupTauriEventListener() {
  if (
    !isTauriRuntime() ||
    !window.__TAURI__.event ||
    typeof window.__TAURI__.event.listen !== 'function'
  ) {
    return;
  }

  await window.__TAURI__.event.listen('agy-turn-event', async (evt) => {
    const payload = evt && evt.payload;
    if (!payload || !payload.event) return;
    const { event, data = {} } = payload;
    const turnId = data.turnId || null;
    const sessionId = data.sessionId || null;

    let stateRef =
      (turnId && tauriTurnRefs.get(turnId)) ||
      (sessionId && tauriTurnRefs.get(sessionId)) ||
      null;

    if (!stateRef) {
      const targetKey = sessionId || turnId;
      if (!targetKey) return;
      const state = getOrCreateSessionState(targetKey, {
        sessionId: sessionId || null,
        turnId: turnId || null
      });
      stateRef = { current: state };
      if (turnId) tauriTurnRefs.set(turnId, stateRef);
      if (sessionId) tauriTurnRefs.set(sessionId, stateRef);
    }

    if (sessionId && !tauriTurnRefs.has(sessionId)) {
      tauriTurnRefs.set(sessionId, stateRef);
    }

    await handleSessionSseEvent(stateRef, event, data);

    if (event === 'exit' || event === 'error') {
      if (turnId) {
        tauriTurnRefs.delete(turnId);
        activeStreamAttachments.delete(turnId);
      }
      if (sessionId) {
        tauriTurnRefs.delete(sessionId);
        activeStreamAttachments.delete(sessionId);
      }
    }
  });
}

const streamEl = document.getElementById('stream');
const viewportEl = document.getElementById('viewport');
const sidebarEl = document.getElementById('sidebar');
const sidebarToggleBtn = document.getElementById('sidebarToggleBtn');
const sidebarListEl = document.getElementById('sidebarList');
const sidebarCountEl = document.getElementById('sidebarCount');
const activeRunsBadgeEl = document.getElementById('activeRunsBadge');
const activeRunsTextEl = document.getElementById('activeRunsText');
const cwdInput = document.getElementById('cwdInput');
const workspacePresetsEl = document.getElementById('workspacePresets');
const newSessionBtn = document.getElementById('newSessionBtn');
const promptInput = document.getElementById('promptInput');
const sendBtn = document.getElementById('sendBtn');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');

function createSessionState(key, overrides = {}) {
  return {
    key,
    sessionId: key !== NEW_SESSION_KEY && !key.startsWith('turn-') ? key : null,
    turnId: key.startsWith('turn-') ? key : null,
    title: 'New Session',
    workspace: cwdInput.value.trim() || defaultWorkspace || '',
    items: [],
    permissions: [],
    stepCount: 0,
    updatedAt: new Date().toISOString(),
    createdLocally: false,
    isRunning: false,
    statusState: 'idle',
    statusMessage: key === NEW_SESSION_KEY ? 'New Session · Ready' : 'Idle · Ready',
    progressLabel: '',
    hasPendingQuestion: false,
    pendingBackgroundCount: 0,
    sessionError: null,
    draftPrompt: '',
    expandedGroupIds: new Set(),
    openItemIds: new Set(),
    ...overrides
  };
}

function getOrCreateSessionState(key, overrides = {}) {
  if (!sessionStates.has(key)) {
    sessionStates.set(key, createSessionState(key, overrides));
  } else if (Object.keys(overrides).length > 0) {
    Object.assign(sessionStates.get(key), overrides);
  }
  return sessionStates.get(key);
}

function getActiveState() {
  return getOrCreateSessionState(activeViewKey);
}

function migrateSessionKey(oldKey, newSessionId) {
  if (!oldKey || !newSessionId || oldKey === newSessionId) return getOrCreateSessionState(newSessionId);
  const existingOld = sessionStates.get(oldKey);
  const existingNew = sessionStates.get(newSessionId);

  if (existingOld) {
    existingOld.key = newSessionId;
    existingOld.sessionId = newSessionId;
    if (existingNew) {
      // Merge into existingOld and replace
      if (existingOld.items.length === 0 && existingNew.items.length > 0) {
        existingOld.items = existingNew.items;
      }
      if (existingOld.permissions.length === 0 && existingNew.permissions.length > 0) {
        existingOld.permissions = existingNew.permissions;
      }
    }
    sessionStates.set(newSessionId, existingOld);
    sessionStates.delete(oldKey);
  }

  if (activeStreamAttachments.has(oldKey)) {
    activeStreamAttachments.add(newSessionId);
  }
  if (tauriTurnRefs.has(oldKey)) {
    tauriTurnRefs.set(newSessionId, tauriTurnRefs.get(oldKey));
  }

  if (activeViewKey === oldKey) {
    activeViewKey = newSessionId;
    syncSessionUrlParam(newSessionId);
  }

  return getOrCreateSessionState(newSessionId);
}

function getSessionParamFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const val = params.get('session');
  return val ? val.trim() : null;
}

function syncSessionUrlParam(sessionId) {
  try {
    const url = new URL(window.location.href);
    if (sessionId && !sessionId.startsWith('turn-') && sessionId !== NEW_SESSION_KEY) {
      url.searchParams.set('session', sessionId);
    } else {
      url.searchParams.delete('session');
    }
    window.history.replaceState({}, '', url);
  } catch (_) {
    // Ignore history API restrictions in custom schemes
  }
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatMarkdownLite(text) {
  let html = escapeHtml(text);
  html = html.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_, _lang, code) => {
    return `<pre>${code.trim()}</pre>`;
  });
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  return html;
}

function formatWorkspaceShort(wsPath) {
  if (!wsPath) return '';
  const parts = String(wsPath).replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || wsPath;
}

function scrollToBottom() {
  viewportEl.scrollTop = viewportEl.scrollHeight;
}

function useQuickPrompt(text) {
  const state = getActiveState();
  state.draftPrompt = text;
  promptInput.value = text;
  promptInput.focus();
}

function syncComposerAndStatusBar() {
  const state = getActiveState();
  statusText.textContent = state.statusMessage || 'Idle · Ready';

  let dotClass = 'done';
  if (state.statusState === 'error') {
    dotClass = 'error';
  } else if (state.hasPendingQuestion) {
    dotClass = 'waiting';
  } else if (state.isRunning) {
    dotClass = 'running';
  }
  statusDot.className = 'dot ' + dotClass;

  // Composer is only disabled for the session that is currently running
  sendBtn.disabled = Boolean(state.isRunning);
}

function renderSidebar() {
  if (newSessionBtn) {
    const isNewSessionActive = activeViewKey === NEW_SESSION_KEY;
    newSessionBtn.classList.toggle('active', isNewSessionActive);
    newSessionBtn.setAttribute('aria-current', isNewSessionActive ? 'true' : 'false');
  }

  // Combine in-flight provisional/running turns (not yet in knownSessions) + knownSessions
  const displayEntries = [];
  const seenSessionIds = new Set();
  const knownSessionIdSet = new Set(knownSessions.map((s) => s.id));

  // 1. Include any newly started turns (after first message sent) not yet in knownSessions at the top
  const inFlightStates = Array.from(sessionStates.entries())
    .filter(
      ([key, st]) =>
        key !== NEW_SESSION_KEY &&
        !knownSessionIdSet.has(key) &&
        ((key.startsWith('turn-') && !st.sessionId) || st.isRunning || st.createdLocally)
    )
    .sort(([, a], [, b]) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

  for (const [key, st] of inFlightStates) {
    seenSessionIds.add(key);
    displayEntries.push({
      key,
      sessionId: st.sessionId || null,
      title: st.title || 'Starting New Session...',
      shortId: st.sessionId ? st.sessionId.slice(0, 8) : 'spawning',
      workspace: st.workspace || '',
      stepCount: st.stepCount || st.items.length,
      isRunning: st.isRunning,
      hasPendingQuestion: st.hasPendingQuestion,
      statusState: st.statusState,
      progressLabel: st.progressLabel || st.statusMessage
    });
  }

  // 2. Merge server-known sessions with local sessionStates
  for (const s of knownSessions) {
    if (seenSessionIds.has(s.id)) continue;
    seenSessionIds.add(s.id);
    const local = sessionStates.get(s.id);
    const isRunning = Boolean((local && local.isRunning) || s.isRunning);
    const hasPendingQuestion = Boolean(
      (local && local.hasPendingQuestion) || s.hasPendingQuestion
    );
    const progressLabel =
      (local && local.progressLabel) ||
      s.progressLabel ||
      (local && local.statusMessage) ||
      s.statusMessage ||
      '';
    const stepCount = Math.max(
      s.stepCount || 0,
      local && local.stepCount ? local.stepCount : 0,
      local && local.items ? local.items.length : 0
    );

    displayEntries.push({
      key: s.id,
      sessionId: s.id,
      title: s.title || (local && local.title) || `Session ${s.id.slice(0, 8)}`,
      shortId: s.id.slice(0, 8),
      workspace: s.workspace || (local && local.workspace) || '',
      stepCount,
      isRunning,
      hasPendingQuestion,
      statusState: (local && local.statusState) || s.state || 'idle',
      progressLabel
    });
  }

  // 3. Include any locally loaded session not in top 50 knownSessions
  for (const [key, st] of sessionStates.entries()) {
    if (
      key !== NEW_SESSION_KEY &&
      !key.startsWith('turn-') &&
      !seenSessionIds.has(key) &&
      (st.items.length > 0 || st.isRunning || activeViewKey === key)
    ) {
      displayEntries.push({
        key,
        sessionId: key,
        title: st.title || `Session ${key.slice(0, 8)}`,
        shortId: key.slice(0, 8),
        workspace: st.workspace || '',
        stepCount: st.stepCount || st.items.length,
        isRunning: st.isRunning,
        hasPendingQuestion: st.hasPendingQuestion,
        statusState: st.statusState,
        progressLabel: st.progressLabel || st.statusMessage
      });
    }
  }

  // Count total active running turns across all sessions
  const runningCount = displayEntries.filter((e) => e.isRunning).length;
  if (runningCount > 0) {
    activeRunsBadgeEl.classList.add('visible');
    activeRunsTextEl.textContent = `${runningCount} Active`;
  } else {
    activeRunsBadgeEl.classList.remove('visible');
  }

  sidebarCountEl.textContent = String(displayEntries.length);

  if (displayEntries.length === 0) {
    sidebarListEl.innerHTML = `<div class="sidebar-empty">No sessions yet. Start a new session!</div>`;
    return;
  }

  const html = displayEntries
    .map((entry) => {
      const isActive = entry.key === activeViewKey;
      const classes = [
        'session-item',
        isActive ? 'active' : '',
        entry.isRunning ? 'running' : '',
        entry.hasPendingQuestion ? 'needs-input' : ''
      ]
        .filter(Boolean)
        .join(' ');

      let dotClass = 'done';
      if (entry.statusState === 'error') {
        dotClass = 'error';
      } else if (entry.hasPendingQuestion) {
        dotClass = 'waiting';
      } else if (entry.isRunning) {
        dotClass = 'running';
      }

      const wsShort = formatWorkspaceShort(entry.workspace);
      const stepsLabel = `${entry.stepCount || 0} steps`;

      const progressHtml =
        entry.isRunning || entry.hasPendingQuestion
          ? `
            <div class="session-progress-box">
              <div class="session-progress-label">${escapeHtml(
                entry.progressLabel || (entry.hasPendingQuestion ? '? Waiting for answer' : 'Running...')
              )}</div>
              <div class="session-progress-bar">
                <div class="session-progress-fill"></div>
              </div>
            </div>
          `
          : '';

      return `
        <button
          type="button"
          class="${classes}"
          aria-current="${isActive ? 'true' : 'false'}"
          data-session-key="${escapeHtml(entry.key)}"
          onclick="selectSessionFromSidebar('${escapeHtml(entry.key)}')"
        >
          <div class="session-item-top">
            <span class="dot ${dotClass}"></span>
            <span class="session-item-title">${escapeHtml(entry.title)}</span>
            <span class="session-item-id">${escapeHtml(entry.shortId)}</span>
          </div>
          <div class="session-item-meta">
            <span class="session-workspace-tag" title="${escapeHtml(entry.workspace)}">${escapeHtml(
              wsShort || 'workspace'
            )}</span>
            <span>${escapeHtml(stepsLabel)}</span>
          </div>
          ${progressHtml}
        </button>
      `;
    })
    .join('');

  sidebarListEl.innerHTML = html;
}

function getDraft(sessionKey, itemId, qIdx, isMulti) {
  const key = `${sessionKey}::${itemId}::${qIdx}`;
  if (!questionDrafts.has(key)) {
    questionDrafts.set(key, {
      selectedIndices: isMulti ? [] : [0],
      writeIn: ''
    });
  }
  return questionDrafts.get(key);
}

function toggleAskOption(itemId, qIdx, optIdx, isMulti) {
  const state = getActiveState();
  const draft = getDraft(state.key, itemId, qIdx, isMulti);
  if (isMulti) {
    const pos = draft.selectedIndices.indexOf(optIdx);
    if (pos >= 0) {
      draft.selectedIndices.splice(pos, 1);
    } else {
      draft.selectedIndices.push(optIdx);
    }
  } else {
    draft.selectedIndices = [optIdx];
    draft.writeIn = '';
  }
  renderStream();
}

function updateAskWriteIn(itemId, qIdx, isMulti, value) {
  const state = getActiveState();
  const draft = getDraft(state.key, itemId, qIdx, isMulti);
  draft.writeIn = value;
}

async function submitAskQuestionCard(itemId, action = 'submit') {
  const state = getActiveState();
  const item = state.items.find((i) => i.id === itemId);
  if (!item) return;

  const questions = item.questions || [];
  const answers = questions.map((q, qIdx) => {
    const draft = getDraft(state.key, itemId, qIdx, Boolean(q.is_multi_select));
    return {
      selectedIndices: draft.selectedIndices,
      writeIn: (draft.writeIn || '').trim()
    };
  });

  state.statusState = 'running';
  state.hasPendingQuestion = false;
  state.statusMessage =
    action === 'skip' ? 'Skipping AskQuestion in PTY...' : 'Sending AskQuestion answer to PTY...';
  state.progressLabel = state.statusMessage;
  syncComposerAndStatusBar();
  renderSidebar();

  try {
    const resumeHistoricalSessionWithAnswer = async () => {
      const summaryLines = questions.map((q, qIdx) => {
        if (action === 'skip') return 'Skip';
        const ans = answers[qIdx];
        if (ans.writeIn) return ans.writeIn;
        const opts = q.options || [];
        return ans.selectedIndices.map((i) => opts[i]).filter(Boolean).join(', ') || opts[0] || '';
      });
      promptInput.value = summaryLines.join('\n');
      state.draftPrompt = promptInput.value;
      await sendChat();
    };

    if (isTauriRuntime()) {
      const res = await tauriInvoke('submit_ask_question', {
        sessionId: state.sessionId,
        turnId: state.turnId,
        action,
        answers
      });
      if (res && res.canResumeAsPrompt && !state.isRunning) {
        await resumeHistoricalSessionWithAnswer();
        return;
      }
      if (!res || !res.ok) {
        throw new Error((res && res.error) || 'Failed to submit AskQuestion');
      }
      return;
    }

    const res = await fetch('/api/ask-question', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: state.sessionId,
        turnId: state.turnId,
        stepIndex: item.stepIndex,
        action,
        answers
      })
    });

    if (res.status === 409 && !state.isRunning) {
      await resumeHistoricalSessionWithAnswer();
      return;
    }

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error || `Failed to submit AskQuestion (${res.status})`);
    }
  } catch (err) {
    if (state.isRunning) {
      state.hasPendingQuestion = true;
    }
    state.statusState = 'error';
    state.statusMessage = `Error: ${err.message || String(err)}`;
    state.progressLabel = state.statusMessage;
    syncComposerAndStatusBar();
    renderSidebar();
  }
}

function renderAskQuestionCard(state, item) {
  const isAnswered = item.status === 'done';
  const cardClass = isAnswered ? 'ask-card answered' : 'ask-card';
  const badgeText = isAnswered
    ? '✓ Answered'
    : state.isRunning
      ? '● Interactive Question · Waiting for your selection'
      : '○ Unanswered · Submit to Resume Session';

  const questions = item.questions || [];
  const qBlocks = questions.map((q, qIdx) => {
    const isMulti = Boolean(q.is_multi_select);
    const options = Array.isArray(q.options) ? q.options : [];
    const draft = getDraft(state.key, item.id, qIdx, isMulti);
    const recordedAnswer = item.parsedAnswers && item.parsedAnswers[qIdx];

    const optsHtml = options
      .map((optText, optIdx) => {
        const isSelected = isAnswered
          ? recordedAnswer && recordedAnswer.includes(optText)
          : draft.selectedIndices.includes(optIdx) && !draft.writeIn;
        const activeClass = isSelected ? 'active' : '';
        const indicator = isMulti
          ? isSelected
            ? '[✓]'
            : '[ ]'
          : isSelected
            ? '▸'
            : `${optIdx + 1}.`;

        return `
          <button
            type="button"
            class="ask-opt-btn ${activeClass}"
            ${isAnswered ? 'disabled' : ''}
            onclick="toggleAskOption('${item.id}', ${qIdx}, ${optIdx}, ${isMulti})"
          >
            <span class="ask-opt-indicator">${indicator}</span>
            <span>${escapeHtml(optText)}</span>
          </button>
        `;
      })
      .join('');

    const footerSection = isAnswered
      ? `<div class="ask-answer-summary">Answer: ${escapeHtml(recordedAnswer || (item.output || '').trim() || 'Skipped')}</div>`
      : `
        <div class="ask-writein-wrap">
          <input
            type="text"
            class="ask-writein-input"
            placeholder="${options.length + 1}. Write-in... (type custom response)"
            value="${escapeHtml(draft.writeIn)}"
            oninput="updateAskWriteIn('${item.id}', ${qIdx}, ${isMulti}, this.value)"
            onkeydown="if (event.key === 'Enter') { event.preventDefault(); submitAskQuestionCard('${item.id}', 'submit'); }"
          />
        </div>
      `;

    return `
      <div class="ask-q-block">
        <div class="ask-q-title">
          <span>Question ${qIdx + 1}/${questions.length}: ${escapeHtml(q.question || '')}</span>
          <span class="ask-q-mode">${isMulti ? 'Multi-select (Space / Checkboxes)' : 'Single-select'}</span>
        </div>
        <div class="ask-options-list">${optsHtml}</div>
        ${footerSection}
      </div>
    `;
  });

  const actionsHtml = isAnswered
    ? ''
    : `
      <div class="ask-actions">
        <button type="button" class="btn-ask-skip" onclick="submitAskQuestionCard('${item.id}', 'skip')">
          Skip (Esc)
        </button>
        <button type="button" class="btn-ask-submit" onclick="submitAskQuestionCard('${item.id}', 'submit')">
          Submit Answer ↵
        </button>
      </div>
    `;

  return `
    <div class="${cardClass}" id="${item.id}">
      <div class="ask-top">
        <div class="perm-title">
          <span>? AskQuestion · ${escapeHtml(item.summary || 'Clarification Required')}</span>
        </div>
        <span class="ask-badge">${badgeText}</span>
      </div>
      ${qBlocks.join('')}
      ${actionsHtml}
    </div>
  `;
}

function renderStream() {
  const state = getActiveState();
  const renderedItems = state.items || [];
  const renderedPermissions = state.permissions || [];

  if (renderedItems.length === 0 && renderedPermissions.length === 0) {
    if (state.sessionError) {
      streamEl.innerHTML = `
        <div class="error-state" role="alert">
          <div class="error-badge">Session Not Found</div>
          <h2>Could not load session</h2>
          <p>Session <code>${escapeHtml(state.sessionError.sessionId)}</code> was not found.</p>
          <div class="quick-chips">
            <button class="chip" type="button" onclick="loadSession(null)">
              + Start a New Session
            </button>
          </div>
        </div>
      `;
      return;
    }

    streamEl.innerHTML = `
      <div class="empty-state">
        <h2>Antigravity Headless PTY Session</h2>
        <p>
          Run multiple concurrent sessions from the sidebar. Messages, background tasks, tool calls, and interactive <code>ask_question</code> modals stream live from <code>transcript_full.jsonl</code>.
        </p>
        <div class="quick-chips">
          <button class="chip" onclick="useQuickPrompt('Read lines 1 to 3 of ~/.zshrc using view_file and summarize them.')">
            Trigger Outside-Workspace Prompt (~/.zshrc)
          </button>
          <button class="chip" onclick="useQuickPrompt('Call ask_question to ask me whether this repo should be Private or Public, then repeat my answer.')">
            Trigger Interactive ask_question UI
          </button>
          <button class="chip" onclick="useQuickPrompt('Run echo HELLO_AGY_SANDBOX using run_command with BypassSandbox set to true.')">
            Trigger Unsandboxed Command Prompt
          </button>
        </div>
      </div>
    `;
    return;
  }

  const entries = interleaveChronologicalEntries(renderedItems, renderedPermissions);
  const blocks = groupStreamEntries(entries);
  const fragments = [];

  for (const block of blocks) {
    if (block.type === 'single') {
      const item = block.data;
      if (block.kind === 'user') {
        fragments.push(`<div class="msg-user">${escapeHtml(item.content)}</div>`);
      } else if (block.kind === 'ask_question') {
        fragments.push(renderAskQuestionCard(state, item));
      } else if (block.kind === 'assistant') {
        fragments.push(`<div class="msg-assistant">${formatMarkdownLite(item.content)}</div>`);
      }
    } else if (block.type === 'tool_group') {
      fragments.push(renderToolGroup(state, block));
    }
  }

  streamEl.innerHTML = fragments.join('\n');
}

function toggleToolGroup(groupId) {
  const state = getActiveState();
  if (state.expandedGroupIds.has(groupId)) {
    state.expandedGroupIds.delete(groupId);
  } else {
    state.expandedGroupIds.add(groupId);
  }
  renderStream();
}

function toggleStreamItem(itemId) {
  if (window.getSelection && String(window.getSelection()).length > 0) return;
  const state = getActiveState();
  if (state.openItemIds.has(itemId)) {
    state.openItemIds.delete(itemId);
  } else {
    state.openItemIds.add(itemId);
  }
  renderStream();
}

function matchesPermToToolItem(perm, item) {
  if (!item || item.role !== 'tool_call') return false;
  const target = (perm.target || '').trim();
  if (target) {
    const detail = String(item.detail || '');
    const argsStr = JSON.stringify(item.args || {});
    const baseName = target.split('/').filter(Boolean).pop() || '';
    if (detail.includes(target) || argsStr.includes(target)) return true;
    if (baseName.length > 2 && (detail.includes(baseName) || argsStr.includes(baseName))) return true;
  }
  if (/command|sandbox/i.test(perm.title || '') && (item.toolName === 'run_command' || item.bypassSandbox)) {
    return true;
  }
  return false;
}

function interleaveChronologicalEntries(items, permissions) {
  const permsAfterIndex = new Map();
  const addPermAt = (idx, perm) => {
    if (!permsAfterIndex.has(idx)) permsAfterIndex.set(idx, []);
    permsAfterIndex.get(idx).push(perm);
  };

  const claimedToolItemIds = new Set();
  let maxStepIndex = -1;
  for (const item of items) {
    if (typeof item.stepIndex === 'number' && item.stepIndex > maxStepIndex) {
      maxStepIndex = item.stepIndex;
    }
  }

  for (const perm of permissions) {
    let targetIdx = -2;

    if (perm.afterItemId) {
      const idx = items.findIndex((it) => it.id === perm.afterItemId);
      if (idx >= 0) {
        targetIdx = idx;
        if (items[idx].role === 'tool_call') {
          claimedToolItemIds.add(items[idx].id);
        }
      }
    }

    if (targetIdx === -2 && !perm.isWorkspaceTrust && typeof perm.afterStepIndex === 'number') {
      let fallbackStepToolIdx = -2;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.role === 'tool_call' && it.stepIndex === perm.afterStepIndex && !claimedToolItemIds.has(it.id)) {
          if (matchesPermToToolItem(perm, it)) {
            targetIdx = i;
            break;
          }
          fallbackStepToolIdx = i;
        }
      }
      if (targetIdx === -2 && fallbackStepToolIdx >= 0) {
        targetIdx = fallbackStepToolIdx;
      }
      if (targetIdx >= 0) {
        claimedToolItemIds.add(items[targetIdx].id);
      }
    }

    if (targetIdx === -2 && !perm.isWorkspaceTrust) {
      const minStep =
        typeof perm.minToolStepIndex === 'number'
          ? perm.minToolStepIndex
          : typeof perm.turnStartStepIndex === 'number'
            ? perm.turnStartStepIndex
            : typeof perm.afterStepIndex === 'number'
              ? perm.afterStepIndex
              : 0;

      let turnStartIdx = -1;
      for (let i = 0; i < items.length; i++) {
        const s = typeof items[i].stepIndex === 'number' ? items[i].stepIndex : maxStepIndex + 1;
        if (s >= minStep) {
          turnStartIdx = i;
          break;
        }
      }

      if (turnStartIdx >= 0) {
        let turnEndIdx = items.length - 1;
        for (let i = turnStartIdx + 1; i < items.length; i++) {
          if (items[i].role === 'user') {
            turnEndIdx = i - 1;
            break;
          }
        }

        let firstUnclaimedToolIdx = -2;
        for (let i = turnStartIdx; i <= turnEndIdx; i++) {
          const it = items[i];
          if (it.role === 'tool_call' && !claimedToolItemIds.has(it.id)) {
            if (matchesPermToToolItem(perm, it)) {
              targetIdx = i;
              break;
            }
            if (firstUnclaimedToolIdx === -2) {
              firstUnclaimedToolIdx = i;
            }
          }
        }
        if (targetIdx === -2 && firstUnclaimedToolIdx >= 0) {
          targetIdx = firstUnclaimedToolIdx;
        }
        if (targetIdx >= 0) {
          claimedToolItemIds.add(items[targetIdx].id);
        }
      }
    }

    if (targetIdx === -2) {
      const targetStep =
        typeof perm.afterStepIndex === 'number'
          ? perm.afterStepIndex
          : typeof perm.turnStartStepIndex === 'number'
            ? perm.turnStartStepIndex
            : maxStepIndex + 1;

      let candidateIdx = -1;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const effStep = typeof it.stepIndex === 'number' ? it.stepIndex : maxStepIndex + 1;
        if (effStep <= targetStep && it.role !== 'assistant') {
          candidateIdx = i;
        }
      }
      if (candidateIdx === -1 && items.length > 0 && items[0].role === 'user') {
        candidateIdx = 0;
      }
      targetIdx = candidateIdx;
    }

    addPermAt(targetIdx, perm);
  }

  const entries = [];
  for (const perm of permsAfterIndex.get(-1) || []) {
    entries.push({ kind: 'permission', data: perm });
  }
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    entries.push({ kind: item.role, data: item });
    for (const perm of permsAfterIndex.get(i) || []) {
      entries.push({ kind: 'permission', data: perm });
    }
  }
  return entries;
}

function isFoldableKind(kind) {
  return kind === 'thought' || kind === 'tool_call' || kind === 'permission';
}

function groupStreamEntries(entries) {
  const blocks = [];
  let currentGroup = null;
  let groupSeq = 0;

  for (const entry of entries) {
    if (isFoldableKind(entry.kind)) {
      if (!currentGroup) {
        currentGroup = {
          type: 'tool_group',
          id: `group-seq-${groupSeq++}`,
          entries: []
        };
        blocks.push(currentGroup);
      }
      currentGroup.entries.push(entry);
    } else {
      currentGroup = null;
      blocks.push({
        type: 'single',
        kind: entry.kind,
        data: entry.data
      });
    }
  }
  return blocks;
}

function renderThoughtRow(state, item) {
  const isOpen = state.openItemIds.has(item.id) ? 'open' : '';
  const firstLine = (item.content || '').split(/\r?\n/)[0].slice(0, 90);
  return `
    <div class="muted-row ${isOpen}" data-id="${item.id}" onclick="toggleStreamItem('${item.id}')">
      <div class="muted-header">
        <span class="dot thought"></span>
        <span class="muted-title">Thought</span>
        <span class="muted-sub">${escapeHtml(firstLine)}</span>
      </div>
      <div class="muted-body">${escapeHtml(item.content)}</div>
    </div>
  `;
}

function renderToolCallRow(state, item) {
  const isOpen = state.openItemIds.has(item.id) ? 'open' : '';
  const dotClass = item.status === 'done' ? 'done' : 'running';
  const bypassBadge = item.bypassSandbox
    ? `<span class="muted-badge">BypassSandbox</span>`
    : '';
  const bgBadge =
    item.isBackground && item.status !== 'done'
      ? `<span class="muted-badge bg-task">⏳ Background Task</span>`
      : '';
  const bodyText =
    `Args: ${JSON.stringify(item.args, null, 2)}` +
    (item.output ? `\n\nOutput:\n${item.output.trim()}` : '\n\n(Waiting for tool execution...)');

  return `
    <div class="muted-row ${isOpen}" data-id="${item.id}" onclick="toggleStreamItem('${item.id}')">
      <div class="muted-header">
        <span class="dot ${dotClass}"></span>
        <span class="muted-title">${escapeHtml(item.toolName)}</span>
        <span class="muted-sub">${escapeHtml(item.summary)} ${item.detail ? '· ' + escapeHtml(item.detail) : ''}</span>
        ${bgBadge}
        ${bypassBadge}
      </div>
      <div class="muted-body">${escapeHtml(bodyText)}</div>
    </div>
  `;
}

function renderPermCard(state, perm) {
  const isApproved = perm.status === 'approved';
  const isOpen = state.openItemIds.has(perm.id) ? 'open' : '';
  const cardClass = [
    'permission-card',
    isApproved ? 'approved' : '',
    isOpen ? 'open' : ''
  ]
    .filter(Boolean)
    .join(' ');
  const dotClass = isApproved ? 'done' : 'running';
  const statusLabel = isApproved
    ? '✓ Auto-Approved · Simulated Enter (\\r)'
    : '● Prompt Detected · Sending Enter (350ms)...';

  const inlineTarget = perm.target || perm.question || perm.reason || '';
  const metaLines = [perm.target, perm.reason, perm.question].filter(Boolean).join('\n');
  const optionsHtml = (perm.options || [])
    .map((opt, idx) => {
      const sel = idx === 0 ? 'perm-opt selected' : 'perm-opt';
      const prefix = idx === 0 ? '↵ ' : '  ';
      return `<div class="${sel}">${escapeHtml(prefix + opt)}</div>`;
    })
    .join('');

  return `
    <div class="${cardClass}" id="${perm.id}" data-id="${perm.id}" onclick="toggleStreamItem('${perm.id}')">
      <div class="perm-top">
        <div class="perm-title">
          <span class="dot ${dotClass}"></span>
          <span>⚡ ${escapeHtml(perm.title || 'Permission Prompt')}</span>
          ${inlineTarget ? `<span class="perm-target-inline">· ${escapeHtml(inlineTarget)}</span>` : ''}
        </div>
        <span class="perm-status">${statusLabel}</span>
      </div>
      <div class="perm-body">
        <div class="perm-meta">${escapeHtml(metaLines || perm.snippet)}</div>
        <div class="perm-options">${optionsHtml}</div>
      </div>
    </div>
  `;
}

function renderToolGroup(state, group) {
  const isGroupOpen = state.expandedGroupIds.has(group.id);
  const groupClass = isGroupOpen ? 'tool-group open' : 'tool-group';
  const chevron = isGroupOpen ? '▾' : '▸';

  const toolEntries = group.entries.filter((e) => e.kind === 'tool_call').map((e) => e.data);
  const permEntries = group.entries.filter((e) => e.kind === 'permission').map((e) => e.data);
  const thoughtEntries = group.entries.filter((e) => e.kind === 'thought').map((e) => e.data);

  const lastTool = toolEntries.length > 0 ? toolEntries[toolEntries.length - 1] : null;
  const lastPerm = permEntries.length > 0 ? permEntries[permEntries.length - 1] : null;
  const lastThought = thoughtEntries.length > 0 ? thoughtEntries[thoughtEntries.length - 1] : null;

  const hasRunningTool = toolEntries.some((t) => t.status !== 'done');
  const hasRunningBgTool = toolEntries.some((t) => t.isBackground && t.status !== 'done');
  const hasPendingPerm = permEntries.some((p) => p.status !== 'approved');
  const dotClass =
    hasRunningTool || hasPendingPerm
      ? 'running'
      : toolEntries.length === 0 && permEntries.length === 0
        ? 'thought'
        : 'done';

  let headerTitle = 'Tool Sequence';
  let headerSub = '';
  let bypassBadge = '';

  if (lastTool) {
    headerTitle = lastTool.toolName;
    headerSub = `${lastTool.summary || ''}${lastTool.detail ? ' · ' + lastTool.detail : ''}`;
    if (lastTool.bypassSandbox) {
      bypassBadge = `<span class="muted-badge">BypassSandbox</span>`;
    }
  } else if (lastPerm) {
    headerTitle = `⚡ ${lastPerm.title || 'Permission Prompt'}`;
    headerSub = lastPerm.target || lastPerm.question || lastPerm.reason || 'Simulated Enter';
  } else if (lastThought) {
    headerTitle = 'Thought';
    headerSub = (lastThought.content || '').split(/\r?\n/)[0].slice(0, 90);
  }

  const bgGroupBadge = hasRunningBgTool
    ? `<span class="muted-badge bg-task">⏳ Background Running</span>`
    : '';

  const permBadge =
    permEntries.length > 0
      ? `<span class="tool-group-enter-pill ${hasPendingPerm ? 'pending' : ''}">${
          hasPendingPerm
            ? '● Sending Enter...'
            : `↵ Simulated Enter${permEntries.length > 1 ? ` (${permEntries.length})` : ''}`
        }</span>`
      : '';

  const countLabel = `${group.entries.length} ${group.entries.length === 1 ? 'item' : 'items'}`;

  const bodyHtml = group.entries
    .map((entry) => {
      if (entry.kind === 'thought') return renderThoughtRow(state, entry.data);
      if (entry.kind === 'tool_call') return renderToolCallRow(state, entry.data);
      if (entry.kind === 'permission') return renderPermCard(state, entry.data);
      return '';
    })
    .join('\n');

  return `
    <div class="${groupClass}" id="${group.id}" data-group-id="${group.id}">
      <div class="tool-group-header" onclick="toggleToolGroup('${group.id}')">
        <span class="tool-group-chevron">${chevron}</span>
        <span class="dot ${dotClass}"></span>
        <span class="muted-title">${escapeHtml(headerTitle)}</span>
        <span class="muted-sub">${escapeHtml(headerSub)}</span>
        ${bgGroupBadge}
        ${bypassBadge}
        ${permBadge}
        <span class="tool-group-count">${escapeHtml(countLabel)}</span>
      </div>
      <div class="tool-group-body">
        ${bodyHtml}
      </div>
    </div>
  `;
}

async function loadWorkspaces() {
  try {
    let data = null;
    if (isTauriRuntime()) {
      data = await tauriInvoke('get_workspaces');
    } else {
      const res = await fetch('/api/workspaces');
      if (!res.ok) return;
      data = await res.json();
    }
    if (!data) return;
    defaultWorkspace = data.defaultWorkspace || '';
    cwdInput.value = defaultWorkspace;
    workspacePresetsEl.innerHTML = (data.workspaces || [])
      .map((w) => `<option value="${escapeHtml(w)}"></option>`)
      .join('');
  } catch (_) {}
}

async function refreshSessionList() {
  try {
    let data = null;
    if (isTauriRuntime()) {
      data = await tauriInvoke('list_sessions');
    } else {
      const res = await fetch('/api/sessions');
      if (!res.ok) return;
      data = await res.json();
    }
    if (!data) return;
    const sessions = data.sessions || [];
    knownSessions = sessions;

    for (const s of sessions) {
      if (sessionStates.has(s.id)) {
        const local = sessionStates.get(s.id);
        local.title = s.title || local.title;
        if (s.workspace && !local.workspace) {
          local.workspace = s.workspace;
        }
        // If server reports running and we aren't attached to its stream yet, sync metadata
        if (s.isRunning && !activeStreamAttachments.has(s.id)) {
          local.isRunning = true;
          local.turnId = s.turnId || local.turnId;
          local.statusState = s.state || 'running';
          local.statusMessage = s.statusMessage || 'Running...';
          local.progressLabel = s.progressLabel || s.statusMessage || 'Running...';
          local.hasPendingQuestion = Boolean(s.hasPendingQuestion);
        } else if (!s.isRunning && local.isRunning && !activeStreamAttachments.has(s.id)) {
          local.isRunning = false;
          local.statusState = 'idle';
          local.statusMessage = `Idle · Session ${s.id.slice(0, 8)}`;
          local.progressLabel = '';
          local.hasPendingQuestion = false;
        }
      } else if (s.isRunning) {
        getOrCreateSessionState(s.id, {
          sessionId: s.id,
          turnId: s.turnId || null,
          title: s.title,
          workspace: s.workspace || '',
          stepCount: s.stepCount || 0,
          isRunning: true,
          statusState: s.state || 'running',
          statusMessage: s.statusMessage || 'Running...',
          progressLabel: s.progressLabel || s.statusMessage || 'Running...',
          hasPendingQuestion: Boolean(s.hasPendingQuestion)
        });
      }
    }

    renderSidebar();
  } catch (_) {}
}

/**
 * Process a single SSE event frame for a target session state.
 */
async function handleSessionSseEvent(stateRef, event, data) {
  let state = stateRef.current;

  if (event === 'session' && data.sessionId) {
    state = migrateSessionKey(state.key, data.sessionId);
    stateRef.current = state;
    state.isRunning = true;
    state.statusState = 'running';
    state.statusMessage = `Session ${data.sessionId.slice(0, 8)} active · Running...`;
    state.progressLabel = state.progressLabel || 'Generating...';
    await refreshSessionList();
  } else if (event === 'status') {
    state.isRunning = data.state !== 'idle';
    state.statusState = data.state || 'running';
    state.statusMessage = data.message || state.statusMessage;
    state.progressLabel = data.progressLabel || data.message || state.progressLabel;
    state.hasPendingQuestion =
      data.state === 'waiting_for_question' || Boolean(data.hasPendingQuestion);
  } else if (event === 'transcript') {
    if (data.sessionId && state.key !== data.sessionId) {
      state = migrateSessionKey(state.key, data.sessionId);
      stateRef.current = state;
    }
    state.items = data.items || [];
    state.stepCount = data.stepCount || state.items.length;
    if (data.progressLabel) {
      state.progressLabel = data.progressLabel;
    }
    const firstUser = state.items.find((i) => i.role === 'user');
    if (firstUser && (!state.title || state.title === 'New Session')) {
      state.title = firstUser.content.slice(0, 60);
    }
  } else if (event === 'ask_question') {
    state.hasPendingQuestion = true;
    state.statusState = 'waiting_for_question';
    state.statusMessage = 'Waiting for your answer in AskQuestion card...';
    state.progressLabel = `? Waiting for answer: ${data.summary || 'AskQuestion'}`;
  } else if (event === 'ask_question_submitted') {
    state.hasPendingQuestion = false;
    state.statusState = 'running';
    state.statusMessage = 'Answer submitted · Resuming execution...';
    state.progressLabel = 'Answer submitted...';
  } else if (event === 'permission_prompt') {
    const existingIdx = state.permissions.findIndex((p) => p.id === data.id);
    if (existingIdx >= 0) {
      state.permissions[existingIdx] = data;
    } else {
      state.permissions.push(data);
    }
    state.statusMessage = 'Permission prompt detected in TUI · Simulating Enter...';
    state.progressLabel = '↵ Auto-approving permission...';
  } else if (event === 'enter_simulated') {
    const existingIdx = state.permissions.findIndex((p) => p.id === data.id);
    if (existingIdx >= 0) {
      state.permissions[existingIdx] = data;
    } else {
      state.permissions.push(data);
    }
    state.statusMessage = 'Simulated Enter (\\r) sent · Resuming execution...';
    state.progressLabel = 'Resuming execution...';
  } else if (event === 'exit') {
    if (data.sessionId && state.key !== data.sessionId) {
      state = migrateSessionKey(state.key, data.sessionId);
      stateRef.current = state;
    }
    if (Array.isArray(data.items) && data.items.length > 0) {
      state.items = data.items;
    }
    if (Array.isArray(data.permissions)) {
      state.permissions = data.permissions;
    }
    state.isRunning = false;
    state.hasPendingQuestion = false;
    state.statusState = 'idle';
    state.progressLabel = '';
    state.statusMessage = `Idle · Session ${
      state.sessionId ? state.sessionId.slice(0, 8) : ''
    } (exit=${data.exitCode})`;
    await refreshSessionList();
  } else if (event === 'error') {
    state.isRunning = false;
    state.statusState = 'error';
    state.statusMessage = `Error: ${data.error || 'Unknown error'}`;
    state.progressLabel = state.statusMessage;
  }

  renderSidebar();
  if (activeViewKey === state.key) {
    syncComposerAndStatusBar();
    renderStream();
    scrollToBottom();
  }
}

async function consumeSseResponse(response, stateRef, attachmentKey) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const frames = buffer.split('\n\n');
      buffer = frames.pop();

      for (const frame of frames) {
        const lines = frame.split('\n');
        const evtLine = lines.find((l) => l.startsWith('event: '));
        const dataLine = lines.find((l) => l.startsWith('data: '));
        if (!evtLine || !dataLine) continue;

        const event = evtLine.slice(7).trim();
        const data = JSON.parse(dataLine.slice(6));
        await handleSessionSseEvent(stateRef, event, data);
      }
    }
  } finally {
    if (attachmentKey) {
      activeStreamAttachments.delete(attachmentKey);
    }
  }
}

async function attachToRunningSessionStream(sessionId) {
  if (!sessionId || activeStreamAttachments.has(sessionId)) return;
  activeStreamAttachments.add(sessionId);

  const state = getOrCreateSessionState(sessionId);
  const stateRef = { current: state };

  try {
    if (isTauriRuntime()) {
      tauriTurnRefs.set(sessionId, stateRef);
      const res = await tauriInvoke('attach_session_stream', { sessionId });
      if (!res || !res.attached) {
        activeStreamAttachments.delete(sessionId);
        tauriTurnRefs.delete(sessionId);
      } else if (res.turnId) {
        tauriTurnRefs.set(res.turnId, stateRef);
      }
      return;
    }

    const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/stream`);
    if (!response.ok) {
      activeStreamAttachments.delete(sessionId);
      return;
    }
    await consumeSseResponse(response, stateRef, sessionId);
  } catch (_) {
    activeStreamAttachments.delete(sessionId);
    tauriTurnRefs.delete(sessionId);
  }
}

async function selectSessionFromSidebar(sessionKey) {
  // Save current composer draft before switching
  const currentState = getActiveState();
  currentState.draftPrompt = promptInput.value;

  if (!sessionKey || sessionKey === NEW_SESSION_KEY) {
    await loadSession(null);
    return;
  }

  await loadSession(sessionKey);
}

async function loadSession(sessionKey, options = {}) {
  const { updateUrl = true } = options;

  // Save draft on previous view
  if (sessionStates.has(activeViewKey)) {
    sessionStates.get(activeViewKey).draftPrompt = promptInput.value;
  }

  if (!sessionKey || sessionKey === NEW_SESSION_KEY) {
    activeViewKey = NEW_SESSION_KEY;
    const newState = getOrCreateSessionState(NEW_SESSION_KEY, {
      sessionError: null,
      statusState: 'idle',
      statusMessage: 'New Session · Ready'
    });
    promptInput.value = newState.draftPrompt || '';
    if (updateUrl) {
      syncSessionUrlParam(null);
    }
    syncComposerAndStatusBar();
    renderSidebar();
    renderStream();
    promptInput.focus();
    return;
  }

  // If switching to an in-flight provisional turn (`turn-...`) that hasn't resolved a UUID yet
  if (sessionKey.startsWith('turn-') && sessionStates.has(sessionKey)) {
    activeViewKey = sessionKey;
    const turnState = sessionStates.get(sessionKey);
    promptInput.value = turnState.draftPrompt || '';
    if (turnState.workspace) {
      cwdInput.value = turnState.workspace;
    }
    if (updateUrl) {
      syncSessionUrlParam(null);
    }
    syncComposerAndStatusBar();
    renderSidebar();
    renderStream();
    scrollToBottom();
    return;
  }

  activeViewKey = sessionKey;
  const state = getOrCreateSessionState(sessionKey);
  promptInput.value = state.draftPrompt || '';

  // If this session is already actively streaming in this browser tab, render immediately from memory!
  if (state.isRunning && activeStreamAttachments.has(sessionKey)) {
    if (state.workspace) {
      cwdInput.value = state.workspace;
    }
    if (updateUrl) {
      syncSessionUrlParam(sessionKey);
    }
    syncComposerAndStatusBar();
    renderSidebar();
    renderStream();
    scrollToBottom();
    return;
  }

  state.sessionError = null;
  if (!state.isRunning) {
    state.statusMessage = `Loading session ${sessionKey.slice(0, 8)}...`;
  }
  syncComposerAndStatusBar();
  renderSidebar();

  try {
    let data = {};
    let isNotFound = false;

    if (isTauriRuntime()) {
      data = (await tauriInvoke('get_session', { sessionId: sessionKey })) || {};
      isNotFound = Boolean(data.error) || (!data.transcriptPath && !data.isRunning);
    } else {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionKey)}`);
      data = await res.json().catch(() => ({}));
      isNotFound = !res.ok || Boolean(data.error) || (!data.transcriptPath && !data.isRunning);
    }

    if (isNotFound) {
      state.items = [];
      state.permissions = [];
      state.isRunning = false;
      state.statusState = 'error';
      state.statusMessage = `Error: Session "${sessionKey}" not found`;
      state.sessionError = {
        sessionId: sessionKey,
        message: data.error || `Session "${sessionKey}" not found`
      };
      if (updateUrl) {
        syncSessionUrlParam(sessionKey);
      }
      syncComposerAndStatusBar();
      renderSidebar();
      renderStream();
      return;
    }

    state.sessionId = sessionKey;
    state.items = data.items || state.items || [];
    state.permissions = data.permissions || state.permissions || [];
    state.stepCount = (data.rawSteps && data.rawSteps.length) || state.items.length;
    state.isRunning = Boolean(data.isRunning);
    state.turnId = data.turnId || state.turnId;
    state.hasPendingQuestion = Boolean(data.hasPendingQuestion);
    state.progressLabel = data.progressLabel || '';
    state.statusState = data.isRunning
      ? data.hasPendingQuestion
        ? 'waiting_for_question'
        : 'running'
      : 'idle';
    state.statusMessage = data.isRunning
      ? data.statusMessage || `Session ${sessionKey.slice(0, 8)} running...`
      : `Session ${sessionKey.slice(0, 8)} loaded`;

    const matchedSession = knownSessions.find((s) => s.id === sessionKey);
    const resolvedWorkspace =
      data.workspace || (matchedSession && matchedSession.workspace) || state.workspace;
    if (resolvedWorkspace) {
      state.workspace = resolvedWorkspace;
      cwdInput.value = resolvedWorkspace;
    }

    if (matchedSession && matchedSession.title) {
      state.title = matchedSession.title;
    } else {
      const firstUser = state.items.find((i) => i.role === 'user');
      if (firstUser) {
        state.title = firstUser.content.slice(0, 60);
      }
    }

    if (updateUrl) {
      syncSessionUrlParam(sessionKey);
    }

    syncComposerAndStatusBar();
    renderSidebar();
    renderStream();
    scrollToBottom();

    // If session is running on the server, attach live SSE / Tauri event stream
    if (state.isRunning) {
      attachToRunningSessionStream(sessionKey);
    }
  } catch (err) {
    state.items = [];
    state.permissions = [];
    state.isRunning = false;
    state.statusState = 'error';
    state.statusMessage = `Error: ${err.message || String(err)}`;
    state.sessionError = {
      sessionId: sessionKey,
      message: (err && err.message) || String(err) || `Failed to load session "${sessionKey}"`
    };
    syncComposerAndStatusBar();
    renderSidebar();
    renderStream();
  }
}

async function sendChat() {
  const prompt = promptInput.value.trim();
  const currentState = getActiveState();
  if (!prompt || currentState.isRunning) return;

  const cwd = cwdInput.value.trim() || defaultWorkspace;
  promptInput.value = '';
  currentState.draftPrompt = '';

  let targetState = currentState;
  let targetSessionId = currentState.sessionId || null;
  let clientTurnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  // If starting from the unbound "+ New Session" view, promote to a dedicated provisional turn state
  // so clicking "+ New Session" again creates a clean second session while this one runs in the background!
  if (activeViewKey === NEW_SESSION_KEY) {
    targetState = createSessionState(clientTurnId, {
      sessionId: null,
      turnId: clientTurnId,
      title: prompt.slice(0, 60),
      workspace: cwd,
      createdLocally: true,
      items: []
    });
    sessionStates.set(clientTurnId, targetState);
    // Reset the '__new__' draft state so it stays clean for the next "+ New Session" click
    sessionStates.set(NEW_SESSION_KEY, createSessionState(NEW_SESSION_KEY));
    activeViewKey = clientTurnId;
  }

  targetState.sessionError = null;
  targetState.isRunning = true;
  targetState.updatedAt = new Date().toISOString();
  targetState.turnId = clientTurnId;
  targetState.workspace = cwd;
  targetState.statusState = 'running';
  targetState.statusMessage = targetSessionId
    ? 'Resuming session in PTY...'
    : 'Spawning new AGY PTY session...';
  targetState.progressLabel = targetState.statusMessage;

  targetState.items.push({
    id: `optimistic-${Date.now()}`,
    role: 'user',
    content: prompt
  });

  syncComposerAndStatusBar();
  renderSidebar();
  renderStream();
  scrollToBottom();

  const stateRef = { current: targetState };
  const attachmentKey = targetSessionId || clientTurnId;
  activeStreamAttachments.add(attachmentKey);

  try {
    if (isTauriRuntime()) {
      tauriTurnRefs.set(clientTurnId, stateRef);
      if (targetSessionId) {
        tauriTurnRefs.set(targetSessionId, stateRef);
      }

      const result = await tauriInvoke('start_chat_turn', {
        prompt,
        sessionId: targetSessionId,
        clientTurnId,
        cwd
      });

      if (result && stateRef.current.isRunning) {
        await handleSessionSseEvent(stateRef, 'exit', result);
      }
      return;
    }

    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        sessionId: targetSessionId,
        clientTurnId,
        cwd
      })
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      throw new Error(errData.error || `Request failed with status ${response.status}`);
    }

    await consumeSseResponse(response, stateRef, attachmentKey);
  } catch (err) {
    const st = stateRef.current;
    st.isRunning = false;
    st.statusState = 'error';
    st.statusMessage = `Error: ${(err && err.message) || String(err)}`;
    st.progressLabel = st.statusMessage;
  } finally {
    const st = stateRef.current;
    st.isRunning = false;
    activeStreamAttachments.delete(attachmentKey);
    tauriTurnRefs.delete(clientTurnId);
    if (st.sessionId) {
      activeStreamAttachments.delete(st.sessionId);
      tauriTurnRefs.delete(st.sessionId);
    }
    renderSidebar();
    if (activeViewKey === st.key) {
      syncComposerAndStatusBar();
      renderStream();
      promptInput.focus();
    }
  }
}

sidebarToggleBtn.addEventListener('click', () => {
  sidebarEl.classList.toggle('collapsed');
});

newSessionBtn.addEventListener('click', () => {
  selectSessionFromSidebar(NEW_SESSION_KEY);
});

sendBtn.addEventListener('click', sendChat);

promptInput.addEventListener('input', () => {
  const state = getActiveState();
  state.draftPrompt = promptInput.value;
});

promptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChat();
  }
});

window.addEventListener('popstate', () => {
  const urlSessionId = getSessionParamFromUrl();
  const targetKey = urlSessionId || NEW_SESSION_KEY;
  if (targetKey !== activeViewKey) {
    loadSession(urlSessionId, { updateUrl: false });
  }
});

// Background poll to keep sidebar progress & externally started sessions up to date
setInterval(() => {
  refreshSessionList();
}, 2500);

(async () => {
  await setupTauriEventListener();
  const initialSessionId = getSessionParamFromUrl();
  if (initialSessionId) {
    activeViewKey = initialSessionId;
    renderSidebar();
  }
  await loadWorkspaces();
  await refreshSessionList();
  if (initialSessionId) {
    await loadSession(initialSessionId, { updateUrl: false });
  } else {
    renderSidebar();
    renderStream();
    syncComposerAndStatusBar();
  }
})();
