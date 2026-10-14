const express = require('express');
const pty = require('node-pty');
const fs = require('fs');
const os = require('os');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const AGY_BIN = process.env.AGY_BIN || path.join(os.homedir(), '.local/bin/agy');
const GCP_PROJECT = process.env.GOOGLE_CLOUD_PROJECT || 'next-gemini-ent-prd';
const AGY_CLI_DIR = path.join(os.homedir(), '.gemini/antigravity-cli');
const BRAIN_DIR = path.join(AGY_CLI_DIR, 'brain');
const SUMMARIES_DB = path.join(AGY_CLI_DIR, 'conversation_summaries.db');

// Keep in-memory history of permission prompts captured per session during server lifetime
const sessionPermissions = new Map();

// Active live PTY turns keyed by sessionId (plus 'latest' pointer) so Web UI can answer ask_question
const activeTurns = new Map();
let latestActiveTurn = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
 * Locate the transcript file for a given conversation UUID.
 */
function getTranscriptPath(sessionId) {
  const logsDir = path.join(BRAIN_DIR, sessionId, '.system_generated', 'logs');
  const fullPath = path.join(logsDir, 'transcript_full.jsonl');
  const compactPath = path.join(logsDir, 'transcript.jsonl');
  if (fs.existsSync(fullPath)) return fullPath;
  if (fs.existsSync(compactPath)) return compactPath;
  return null;
}

/**
 * Clean `<USER_REQUEST>...</USER_REQUEST>` wrapper from `USER_INPUT` content.
 */
function extractUserRequest(rawContent) {
  if (!rawContent) return '';
  const match = rawContent.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  if (match && match[1]) return match[1].trim();
  return rawContent.trim();
}

/**
 * Parse `A1: ...\nA2: ...` from an `ask_question` GENERIC tool output step.
 */
function parseAskQuestionOutput(rawOutput) {
  const answersByQuestion = {};
  if (!rawOutput) return answersByQuestion;
  const lines = rawOutput.split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^A(\d+):\s*(.+)$/);
    if (m) {
      const qIndex = parseInt(m[1], 10) - 1;
      answersByQuestion[qIndex] = m[2].trim();
    }
  }
  return answersByQuestion;
}

/**
 * Parse raw JSONL lines from `transcript_full.jsonl` into structured UI items.
 * Pairs `GENERIC` tool outputs with their preceding `PLANNER_RESPONSE` tool calls,
 * and elevates `ask_question` tool calls into interactive Question UI items.
 */
function parseTranscriptLines(rawLines) {
  const rawSteps = [];
  for (const line of rawLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rawSteps.push(JSON.parse(trimmed));
    } catch (_) {}
  }

  const items = [];
  let pendingToolItems = [];

  for (const step of rawSteps) {
    const stepIndex = step.step_index;
    const createdAt = step.created_at || null;

    if (step.type === 'USER_INPUT') {
      pendingToolItems = [];
      items.push({
        id: `step-${stepIndex}-user`,
        stepIndex,
        role: 'user',
        content: extractUserRequest(step.content),
        createdAt
      });
      continue;
    }

    if (step.source === 'SYSTEM' || step.type === 'SYSTEM_MESSAGE') {
      // Skip synthetic cold-resume SYSTEM_MESSAGE steps per AGY_IMPLEMENTATION.md Section 2.3
      continue;
    }

    if (step.type === 'PLANNER_RESPONSE') {
      if (step.thinking && step.thinking.trim()) {
        items.push({
          id: `step-${stepIndex}-thought`,
          stepIndex,
          role: 'thought',
          content: step.thinking.trim(),
          createdAt
        });
      }

      if (Array.isArray(step.tool_calls) && step.tool_calls.length > 0) {
        pendingToolItems = [];
        step.tool_calls.forEach((tc, idx) => {
          let args = tc.args || {};
          if (typeof args === 'string') {
            try {
              args = JSON.parse(args);
            } catch (_) {}
          }

          if (tc.name === 'ask_question') {
            const askItem = {
              id: `step-${stepIndex}-ask-${idx}`,
              stepIndex,
              role: 'ask_question',
              toolName: 'ask_question',
              summary: args.toolAction || args.toolSummary || 'Question from Antigravity',
              questions: Array.isArray(args.questions) ? args.questions : [],
              args,
              output: null,
              parsedAnswers: {},
              status: 'waiting',
              createdAt
            };
            pendingToolItems.push(askItem);
            items.push(askItem);
            return;
          }

          const summary =
            args.toolAction ||
            args.toolSummary ||
            args.CommandLine ||
            args.AbsolutePath ||
            JSON.stringify(args);
          const detail =
            args.CommandLine ||
            args.AbsolutePath ||
            args.TargetFile ||
            args.Url ||
            args.query ||
            '';

          const toolItem = {
            id: `step-${stepIndex}-tool-${idx}`,
            stepIndex,
            role: 'tool_call',
            toolName: tc.name || 'tool',
            summary,
            detail,
            bypassSandbox: Boolean(args.BypassSandbox),
            args,
            output: null,
            status: 'running',
            createdAt
          };
          pendingToolItems.push(toolItem);
          items.push(toolItem);
        });
      }

      if (step.content && step.content.trim()) {
        items.push({
          id: `step-${stepIndex}-assistant`,
          stepIndex,
          role: 'assistant',
          content: step.content.trim(),
          createdAt
        });
      }
      continue;
    }

    if (step.type === 'GENERIC') {
      const targetTool = pendingToolItems.find((t) => t.output === null);
      if (targetTool) {
        targetTool.output = step.content || '';
        targetTool.status = 'done';
        if (targetTool.role === 'ask_question') {
          targetTool.parsedAnswers = parseAskQuestionOutput(step.content || '');
        }
      } else {
        items.push({
          id: `step-${stepIndex}-generic`,
          stepIndex,
          role: 'tool_call',
          toolName: 'tool_result',
          summary: 'Tool output',
          detail: '',
          args: {},
          output: step.content || '',
          status: 'done',
          createdAt
        });
      }
    }
  }

  return { rawSteps, items };
}

/**
 * Read a full conversation from `~/.gemini/antigravity-cli/brain/<sessionId>`.
 */
function readConversation(sessionId) {
  const transcriptPath = getTranscriptPath(sessionId);
  if (!transcriptPath) {
    return {
      sessionId,
      rawSteps: [],
      items: [],
      permissions: sessionPermissions.get(sessionId) || []
    };
  }
  const content = fs.readFileSync(transcriptPath, 'utf8');
  const lines = content.split(/\r?\n/).filter(Boolean);
  const { rawSteps, items } = parseTranscriptLines(lines);
  return {
    sessionId,
    transcriptPath,
    rawSteps,
    items,
    permissions: sessionPermissions.get(sessionId) || []
  };
}

/**
 * List sessions from `conversation_summaries.db` (via node:sqlite if available)
 * combined with a fast directory scan of `~/.gemini/antigravity-cli/brain/`.
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

  if (fs.existsSync(BRAIN_DIR)) {
    try {
      const entries = fs.readdirSync(BRAIN_DIR, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const id = entry.name;
        const tPath = getTranscriptPath(id);
        if (!tPath) continue;

        const stat = fs.statSync(tPath);
        const content = fs.readFileSync(tPath, 'utf8');
        const lines = content.split(/\r?\n/).filter(Boolean);
        const { items } = parseTranscriptLines(lines);
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
          workspace: (existing && existing.workspace) || ''
        });
      }
    } catch (_) {}
  }

  return Array.from(sessionsMap.values()).sort((a, b) =>
    (b.updatedAt || '').localeCompare(a.updatedAt || '')
  );
}

/**
 * Run a single interactive turn in `agy` via node-pty (Control Plane)
 * while tailing `transcript_full.jsonl` (Data Plane).
 */
function runAgyTurn({
  prompt,
  conversationId,
  cwd = __dirname,
  approvalInput = '\r',
  timeoutMs = 180000,
  onEvent = () => {}
}) {
  return new Promise((resolve) => {
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

    onEvent('spawn', {
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

    let activeSessionId = conversationId || null;
    let rollingClean = '';
    let hasStartedGenerating = false;
    let isExiting = false;
    let pendingEnterTimer = null;
    let lastApproveTimestamp = 0;
    let lastEmittedLineCount = baselineStepCount;
    let transcriptFinalResponseDone = false;
    let pendingAskQuestion = null;
    const autoApprovals = [];

    const turnController = {
      get sessionId() {
        return activeSessionId;
      },
      get pendingAskQuestion() {
        return pendingAskQuestion;
      },
      async submitAskQuestion(submission) {
        if (!pendingAskQuestion) {
          throw new Error('No pending ask_question in active PTY turn');
        }
        const currentQ = pendingAskQuestion;
        pendingAskQuestion = null;
        rollingClean = '';
        onEvent('status', {
          state: 'answering_question',
          message: 'Submitting answer to AGY TUI...'
        });
        await sendAskQuestionKeystrokes(ptyProcess, currentQ.questions, submission);
        onEvent('ask_question_submitted', {
          stepIndex: currentQ.stepIndex,
          submission
        });
      }
    };

    latestActiveTurn = turnController;
    if (activeSessionId) {
      activeTurns.set(activeSessionId, turnController);
    }

    function syncTranscript() {
      if (!activeSessionId) return;
      const tPath = getTranscriptPath(activeSessionId);
      if (!tPath) return;
      try {
        const content = fs.readFileSync(tPath, 'utf8');
        const lines = content.split(/\r?\n/).filter(Boolean);
        if (lines.length > lastEmittedLineCount) {
          lastEmittedLineCount = lines.length;
          const { rawSteps, items } = parseTranscriptLines(lines);
          onEvent('transcript', {
            sessionId: activeSessionId,
            items,
            stepCount: rawSteps.length
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
              onEvent('ask_question', pendingAskQuestion);
              onEvent('status', {
                state: 'waiting_for_question',
                message: 'Waiting for your answer in AskQuestion...'
              });
            }
          } else if (latestStep && latestStep.type === 'GENERIC') {
            pendingAskQuestion = null;
          }

          // Check if the latest step is a completed PLANNER_RESPONSE with NO tool_calls
          if (
            latestStep &&
            latestStep.step_index >= baselineStepCount &&
            latestStep.type === 'PLANNER_RESPONSE' &&
            latestStep.status === 'DONE' &&
            (!Array.isArray(latestStep.tool_calls) || latestStep.tool_calls.length === 0)
          ) {
            transcriptFinalResponseDone = true;
            if (!isExiting && !pendingEnterTimer && !pendingAskQuestion) {
              triggerGracefulExit(
                'Turn complete (final PLANNER_RESPONSE DONE in transcript); exiting PTY via Ctrl+D x2'
              );
            }
          } else {
            transcriptFinalResponseDone = false;
          }
        }
      } catch (_) {}
    }

    const pollTimer = setInterval(() => {
      if (!activeSessionId && fs.existsSync(tmpLogFile)) {
        try {
          const logContent = fs.readFileSync(tmpLogFile, 'utf8');
          const match =
            logContent.match(/Created conversation ([0-9a-f-]{36})/i) ||
            logContent.match(/Streaming conversation ([0-9a-f-]{36})/i);
          if (match && match[1]) {
            activeSessionId = match[1];
            activeTurns.set(activeSessionId, turnController);
            onEvent('session', { sessionId: activeSessionId, source: 'log-file' });
          }
        } catch (_) {}
      }
      syncTranscript();
    }, 150);

    const safetyTimeout = setTimeout(() => {
      if (!isExiting) {
        isExiting = true;
        onEvent('status', { state: 'timeout', message: 'Turn timeout reached; sending Ctrl+D x2' });
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
      syncTranscript();
      onEvent('status', { state: 'completing', message: reason });

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
        onEvent('status', { state: 'generating', message: 'AGY is thinking & executing...' });
      }

      // 2. Detect TUI permission prompt and simulate hitting Enter (\r)
      // Skip if `ask_question` is currently active!
      const now = Date.now();
      if (!pendingAskQuestion && !pendingEnterTimer && now - lastApproveTimestamp > 1000) {
        const check = detectPermissionPrompt(rollingClean);
        if (check.matched) {
          lastApproveTimestamp = now;
          rollingClean = '';

          const permId = `perm-${Date.now()}`;
          const promptRecord = {
            id: permId,
            sessionId: activeSessionId,
            afterStepIndex: Math.max(0, lastEmittedLineCount - 1),
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

          if (activeSessionId) {
            const list = sessionPermissions.get(activeSessionId) || [];
            list.push(promptRecord);
            sessionPermissions.set(activeSessionId, list);
          }

          onEvent('permission_prompt', promptRecord);

          pendingEnterTimer = setTimeout(() => {
            pendingEnterTimer = null;
            ptyProcess.write(approvalInput);
            promptRecord.status = 'approved';
            promptRecord.approvedAt = new Date().toISOString();
            autoApprovals.push(promptRecord);
            onEvent('enter_simulated', promptRecord);
          }, 350);
        }
      }

      // 3. Detect turn completion: footer returns to `? for shortcuts` after generation
      if (
        hasStartedGenerating &&
        !isExiting &&
        !pendingEnterTimer &&
        !pendingAskQuestion &&
        (clean.includes('? for shortcuts') || transcriptFinalResponseDone)
      ) {
        triggerGracefulExit('Turn idle ("? for shortcuts" detected); exiting PTY via Ctrl+D x2');
      }

      // 4. Backup conversation ID capture from exit banner
      const resumeMatch = rollingClean.match(/agy --conversation=([0-9a-f-]{36})/i);
      if (resumeMatch && resumeMatch[1] && !activeSessionId) {
        activeSessionId = resumeMatch[1];
        activeTurns.set(activeSessionId, turnController);
        onEvent('session', { sessionId: activeSessionId, source: 'exit-banner' });
      }
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      clearInterval(pollTimer);
      clearTimeout(safetyTimeout);
      if (pendingEnterTimer) clearTimeout(pendingEnterTimer);

      if (activeSessionId) {
        activeTurns.delete(activeSessionId);
      }
      if (latestActiveTurn === turnController) {
        latestActiveTurn = null;
      }

      syncTranscript();

      try {
        if (fs.existsSync(tmpLogFile)) fs.unlinkSync(tmpLogFile);
      } catch (_) {}

      const finalConversation = activeSessionId
        ? readConversation(activeSessionId)
        : { sessionId: null, items: [], permissions: autoApprovals };

      const result = {
        sessionId: activeSessionId,
        exitCode,
        signal,
        autoApprovalsCount: autoApprovals.length,
        autoApprovals,
        items: finalConversation.items
      };

      onEvent('exit', result);
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
  const presets = new Set([__dirname, projectsDir, home]);

  if (fs.existsSync(projectsDir)) {
    try {
      for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          presets.add(path.join(projectsDir, entry.name));
        }
      }
    } catch (_) {}
  }

  for (const s of listSessions()) {
    if (s.workspace && fs.existsSync(s.workspace)) {
      presets.add(s.workspace);
    }
  }

  res.json({
    defaultWorkspace: __dirname,
    workspaces: Array.from(presets)
  });
});

/**
 * GET /api/sessions
 * Returns historical `agy` sessions from `~/.gemini/antigravity-cli`.
 */
app.get('/api/sessions', (req, res) => {
  res.json({ sessions: listSessions() });
});

/**
 * GET /api/sessions/:id
 * Returns parsed messages, muted tool calls, thoughts, ask_question items, and permission cards.
 */
app.get('/api/sessions/:id', (req, res) => {
  const data = readConversation(req.params.id);
  res.json(data);
});

/**
 * POST /api/ask-question
 * Submits user's selected option(s) / write-in text / skip action to the active PTY turn.
 */
app.post('/api/ask-question', async (req, res) => {
  const { sessionId, action = 'submit', answers = [] } = req.body || {};
  const controller = (sessionId && activeTurns.get(sessionId)) || latestActiveTurn;

  if (!controller || !controller.pendingAskQuestion) {
    return res.status(409).json({
      error: 'No active PTY turn is currently waiting on ask_question',
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
 */
app.post('/api/chat', async (req, res) => {
  const {
    prompt,
    sessionId,
    conversationId,
    cwd = __dirname,
    approvalInput = '\r'
  } = req.body || {};

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: '`prompt` is required' });
  }

  const targetSessionId = sessionId || conversationId || null;

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
