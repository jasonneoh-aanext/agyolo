const express = require('express');
const pty = require('node-pty');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseTranscriptLines } = require('./lib/turnState');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const AGY_BIN = process.env.AGY_BIN || path.join(os.homedir(), '.local/bin/agy');
const GCP_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'next-gemini-ent-prd';
const AGY_CLI_DIR = path.join(os.homedir(), '.gemini/antigravity-cli');
const SECONDARY_AGY_DIR = path.join(os.homedir(), '.gemini/antigravity');
const BRAIN_DIR = path.join(AGY_CLI_DIR, 'brain');
const SECONDARY_BRAIN_DIR = path.join(SECONDARY_AGY_DIR, 'brain');
const BRAIN_DIRS = [BRAIN_DIR, SECONDARY_BRAIN_DIR];
const SUMMARIES_DB = path.join(AGY_CLI_DIR, 'conversation_summaries.db');

// Keep in-memory history of permission prompts captured per session during server lifetime
const sessionPermissions = new Map();

// Active live PTY turns keyed by sessionId and by turnId for concurrent multi-session execution
const activeTurns = new Map();
const activeTurnsByTurnId = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `node-pty` v1.1.0 ships `prebuilds/<platform>-<arch>/spawn-helper` with 0644 (-rw-r--r--)
 * permissions in its npm tarball, which causes `pty.spawn()` to throw `Error: posix_spawnp failed.`.
 * Ensure the helper binary is executable before spawning any PTY process.
 */
function ensureNodePtySpawnHelperExecutable() {
  try {
    const ptyPkgDir = path.dirname(require.resolve('node-pty/package.json'));
    const candidates = [
      path.join(ptyPkgDir, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
      path.join(ptyPkgDir, 'build', 'Release', 'spawn-helper'),
      path.join(ptyPkgDir, 'build', 'Debug', 'spawn-helper')
    ];
    for (const helperPath of candidates) {
      if (fs.existsSync(helperPath)) {
        const mode = fs.statSync(helperPath).mode;
        if ((mode & 0o111) === 0) {
          fs.chmodSync(helperPath, mode | 0o755);
        }
      }
    }
  } catch (_) {}
}

ensureNodePtySpawnHelperExecutable();

/**
 * Strip ANSI escape sequences from raw PTY output.
 */
function stripAnsi(str) {
  return str
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '');
}

/**
 * Reply to BubbleTea / termenv terminal capability queries sent by `agy` on startup.
 */
function handleTerminalQueries(ptyProcess, rawData) {
  if (rawData.includes('\x1b[6n')) {
    ptyProcess.write('\x1b[1;1R');
  }
  if (rawData.includes('\x1b]11;?')) {
    ptyProcess.write('\x1b]11;rgb:0000/0000/0000\x07');
  }
  if (rawData.includes('\x1b]10;?')) {
    ptyProcess.write('\x1b]10;rgb:ffff/ffff/ffff\x07');
  }
  if (rawData.includes('\x1b[c') || rawData.includes('\x1b[>c') || rawData.includes('\x1b[>q')) {
    ptyProcess.write('\x1b[?1;2c');
  }
}

/**
 * Detect and parse an active `agy` BubbleTea permission prompt from the rolling TUI buffer.
 * Explicitly ignores `ask_question` TUI screens (`Write-in...`, `esc Skip`, `Question X/Y:`).
 */
function detectPermissionPrompt(rollingClean) {
  if (
    /Write-in\.\.\./i.test(rollingClean) ||
    /esc\s+Skip/i.test(rollingClean) ||
    /Question\s+\d+\/\d+:/i.test(rollingClean)
  ) {
    return { matched: false };
  }

  const hasMenuOption1 = />\s*1\.\s*Yes\b/i.test(rollingClean);
  const hasAlwaysAllowOption = /Yes,\s*and always allow/i.test(rollingClean);
  const hasTrustFolderOption = /Yes,\s*I trust this folder/i.test(rollingClean);
  const hasNavigateHint =
    /↑\/↓\s*Navigate/i.test(rollingClean) && /\b1\.\s*Yes\b/i.test(rollingClean);

  if (!hasMenuOption1 && !hasAlwaysAllowOption && !hasTrustFolderOption && !hasNavigateHint) {
    return { matched: false };
  }

  const cleanLines = rollingClean
    .split(/\r?\n/)
    .map((l) => l.replace(/─+/g, '───').trim())
    .filter((l) => l && !l.startsWith('esc to cancel'));

  const snippet = cleanLines.slice(-12).join('\n');

  let title = 'Permission Request';
  let target = '';
  let reason = '';
  let question = '';
  const options = [];

  for (const line of cleanLines.slice(-14)) {
    if (/^(File access|Terminal command|Run command|Tool permission|Workspace trust)/i.test(line)) {
      title = line;
    } else if (/^(Read|Write|Edit|Execute|Command|Path):/i.test(line)) {
      target = line;
    } else if (/^Reason:/i.test(line)) {
      reason = line;
    } else if (line.endsWith('?')) {
      question = line;
    } else if (/^>?\s*[123]\.\s+/.test(line)) {
      options.push(line.replace(/^>\s*/, ''));
    }
  }

  return {
    matched: true,
    title,
    target,
    reason,
    question: question || 'Allow this operation to proceed?',
    options: options.length
      ? options
      : ['1. Yes, allow access', '2. Yes, and always allow', '3. No, deny access'],
    snippet
  };
}

/**
 * Translate Web UI `ask_question` answers into BubbleTea TUI keystrokes on `ptyProcess`.
 */
async function sendAskQuestionKeystrokes(ptyProcess, questions, submission) {
  const qList = Array.isArray(questions) && questions.length > 0 ? questions : [{}];

  if (submission.action === 'skip') {
    for (let qIdx = 0; qIdx < qList.length; qIdx++) {
      ptyProcess.write('\x1b');
      if (qIdx < qList.length - 1) {
        await sleep(200);
      }
    }
    return;
  }

  const answers = Array.isArray(submission.answers) ? submission.answers : [];

  for (let qIdx = 0; qIdx < qList.length; qIdx++) {
    const q = qList[qIdx] || {};
    const options = Array.isArray(q.options) ? q.options : [];
    const N = options.length;
    const ans = answers[qIdx] || {};
    const writeIn = typeof ans.writeIn === 'string' ? ans.writeIn.trim() : '';
    const selected = Array.isArray(ans.selectedIndices)
      ? ans.selectedIndices.map((n) => Number(n)).filter((n) => !Number.isNaN(n))
      : [];

    if (!q.is_multi_select) {
      // Single-select mode: cursor starts at index 0 (`1. <opt0>`), `Write-in...` is at index N
      if (writeIn) {
        if (N > 0) {
          ptyProcess.write('\x1b[B'.repeat(N));
          await sleep(80);
        }
        ptyProcess.write('\r');
        await sleep(220);
        ptyProcess.write(writeIn + '\r');
      } else {
        const choiceIdx = selected.length > 0 ? Math.max(0, Math.min(N - 1, selected[0])) : 0;
        if (choiceIdx > 0) {
          ptyProcess.write('\x1b[B'.repeat(choiceIdx));
          await sleep(80);
        }
        ptyProcess.write('\r');
      }
    } else {
      // Multi-select mode: cursor starts at index 0 (`1. [ ] <opt0>`), `Write-in...` is at index N
      // Space (' ') toggles checkbox, Enter ('\r') submits all.
      const maxOptionToVisit = writeIn
        ? N
        : selected.length > 0
          ? Math.min(N - 1, Math.max(...selected))
          : 0;

      for (let i = 0; i < N; i++) {
        if (selected.includes(i)) {
          ptyProcess.write(' ');
          await sleep(70);
        }
        if (i < maxOptionToVisit) {
          ptyProcess.write('\x1b[B');
          await sleep(70);
        }
      }

      if (writeIn) {
        ptyProcess.write('\r');
        await sleep(220);
        ptyProcess.write(writeIn + '\r');
      } else {
        ptyProcess.write('\r');
      }
    }

    if (qIdx < qList.length - 1) {
      await sleep(260);
    }
  }
}

/**
 * Locate the transcript file for a given conversation UUID across primary and secondary brain dirs.
 */
function getTranscriptPath(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return null;
  for (const brainDir of BRAIN_DIRS) {
    const logsDir = path.join(brainDir, sessionId, '.system_generated', 'logs');
    const fullPath = path.join(logsDir, 'transcript_full.jsonl');
    const compactPath = path.join(logsDir, 'transcript.jsonl');
    if (fs.existsSync(fullPath)) return fullPath;
    if (fs.existsSync(compactPath)) return compactPath;
  }
  return null;
}

/**
 * Build runtime progress metadata for a session if an active turn is currently running.
 */
function getLiveSessionMeta(sessionId) {
  const controller = sessionId
    ? activeTurns.get(sessionId) || activeTurnsByTurnId.get(sessionId)
    : null;
  if (!controller) {
    return {
      isRunning: false,
      turnId: null,
      state: 'idle',
      message: 'Idle',
      statusMessage: 'Idle',
      progressLabel: '',
      hasPendingQuestion: false,
      pendingBackgroundCount: 0
    };
  }
  return controller.getSnapshotMeta();
}

/**
 * Read a full conversation from `~/.gemini/antigravity-cli/brain/<sessionId>`.
 */
function readConversation(sessionId) {
  const transcriptPath = getTranscriptPath(sessionId);
  const liveMeta = getLiveSessionMeta(sessionId);
  if (!transcriptPath) {
    const controller = sessionId
      ? activeTurns.get(sessionId) || activeTurnsByTurnId.get(sessionId)
      : null;
    return {
      sessionId,
      rawSteps: [],
      items: controller ? controller.items : [],
      permissions: sessionPermissions.get(sessionId) || (controller ? controller.permissions : []),
      ...liveMeta
    };
  }

  let content = '';
  try {
    content = fs.readFileSync(transcriptPath, 'utf8');
  } catch (err) {
    return {
      sessionId,
      transcriptPath,
      rawSteps: [],
      items: [],
      permissions: sessionPermissions.get(sessionId) || [],
      error: `Failed to read transcript for session "${sessionId}": ${err.message}`,
      ...liveMeta
    };
  }

  const lines = content.split(/\r?\n/).filter(Boolean);
  const { rawSteps, items, turnState, workspaceCwd } = parseTranscriptLines(lines, {
    brainDirs: BRAIN_DIRS
  });

  // If no live turn is running for this session, normalize any interrupted 'running' tool calls
  if (!liveMeta.isRunning) {
    for (const item of items) {
      if (item.role === 'tool_call' && item.status === 'running') {
        item.status = 'done';
      }
    }
  }

  return {
    sessionId,
    transcriptPath,
    workspace: workspaceCwd || '',
    rawSteps,
    items,
    turnState,
    permissions: sessionPermissions.get(sessionId) || [],
    ...liveMeta
  };
}

/**
 * List sessions from `conversation_summaries.db` (via node:sqlite if available)
 * combined with a fast directory scan of primary/secondary brain dirs and active turns.
 */
function listSessions() {
  const sessionsMap = new Map();

  if (fs.existsSync(SUMMARIES_DB)) {
    try {
      const sqlite = require('node:sqlite');
      const db = new sqlite.DatabaseSync(SUMMARIES_DB, { open: true, readOnly: true });
      const rows = db
        .prepare(
          `SELECT conversation_id, title, preview, step_count, created_time, last_modified_time, workspace_uris, nesting_depth
           FROM conversation_summaries
           WHERE nesting_depth = 0
           ORDER BY last_modified_time DESC
           LIMIT 50`
        )
        .all();
      db.close();

      for (const r of rows) {
        let workspaces = [];
        try {
          workspaces = JSON.parse(r.workspace_uris || '[]').map((u) =>
            u.replace(/^file:\/\//, '')
          );
        } catch (_) {}
        sessionsMap.set(r.conversation_id, {
          id: r.conversation_id,
          title: r.title || r.preview || r.conversation_id.slice(0, 8),
          preview: r.preview || '',
          stepCount: r.step_count || 0,
          updatedAt: r.last_modified_time || r.created_time || '',
          workspace: workspaces[0] || ''
        });
      }
    } catch (_) {}
  }

  for (const brainDir of BRAIN_DIRS) {
    if (!fs.existsSync(brainDir)) continue;
    try {
      const entries = fs.readdirSync(brainDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const id = entry.name;
        const tPath = getTranscriptPath(id);
        if (!tPath) continue;

        const stat = fs.statSync(tPath);
        const content = fs.readFileSync(tPath, 'utf8');
        const lines = content.split(/\r?\n/).filter(Boolean);
        const { items, workspaceCwd } = parseTranscriptLines(lines, { brainDirs: BRAIN_DIRS });
        const firstUser = items.find((i) => i.role === 'user');
        const existing = sessionsMap.get(id);

        sessionsMap.set(id, {
          id,
          title:
            (existing && existing.title) ||
            (firstUser ? firstUser.content.slice(0, 60) : `Session ${id.slice(0, 8)}`),
          preview: (existing && existing.preview) || (firstUser ? firstUser.content : ''),
          stepCount: lines.length,
          updatedAt: stat.mtime.toISOString(),
          workspace: (existing && existing.workspace) || workspaceCwd || ''
        });
      }
    } catch (_) {}
  }

  // Merge in-flight active turns (including brand-new turns that haven't flushed a transcript yet)
  for (const controller of activeTurnsByTurnId.values()) {
    const sid = controller.sessionId || controller.turnId;
    if (!sid) continue;
    const existing = sessionsMap.get(sid);
    const meta = controller.getSnapshotMeta();
    sessionsMap.set(sid, {
      id: sid,
      title:
        (existing && existing.title) ||
        (controller.initialPrompt ? controller.initialPrompt.slice(0, 60) : `Session ${sid.slice(0, 8)}`),
      preview: (existing && existing.preview) || controller.initialPrompt || '',
      stepCount: Math.max((existing && existing.stepCount) || 0, controller.stepCount || 0),
      updatedAt: controller.updatedAt || (existing && existing.updatedAt) || new Date().toISOString(),
      workspace: (existing && existing.workspace) || controller.cwd || '',
      ...meta
    });
  }

  // Enrich all sessions with live status metadata
  const result = Array.from(sessionsMap.values()).map((s) => {
    const live = getLiveSessionMeta(s.id);
    return {
      ...s,
      ...live
    };
  });

  // Sort active running sessions or most recently updated sessions first
  return result.sort((a, b) => {
    if (a.isRunning !== b.isRunning) {
      return a.isRunning ? -1 : 1;
    }
    return (b.updatedAt || '').localeCompare(a.updatedAt || '');
  });
}

/**
 * Run a single interactive turn in `agy` via node-pty (Control Plane)
 * while tailing `transcript_full.jsonl` (Data Plane).
 * Safe for concurrent execution across multiple sessions.
 */
function runAgyTurn({
  prompt,
  conversationId,
  clientTurnId = null,
  cwd = __dirname,
  approvalInput = '\r',
  timeoutMs = 300000,
  onEvent = () => {}
}) {
  return new Promise((resolve) => {
    const turnId =
      clientTurnId || `turn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const validCwd = fs.existsSync(cwd) ? cwd : __dirname;
    const tmpLogFile = path.join(
      os.tmpdir(),
      `agy-poc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.log`
    );

    let baselineStepCount = 0;
    if (conversationId) {
      const existingPath = getTranscriptPath(conversationId);
      if (existingPath) {
        try {
          const lines = fs
            .readFileSync(existingPath, 'utf8')
            .split(/\r?\n/)
            .filter(Boolean);
          baselineStepCount = lines.length;
        } catch (_) {}
      }
    }

    const args = ['--dangerously-skip-permissions'];
    if (conversationId) {
      args.push(`--conversation=${conversationId}`);
    }
    args.push('--log-file', tmpLogFile, '--prompt-interactive', prompt);

    ensureNodePtySpawnHelperExecutable();
    if (path.isAbsolute(AGY_BIN) && !fs.existsSync(AGY_BIN)) {
      throw new Error(
        `AGY binary not found at ${AGY_BIN}. Set AGY_BIN env var to the path of your agy binary.`
      );
    }

    let activeSessionId = conversationId || null;
    let rollingClean = '';
    let hasStartedGenerating = false;
    let isExiting = false;
    let pendingEnterTimer = null;
    let lastApproveTimestamp = 0;
    let lastEmittedLineCount = baselineStepCount;
    let transcriptFinalResponseDone = false;
    let pendingAskQuestion = null;
    let latestRawSteps = [];
    let latestItems = [];
    let latestTurnState = {
      hasUnpairedToolCalls: false,
      hasPendingBackgroundWork: false,
      pendingBackgroundCount: 0,
      pendingBackgroundSummary: null,
      isLatestStepFinalPlannerResponse: false,
      isTurnComplete: false,
      latestActivityLabel: ''
    };
    let currentState = 'spawning';
    let currentStatusMessage = activeSessionId
      ? 'Resuming session in PTY...'
      : 'Spawning new AGY PTY session...';
    let updatedAt = new Date().toISOString();

    const autoApprovals = [];
    const turnPermissions = [];
    const boundToolItemIds = new Set();
    const subscribers = new Set([onEvent]);

    function emitTurnEvent(event, payload) {
      updatedAt = new Date().toISOString();
      const enrichedPayload = {
        ...payload,
        turnId,
        sessionId: payload.sessionId || activeSessionId || null
      };
      for (const sub of subscribers) {
        try {
          sub(event, enrichedPayload);
        } catch (_) {}
      }
    }

    function setTurnStatus(state, message) {
      currentState = state;
      currentStatusMessage = message;
      emitTurnEvent('status', {
        state,
        message,
        progressLabel: getProgressLabel()
      });
    }

    function getProgressLabel() {
      if (pendingAskQuestion) {
        return `? Waiting for answer: ${pendingAskQuestion.summary || 'AskQuestion'}`;
      }
      const hasPendingPerm = turnPermissions.some((p) => p.status !== 'approved');
      if (hasPendingPerm) {
        return '↵ Auto-approving permission...';
      }
      if (latestTurnState.pendingBackgroundSummary) {
        return latestTurnState.pendingBackgroundSummary;
      }
      if (latestTurnState.latestActivityLabel) {
        return latestTurnState.latestActivityLabel;
      }
      return currentStatusMessage;
    }

    const turnController = {
      turnId,
      initialPrompt: prompt,
      cwd: validCwd,
      get sessionId() {
        return activeSessionId;
      },
      get updatedAt() {
        return updatedAt;
      },
      get stepCount() {
        return latestRawSteps.length;
      },
      get items() {
        return latestItems;
      },
      get permissions() {
        return turnPermissions;
      },
      get pendingAskQuestion() {
        return pendingAskQuestion;
      },
      subscribe(fn) {
        subscribers.add(fn);
        return () => subscribers.delete(fn);
      },
      getSnapshotMeta() {
        return {
          isRunning: !isExiting,
          turnId,
          state: currentState,
          message: currentStatusMessage,
          statusMessage: currentStatusMessage,
          progressLabel: getProgressLabel(),
          hasPendingQuestion: Boolean(pendingAskQuestion),
          pendingBackgroundCount: latestTurnState.pendingBackgroundCount || 0
        };
      },
      async submitAskQuestion(submission) {
        if (!pendingAskQuestion) {
          throw new Error('No pending ask_question in active PTY turn');
        }
        const currentQ = pendingAskQuestion;
        pendingAskQuestion = null;
        rollingClean = '';
        setTurnStatus('answering_question', 'Submitting answer to AGY TUI...');
        await sendAskQuestionKeystrokes(ptyProcess, currentQ.questions, submission);
        emitTurnEvent('ask_question_submitted', {
          stepIndex: currentQ.stepIndex,
          submission
        });
      }
    };

    emitTurnEvent('spawn', {
      command: AGY_BIN,
      args,
      cwd: validCwd,
      env: { GOOGLE_CLOUD_PROJECT: GCP_PROJECT }
    });

    const ptyProcess = pty.spawn(AGY_BIN, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: validCwd,
      env: {
        ...process.env,
        GOOGLE_CLOUD_PROJECT: GCP_PROJECT,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor'
      }
    });

    activeTurnsByTurnId.set(turnId, turnController);
    if (activeSessionId) {
      activeTurns.set(activeSessionId, turnController);
    }

    function attachTurnPermissionsToSession(sessionId) {
      if (!sessionId) return;
      const list = sessionPermissions.get(sessionId) || [];
      for (const perm of turnPermissions) {
        perm.sessionId = sessionId;
        if (!list.some((existing) => existing.id === perm.id)) {
          list.push(perm);
        }
      }
      sessionPermissions.set(sessionId, list);
    }

    function resolveSessionIdFromLog() {
      if (!activeSessionId && fs.existsSync(tmpLogFile)) {
        try {
          const logContent = fs.readFileSync(tmpLogFile, 'utf8');
          const match =
            logContent.match(/Created conversation ([0-9a-f-]{36})/i) ||
            logContent.match(/Streaming conversation ([0-9a-f-]{36})/i);
          if (match && match[1]) {
            activeSessionId = match[1];
            activeTurns.set(activeSessionId, turnController);
            attachTurnPermissionsToSession(activeSessionId);
            emitTurnEvent('session', { sessionId: activeSessionId, source: 'log-file' });
          }
        } catch (_) {}
      }
    }

    function findMatchingToolItem(items, check, minStepIndex = baselineStepCount) {
      const effectiveMinStep = Math.max(baselineStepCount, minStepIndex ?? baselineStepCount);
      const turnTools = (items || []).filter(
        (item) => item.role === 'tool_call' && item.stepIndex >= effectiveMinStep
      );
      if (turnTools.length === 0) return null;

      const unbound = turnTools.filter((t) => !boundToolItemIds.has(t.id));
      const pool = unbound.length > 0 ? unbound : turnTools;
      const running = pool.filter((t) => t.status === 'running');
      const candidates = running.length > 0 ? running : pool;

      const targetLower = String(check.target || '').trim().toLowerCase();
      const haystack = `${check.target || ''}\n${check.snippet || ''}`.toLowerCase();
      if (targetLower || haystack.trim()) {
        const byDetail = candidates.find((t) => {
          const detail = String(t.detail || '').trim().toLowerCase();
          const argsStr = JSON.stringify(t.args || {}).toLowerCase();
          if (targetLower && (detail.includes(targetLower) || argsStr.includes(targetLower))) {
            return true;
          }
          return Boolean(detail && haystack.includes(detail));
        });
        if (byDetail) return byDetail;
      }

      const byBypass = candidates.find((t) => t.bypassSandbox);
      if (byBypass) return byBypass;

      return candidates[0] || turnTools[turnTools.length - 1];
    }

    function bindPendingPermissions(items) {
      for (const perm of turnPermissions) {
        if (!perm.afterItemId && !perm.isWorkspaceTrust) {
          const matchedTool = findMatchingToolItem(items, perm, perm.minToolStepIndex);
          if (matchedTool) {
            perm.afterItemId = matchedTool.id;
            perm.afterStepIndex = matchedTool.stepIndex;
            boundToolItemIds.add(matchedTool.id);
            emitTurnEvent(
              perm.status === 'approved' ? 'enter_simulated' : 'permission_prompt',
              perm
            );
          }
        }
      }
    }

    function syncTranscript(force = false) {
      resolveSessionIdFromLog();
      if (!activeSessionId) return;
      const tPath = getTranscriptPath(activeSessionId);
      if (!tPath) return;
      try {
        const content = fs.readFileSync(tPath, 'utf8');
        const lines = content.split(/\r?\n/).filter(Boolean);
        const hasNewLines = lines.length > lastEmittedLineCount;
        if (hasNewLines || force) {
          const { rawSteps, items, turnState } = parseTranscriptLines(lines, {
            baselineStepCount,
            brainDirs: BRAIN_DIRS
          });
          latestRawSteps = rawSteps;
          latestItems = items;
          latestTurnState = turnState;
          bindPendingPermissions(items);

          if (hasNewLines) {
            lastEmittedLineCount = lines.length;
            emitTurnEvent('transcript', {
              sessionId: activeSessionId,
              items,
              stepCount: rawSteps.length,
              turnState,
              progressLabel: getProgressLabel()
            });

            const latestStep = rawSteps[rawSteps.length - 1];

            // Check if latest step is an unanswered ask_question tool call
            const askCall =
              latestStep &&
              latestStep.step_index >= baselineStepCount &&
              latestStep.type === 'PLANNER_RESPONSE' &&
              Array.isArray(latestStep.tool_calls)
                ? latestStep.tool_calls.find((tc) => tc.name === 'ask_question')
                : null;

            if (askCall) {
              let askArgs = askCall.args || {};
              if (typeof askArgs === 'string') {
                try {
                  askArgs = JSON.parse(askArgs);
                } catch (_) {}
              }
              if (!pendingAskQuestion || pendingAskQuestion.stepIndex !== latestStep.step_index) {
                pendingAskQuestion = {
                  sessionId: activeSessionId,
                  stepIndex: latestStep.step_index,
                  questions: Array.isArray(askArgs.questions) ? askArgs.questions : [],
                  summary: askArgs.toolAction || askArgs.toolSummary || 'Question from Antigravity'
                };
                emitTurnEvent('ask_question', pendingAskQuestion);
                setTurnStatus(
                  'waiting_for_question',
                  'Waiting for your answer in AskQuestion...'
                );
              }
            } else if (latestStep && latestStep.type === 'GENERIC') {
              pendingAskQuestion = null;
            }

            // Evaluate turn completion with background task / subagent / timer awareness (gemini-work#49)
            if (turnState.isTurnComplete) {
              transcriptFinalResponseDone = true;
              if (!isExiting && !pendingEnterTimer && !pendingAskQuestion) {
                triggerGracefulExit(
                  'Turn complete (final PLANNER_RESPONSE DONE and no pending background work); exiting PTY via Ctrl+D x2'
                );
              }
            } else {
              transcriptFinalResponseDone = false;
              if (
                turnState.isLatestStepFinalPlannerResponse &&
                turnState.hasPendingBackgroundWork &&
                !pendingAskQuestion
              ) {
                setTurnStatus(
                  'waiting_for_background',
                  turnState.pendingBackgroundSummary || 'Waiting for background tasks to finish...'
                );
              } else if (!pendingAskQuestion && hasStartedGenerating) {
                setTurnStatus(
                  'generating',
                  turnState.latestActivityLabel || 'AGY is thinking & executing...'
                );
              }
            }
          }
        }
      } catch (_) {}
    }

    const pollTimer = setInterval(() => {
      syncTranscript();
    }, 150);

    const safetyTimeout = setTimeout(() => {
      if (!isExiting) {
        isExiting = true;
        setTurnStatus('timeout', 'Turn timeout reached; sending Ctrl+D x2');
        ptyProcess.write('\x04\x04');
        setTimeout(() => {
          try {
            ptyProcess.kill();
          } catch (_) {}
        }, 2000);
      }
    }, timeoutMs);

    function triggerGracefulExit(reason) {
      if (isExiting) return;
      isExiting = true;
      syncTranscript(true);
      setTurnStatus('completing', reason);

      setTimeout(() => {
        ptyProcess.write('\x04');
        setTimeout(() => {
          ptyProcess.write('\x04');
          setTimeout(() => {
            try {
              ptyProcess.kill();
            } catch (_) {}
          }, 2000);
        }, 150);
      }, 250);
    }

    ptyProcess.onData((rawData) => {
      handleTerminalQueries(ptyProcess, rawData);

      const clean = stripAnsi(rawData);
      rollingClean = (rollingClean + clean).slice(-4000);

      // 1. Detect turn generation start
      if (
        !hasStartedGenerating &&
        (rollingClean.includes('esc to cancel') || rollingClean.includes('Generating'))
      ) {
        hasStartedGenerating = true;
        setTurnStatus('generating', 'AGY is thinking & executing...');
      }

      // 2. Detect TUI permission prompt and simulate hitting Enter (\r)
      // Skip if `ask_question` is currently active!
      const now = Date.now();
      if (!pendingAskQuestion && !pendingEnterTimer && now - lastApproveTimestamp > 1000) {
        const check = detectPermissionPrompt(rollingClean);
        if (check.matched) {
          lastApproveTimestamp = now;
          rollingClean = '';

          // Sync transcript immediately so latest tool_call items are available before computing placement
          syncTranscript(true);

          const isWorkspaceTrust = /Workspace trust|trust this folder/i.test(
            `${check.title || ''} ${check.snippet || ''}`
          );
          const latestStep =
            latestRawSteps.length > 0 ? latestRawSteps[latestRawSteps.length - 1] : null;
          const latestStepIdx = latestStep
            ? latestStep.step_index
            : Math.max(0, baselineStepCount);
          const minToolStepIndex = !latestStep
            ? baselineStepCount
            : latestStep.type === 'PLANNER_RESPONSE'
              ? latestStep.step_index
              : latestStep.step_index + 1;

          const matchedTool = isWorkspaceTrust
            ? null
            : findMatchingToolItem(latestItems, check, minToolStepIndex);
          if (matchedTool) {
            boundToolItemIds.add(matchedTool.id);
          }

          const permId = `perm-${Date.now()}-${turnPermissions.length}`;
          const promptRecord = {
            id: permId,
            sessionId: activeSessionId,
            afterItemId: matchedTool ? matchedTool.id : null,
            afterStepIndex: matchedTool ? matchedTool.stepIndex : latestStepIdx,
            minToolStepIndex,
            turnStartStepIndex: baselineStepCount,
            isWorkspaceTrust,
            title: check.title,
            target: check.target,
            reason: check.reason,
            question: check.question,
            options: check.options,
            snippet: check.snippet,
            status: 'pending',
            detectedAt: new Date().toISOString(),
            approvedAt: null,
            keySent: approvalInput
          };

          turnPermissions.push(promptRecord);
          if (activeSessionId) {
            attachTurnPermissionsToSession(activeSessionId);
          }

          emitTurnEvent('permission_prompt', promptRecord);
          setTurnStatus('permission_prompt', `Auto-approving: ${check.title}...`);

          pendingEnterTimer = setTimeout(() => {
            pendingEnterTimer = null;
            ptyProcess.write(approvalInput);
            promptRecord.status = 'approved';
            promptRecord.approvedAt = new Date().toISOString();
            syncTranscript(true);
            autoApprovals.push(promptRecord);
            emitTurnEvent('enter_simulated', promptRecord);
            setTurnStatus('generating', 'Simulated Enter (\\r) sent · Resuming execution...');
          }, 350);
        }
      }

      // 3. Detect turn completion when TUI returns to `? for shortcuts` after generation
      // Gated by `analyzeTurnState`: never exit while background tasks/subagents/timers are pending!
      if (
        hasStartedGenerating &&
        !isExiting &&
        !pendingEnterTimer &&
        !pendingAskQuestion &&
        (clean.includes('? for shortcuts') || transcriptFinalResponseDone)
      ) {
        resolveSessionIdFromLog();
        syncTranscript(true);

        if (transcriptFinalResponseDone) {
          triggerGracefulExit('Turn idle ("? for shortcuts" detected); exiting PTY via Ctrl+D x2');
        } else if (latestTurnState.hasPendingBackgroundWork) {
          setTurnStatus(
            'waiting_for_background',
            latestTurnState.pendingBackgroundSummary || 'Waiting for background tasks to finish...'
          );
        }
      }

      // 4. Backup conversation ID capture from exit banner
      const resumeMatch = rollingClean.match(/agy --conversation=([0-9a-f-]{36})/i);
      if (resumeMatch && resumeMatch[1] && !activeSessionId) {
        activeSessionId = resumeMatch[1];
        activeTurns.set(activeSessionId, turnController);
        attachTurnPermissionsToSession(activeSessionId);
        emitTurnEvent('session', { sessionId: activeSessionId, source: 'exit-banner' });
      }
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      clearInterval(pollTimer);
      clearTimeout(safetyTimeout);
      if (pendingEnterTimer) clearTimeout(pendingEnterTimer);

      isExiting = true;
      currentState = 'idle';

      activeTurnsByTurnId.delete(turnId);
      if (activeSessionId && activeTurns.get(activeSessionId) === turnController) {
        activeTurns.delete(activeSessionId);
      }

      syncTranscript(true);

      try {
        if (fs.existsSync(tmpLogFile)) fs.unlinkSync(tmpLogFile);
      } catch (_) {}

      const finalConversation = activeSessionId
        ? readConversation(activeSessionId)
        : { sessionId: null, items: [], permissions: autoApprovals };

      const result = {
        turnId,
        sessionId: activeSessionId,
        exitCode,
        signal,
        autoApprovalsCount: autoApprovals.length,
        autoApprovals,
        items: finalConversation.items,
        permissions: finalConversation.permissions
      };

      emitTurnEvent('exit', result);
      resolve(result);
    });
  });
}

/**
 * GET /api/workspaces
 * Returns preset workspace paths and subdirectories for the path selector.
 */
app.get('/api/workspaces', (req, res) => {
  const home = os.homedir();
  const projectsDir = path.join(home, 'Projects');
  const lowerProjectsDir = path.join(home, 'projects');
  const presets = new Set([__dirname, projectsDir, lowerProjectsDir, home]);

  for (const dir of [projectsDir, lowerProjectsDir]) {
    if (fs.existsSync(dir)) {
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory() && !entry.name.startsWith('.')) {
            presets.add(path.join(dir, entry.name));
          }
        }
      } catch (_) {}
    }
  }

  for (const s of listSessions()) {
    if (s.workspace && fs.existsSync(s.workspace)) {
      presets.add(s.workspace);
    }
  }

  res.json({
    defaultWorkspace: __dirname,
    workspaces: Array.from(presets).filter((p) => fs.existsSync(p))
  });
});

/**
 * GET /api/sessions
 * Returns historical and active `agy` sessions with live progress metadata.
 */
app.get('/api/sessions', (req, res) => {
  res.json({ sessions: listSessions() });
});

/**
 * GET /api/sessions/:id
 * Returns parsed messages, muted tool calls, thoughts, ask_question items, permission cards, and live status.
 */
app.get('/api/sessions/:id', (req, res) => {
  const sessionId = req.params.id;
  const data = readConversation(sessionId);
  if (
    !data.transcriptPath &&
    !activeTurns.has(sessionId) &&
    !activeTurnsByTurnId.has(sessionId)
  ) {
    return res.status(404).json({
      ...data,
      error: `Session "${sessionId}" not found`
    });
  }
  res.json(data);
});

/**
 * GET /api/sessions/:id/stream
 * Attach an SSE listener to an already-running session turn (e.g. after switching sessions or reloading).
 */
app.get('/api/sessions/:id/stream', (req, res) => {
  const sessionId = req.params.id;
  const controller = activeTurns.get(sessionId) || activeTurnsByTurnId.get(sessionId);
  if (!controller) {
    return res.status(404).json({ error: `No active turn running for session "${sessionId}"` });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const sendSse = (event, data) => {
    if (!res.writableEnded) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      if (event === 'exit') {
        res.end();
      }
    }
  };

  // Send immediate snapshot
  sendSse('status', controller.getSnapshotMeta());
  if (controller.items.length > 0) {
    sendSse('transcript', {
      sessionId: controller.sessionId,
      items: controller.items,
      stepCount: controller.stepCount,
      progressLabel: controller.getSnapshotMeta().progressLabel
    });
  }
  if (controller.pendingAskQuestion) {
    sendSse('ask_question', controller.pendingAskQuestion);
  }

  const unsubscribe = controller.subscribe(sendSse);
  req.on('close', () => {
    unsubscribe();
  });
});

/**
 * POST /api/ask-question
 * Submits user's selected option(s) / write-in text / skip action to the target session's active PTY turn.
 */
app.post('/api/ask-question', async (req, res) => {
  const { sessionId, turnId, action = 'submit', answers = [] } = req.body || {};
  let controller = null;
  if (sessionId && activeTurns.has(sessionId)) {
    controller = activeTurns.get(sessionId);
  } else if (turnId && activeTurnsByTurnId.has(turnId)) {
    controller = activeTurnsByTurnId.get(turnId);
  } else if (!sessionId && !turnId && activeTurnsByTurnId.size === 1) {
    controller = activeTurnsByTurnId.values().next().value;
  }

  if (!controller || !controller.pendingAskQuestion) {
    return res.status(409).json({
      error: 'No active PTY turn for this session is currently waiting on ask_question',
      canResumeAsPrompt: true
    });
  }

  try {
    await controller.submitAskQuestion({ action, answers });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/chat
 * Streams SSE events (`session`, `status`, `transcript`, `ask_question`, `permission_prompt`, `enter_simulated`, `exit`).
 * Supports multiple concurrent turns across different sessions.
 */
app.post('/api/chat', async (req, res) => {
  const {
    prompt,
    sessionId,
    conversationId,
    clientTurnId = null,
    cwd = __dirname,
    approvalInput = '\r'
  } = req.body || {};

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: '`prompt` is required' });
  }

  const targetSessionId = sessionId || conversationId || null;
  if (targetSessionId && activeTurns.has(targetSessionId)) {
    return res.status(409).json({
      error: `Session "${targetSessionId}" already has a turn in progress.`
    });
  }
  if (clientTurnId && activeTurnsByTurnId.has(clientTurnId)) {
    return res.status(409).json({
      error: `Turn "${clientTurnId}" is already in progress.`
    });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const sendSse = (event, data) => {
    if (!res.writableEnded) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  };

  try {
    await runAgyTurn({
      prompt,
      conversationId: targetSessionId,
      clientTurnId,
      cwd,
      approvalInput,
      onEvent: sendSse
    });
    if (!res.writableEnded) res.end();
  } catch (err) {
    sendSse('error', { error: err.message });
    if (!res.writableEnded) res.end();
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[agy-poc] Antigravity Web UI + PTY Server running at http://localhost:${PORT}`);
    console.log(`[agy-poc] Using GOOGLE_CLOUD_PROJECT=${GCP_PROJECT} | Binary: ${AGY_BIN}`);
  });
}

module.exports = { app, runAgyTurn, readConversation, listSessions };
