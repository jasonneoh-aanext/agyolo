const fs = require('fs');
const path = require('path');

const TASK_ID_REGEX =
  /Tool is running as a background task with task id:\s*([^\s"'<>]+)/i;
const FINISHED_TASK_REGEX =
  /Task id ["']?([^"'\s]+)["']?\s+(?:finished|completed|terminated|stopped|failed|exited)/i;
const UUID_REGEX =
  /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;

/**
 * Strip `<SYSTEM_MESSAGE>...</SYSTEM_MESSAGE>` envelopes and standard system preamble
 * from raw step content, returning any genuine user text that remains.
 */
function stripSystemMessages(rawContent) {
  if (!rawContent || typeof rawContent !== 'string') return '';
  let cleaned = rawContent.replace(
    /The following is a <SYSTEM_MESSAGE> not actually sent by the user\.[^\n]*\n*/gi,
    ''
  );
  cleaned = cleaned.replace(/<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/gi, '');
  return cleaned.trim();
}

/**
 * Extract `<SYSTEM_MESSAGE>` blocks from a step's content.
 * Returns an array of `{ sender, priority, timestamp, content, rawBlock }`.
 */
function parseSystemMessages(rawContent) {
  if (!rawContent || typeof rawContent !== 'string') return [];
  const results = [];
  const blockRegex = /<SYSTEM_MESSAGE>\s*([\s\S]*?)\s*<\/SYSTEM_MESSAGE>/gi;
  let match;
  while ((match = blockRegex.exec(rawContent)) !== null) {
    const inner = match[1].trim();
    const headerMatch = inner.match(
      /^\[Message\]\s+timestamp=(\S+)\s+sender=(\S+)\s+priority=(\S+)\s+content=([\s\S]*)$/i
    );
    if (headerMatch) {
      results.push({
        timestamp: headerMatch[1],
        sender: headerMatch[2],
        priority: headerMatch[3],
        content: headerMatch[4].trim(),
        rawBlock: inner
      });
    } else {
      results.push({
        timestamp: null,
        sender: 'system',
        priority: 'NORMAL',
        content: inner,
        rawBlock: inner
      });
    }
  }
  return results;
}

/**
 * Clean `<USER_REQUEST>...</USER_REQUEST>` wrapper from `USER_INPUT` content.
 * Returns empty string if the step only contains `<SYSTEM_MESSAGE>` reactive wakeup data.
 */
function extractUserRequest(rawContent) {
  if (!rawContent || typeof rawContent !== 'string') return '';
  const match = rawContent.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
  if (match && match[1]) {
    return stripSystemMessages(match[1]);
  }
  return stripSystemMessages(rawContent);
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
 * Check if a `run_command` or `schedule` GENERIC output indicates a backgrounded task.
 */
function extractBackgroundTaskId(rawOutput) {
  if (!rawOutput || typeof rawOutput !== 'string') return null;
  const match = rawOutput.match(TASK_ID_REGEX);
  if (match && match[1]) {
    return match[1].trim();
  }
  return null;
}

function isBackgroundedCommandOutput(rawOutput) {
  return Boolean(extractBackgroundTaskId(rawOutput));
}

/**
 * Normalize a task ID so `<conversationId>/task-1` and `task-1` can match each other.
 */
function normalizeTaskShortId(taskId) {
  if (!taskId || typeof taskId !== 'string') return '';
  const parts = taskId.trim().split('/');
  return parts[parts.length - 1];
}

function taskIdsMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const shortA = normalizeTaskShortId(a);
  const shortB = normalizeTaskShortId(b);
  return Boolean(shortA && shortA === shortB);
}

/**
 * Check if a subagent's own transcript on disk has finished its turn.
 */
function isSubagentCompleteOnDisk(subagentId, brainDirs = []) {
  if (!subagentId || !Array.isArray(brainDirs)) return false;
  for (const brainDir of brainDirs) {
    const logsDir = path.join(brainDir, subagentId, '.system_generated', 'logs');
    const fullPath = path.join(logsDir, 'transcript_full.jsonl');
    const compactPath = path.join(logsDir, 'transcript.jsonl');
    const tPath = fs.existsSync(fullPath)
      ? fullPath
      : fs.existsSync(compactPath)
        ? compactPath
        : null;
    if (!tPath) continue;
    try {
      const lines = fs
        .readFileSync(tPath, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean);
      if (lines.length === 0) continue;
      const lastStep = JSON.parse(lines[lines.length - 1]);
      if (
        lastStep &&
        lastStep.type === 'PLANNER_RESPONSE' &&
        lastStep.status === 'DONE' &&
        (!Array.isArray(lastStep.tool_calls) || lastStep.tool_calls.length === 0)
      ) {
        return true;
      }
    } catch (_) {}
  }
  return false;
}

/**
 * Parse raw JSONL lines from `transcript_full.jsonl` into structured UI items,
 * resolving `<SYSTEM_MESSAGE>` background wakeups and computing turn completion state.
 */
function parseTranscriptLines(rawLines, options = {}) {
  const { baselineStepCount = 0, brainDirs = [] } = options;

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
  let workspaceCwd = '';

  // Background lifecycle tracking maps
  const pendingBackgroundTasks = new Map(); // taskId -> { taskId, toolItem, stepIndex }
  const pendingSubagents = new Map(); // key -> { id, role, toolItem, stepIndex }
  const pendingTimers = new Map(); // timerKey -> { timerKey, condition, prompt, toolItem, stepIndex }
  const backgroundToolByTaskId = new Map(); // taskId (and shortId) -> toolItem

  function registerBackgroundTask(taskId, toolItem, stepIndex) {
    if (!taskId) return;
    pendingBackgroundTasks.set(taskId, { taskId, toolItem, stepIndex });
    backgroundToolByTaskId.set(taskId, toolItem);
    const shortId = normalizeTaskShortId(taskId);
    if (shortId) {
      backgroundToolByTaskId.set(shortId, toolItem);
    }
    if (toolItem) {
      toolItem.isBackground = true;
      toolItem.backgroundTaskId = taskId;
      toolItem.status = 'running';
    }
  }

  function resolveBackgroundTask(taskId, wakeupContent) {
    if (!taskId) return false;
    let matchedKey = null;
    for (const key of pendingBackgroundTasks.keys()) {
      if (taskIdsMatch(key, taskId)) {
        matchedKey = key;
        break;
      }
    }
    if (matchedKey) {
      pendingBackgroundTasks.delete(matchedKey);
    }

    const toolItem =
      backgroundToolByTaskId.get(taskId) ||
      backgroundToolByTaskId.get(normalizeTaskShortId(taskId));
    if (toolItem) {
      if (wakeupContent) {
        toolItem.output = toolItem.output
          ? `${toolItem.output.trim()}\n\n--- Background Task Completed ---\n${wakeupContent}`
          : wakeupContent;
      }
      toolItem.status = 'done';
      return true;
    }
    return Boolean(matchedKey);
  }

  function clearTimersOnMessage(sender) {
    for (const [timerKey, timer] of pendingTimers.entries()) {
      if (
        timer.condition === 'any' ||
        (sender && (timer.condition === sender || taskIdsMatch(timer.condition, sender)))
      ) {
        pendingTimers.delete(timerKey);
        if (timer.toolItem && timer.toolItem.status === 'running') {
          timer.toolItem.status = 'done';
        }
      }
    }
  }

  function processSystemWakeupMessages(sysMessages) {
    for (const msg of sysMessages) {
      const sender = msg.sender || '';
      const content = msg.content || '';

      // Server restart notice clears all active background work
      if (/All your subagents and background tasks have been stopped/i.test(content)) {
        for (const { toolItem } of pendingBackgroundTasks.values()) {
          if (toolItem) toolItem.status = 'done';
        }
        for (const { toolItem } of pendingSubagents.values()) {
          if (toolItem) toolItem.status = 'done';
        }
        for (const { toolItem } of pendingTimers.values()) {
          if (toolItem) toolItem.status = 'done';
        }
        pendingBackgroundTasks.clear();
        pendingSubagents.clear();
        pendingTimers.clear();
        continue;
      }

      // Check early timer termination conditions first
      clearTimersOnMessage(sender);

      // 1. Direct task completion wakeup (by sender or content regex)
      const finishedMatch = content.match(FINISHED_TASK_REGEX);
      const taskIdFromContent = finishedMatch ? finishedMatch[1] : null;
      const isTaskSender = /\/task-\d+$|^task-\d+$/i.test(sender);

      if (taskIdFromContent || isTaskSender) {
        const targetTaskId = taskIdFromContent || sender;
        resolveBackgroundTask(targetTaskId, content);
        // Also check if this task ID was a scheduled timer
        for (const [timerKey, timer] of pendingTimers.entries()) {
          if (taskIdsMatch(timerKey, targetTaskId)) {
            pendingTimers.delete(timerKey);
            if (timer.toolItem) {
              timer.toolItem.output = timer.toolItem.output
                ? `${timer.toolItem.output.trim()}\n\n--- Timer Fired ---\n${content}`
                : content;
              timer.toolItem.status = 'done';
            }
          }
        }
        continue;
      }

      // 2. Subagent wakeup (sender is subagent conversation UUID or matches pending subagent)
      if (sender && sender !== 'system') {
        if (pendingSubagents.has(sender)) {
          const entry = pendingSubagents.get(sender);
          pendingSubagents.delete(sender);
          if (entry && entry.toolItem) {
            entry.toolItem.output = entry.toolItem.output
              ? `${entry.toolItem.output.trim()}\n\n--- Subagent Response (${sender.slice(0, 8)}) ---\n${content}`
              : content;
            // Only mark invoke_subagent tool done if no other subagents from same toolItem remain pending
            const stillPendingForTool = Array.from(pendingSubagents.values()).some(
              (s) => s.toolItem === entry.toolItem
            );
            if (!stillPendingForTool) {
              entry.toolItem.status = 'done';
            }
          }
          continue;
        } else if (pendingSubagents.size > 0) {
          // Fallback: if subagent was registered under a placeholder key before its UUID was known
          const firstPlaceholder = Array.from(pendingSubagents.entries()).find(([k]) =>
            k.startsWith('subagent-pending-')
          );
          if (firstPlaceholder) {
            const [placeholderKey, entry] = firstPlaceholder;
            pendingSubagents.delete(placeholderKey);
            if (entry && entry.toolItem) {
              entry.toolItem.output = entry.toolItem.output
                ? `${entry.toolItem.output.trim()}\n\n--- Subagent Response (${sender.slice(0, 8)}) ---\n${content}`
                : content;
              const stillPendingForTool = Array.from(pendingSubagents.values()).some(
                (s) => s.toolItem === entry.toolItem
              );
              if (!stillPendingForTool) {
                entry.toolItem.status = 'done';
              }
            }
            continue;
          }
        }
      }

      // 3. Scheduled timer wakeup matching prompt or sender
      if (pendingTimers.size > 0) {
        let matchedTimerKey = null;
        for (const [timerKey, timer] of pendingTimers.entries()) {
          if (
            (timer.prompt && content.includes(timer.prompt)) ||
            taskIdsMatch(timerKey, sender)
          ) {
            matchedTimerKey = timerKey;
            break;
          }
        }
        if (!matchedTimerKey && sender === 'system') {
          matchedTimerKey = pendingTimers.keys().next().value;
        }
        if (matchedTimerKey) {
          const timer = pendingTimers.get(matchedTimerKey);
          pendingTimers.delete(matchedTimerKey);
          if (timer && timer.toolItem) {
            timer.toolItem.output = timer.toolItem.output
              ? `${timer.toolItem.output.trim()}\n\n--- Timer Fired ---\n${content}`
              : content;
            timer.toolItem.status = 'done';
          }
        }
      }
    }
  }

  for (const step of rawSteps) {
    const stepIndex = step.step_index;
    const createdAt = step.created_at || null;
    const rawContent = step.content || '';

    // Extract any <SYSTEM_MESSAGE> blocks present in this step
    const sysMessages = parseSystemMessages(rawContent);

    if (step.type === 'USER_INPUT') {
      pendingToolItems = [];
      if (sysMessages.length > 0) {
        processSystemWakeupMessages(sysMessages);
      }
      const cleanedUserText = extractUserRequest(rawContent);
      if (cleanedUserText) {
        items.push({
          id: `step-${stepIndex}-user`,
          stepIndex,
          role: 'user',
          content: cleanedUserText,
          createdAt
        });
      }
      continue;
    }

    if (step.source === 'SYSTEM' || step.type === 'SYSTEM_MESSAGE') {
      if (!workspaceCwd && rawContent) {
        const wsMatch = rawContent.match(/Active Workspaces:\s*\r?\n-\s*([^\r\n]+)/i);
        if (wsMatch && wsMatch[1]) {
          workspaceCwd = wsMatch[1].trim();
        }
      }
      if (sysMessages.length > 0) {
        processSystemWakeupMessages(sysMessages);
      }
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

          if (!workspaceCwd) {
            if (args.Cwd && typeof args.Cwd === 'string') {
              workspaceCwd = args.Cwd.trim();
            } else if (args.AbsolutePath && typeof args.AbsolutePath === 'string') {
              workspaceCwd = path.dirname(args.AbsolutePath.trim());
            } else if (args.TargetFile && typeof args.TargetFile === 'string') {
              workspaceCwd = path.dirname(args.TargetFile.trim());
            }
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
        targetTool.output = rawContent;

        const toolName = targetTool.toolName;
        const args = targetTool.args || {};

        if (targetTool.role === 'ask_question') {
          targetTool.status = 'done';
          targetTool.parsedAnswers = parseAskQuestionOutput(rawContent);
        } else if (toolName === 'run_command' && !args.IsDaemon) {
          const bgTaskId = extractBackgroundTaskId(rawContent);
          if (bgTaskId || step.status === 'RUNNING') {
            registerBackgroundTask(
              bgTaskId || `step-${stepIndex}-bg`,
              targetTool,
              stepIndex
            );
          } else {
            targetTool.status = 'done';
          }
        } else if (toolName === 'invoke_subagent') {
          targetTool.status = 'done';
          const subagentsArg = Array.isArray(args.Subagents) ? args.Subagents : [{}];
          const uuids = Array.from(
            new Set((rawContent.match(UUID_REGEX) || []).map((u) => u.toLowerCase()))
          );
          if (uuids.length > 0) {
            for (const uuid of uuids) {
              pendingSubagents.set(uuid, {
                id: uuid,
                role: subagentsArg[0]?.Role || 'Subagent',
                toolItem: targetTool,
                stepIndex
              });
            }
            targetTool.status = 'running';
            targetTool.isBackground = true;
          } else if (step.status !== 'ERROR') {
            subagentsArg.forEach((sub, sIdx) => {
              const key = `subagent-pending-${stepIndex}-${sIdx}`;
              pendingSubagents.set(key, {
                id: key,
                role: sub.Role || 'Subagent',
                toolItem: targetTool,
                stepIndex
              });
            });
            targetTool.status = 'running';
            targetTool.isBackground = true;
          }
        } else if (toolName === 'send_message') {
          targetTool.status = 'done';
          if (args.Recipient && step.status !== 'ERROR') {
            pendingSubagents.set(args.Recipient, {
              id: args.Recipient,
              role: 'Subagent',
              toolItem: targetTool,
              stepIndex
            });
            targetTool.status = 'running';
            targetTool.isBackground = true;
          }
        } else if (toolName === 'schedule' && !args.IsDaemon) {
          const timerTaskId =
            extractBackgroundTaskId(rawContent) || `timer-${stepIndex}`;
          if (step.status !== 'ERROR') {
            pendingTimers.set(timerTaskId, {
              timerKey: timerTaskId,
              condition: args.TimerCondition || 'never',
              prompt: args.Prompt || '',
              toolItem: targetTool,
              stepIndex
            });
            targetTool.status = 'running';
            targetTool.isBackground = true;
          } else {
            targetTool.status = 'done';
          }
        } else if (toolName === 'manage_task') {
          targetTool.status = 'done';
          const action = args.Action;
          const targetId = args.TaskId;
          if (
            targetId &&
            (action === 'kill' ||
              /not running|status:\s*DONE|completed|terminated|killed/i.test(rawContent))
          ) {
            resolveBackgroundTask(targetId, null);
            for (const [timerKey, timer] of pendingTimers.entries()) {
              if (taskIdsMatch(timerKey, targetId)) {
                pendingTimers.delete(timerKey);
                if (timer.toolItem) timer.toolItem.status = 'done';
              }
            }
          }
        } else if (toolName === 'manage_subagents') {
          targetTool.status = 'done';
          if (args.Action === 'kill_all') {
            for (const { toolItem } of pendingSubagents.values()) {
              if (toolItem) toolItem.status = 'done';
            }
            pendingSubagents.clear();
          } else if (args.Action === 'kill' && Array.isArray(args.ConversationIds)) {
            for (const cid of args.ConversationIds) {
              const entry = pendingSubagents.get(cid);
              pendingSubagents.delete(cid);
              if (entry && entry.toolItem) entry.toolItem.status = 'done';
            }
          }
        } else {
          targetTool.status = 'done';
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
          output: rawContent,
          status: 'done',
          createdAt
        });
      }

      // Process any inline <SYSTEM_MESSAGE> wakeups attached to this GENERIC step after tool registration
      if (sysMessages.length > 0) {
        processSystemWakeupMessages(sysMessages);
      }
    }
  }

  // Check on-disk subagent completion for any remaining pending subagents with UUIDs
  if (pendingSubagents.size > 0 && brainDirs.length > 0) {
    for (const [subId, entry] of pendingSubagents.entries()) {
      if (!subId.startsWith('subagent-pending-') && isSubagentCompleteOnDisk(subId, brainDirs)) {
        pendingSubagents.delete(subId);
        if (entry.toolItem) {
          const stillPending = Array.from(pendingSubagents.values()).some(
            (s) => s.toolItem === entry.toolItem
          );
          if (!stillPending) {
            entry.toolItem.status = 'done';
          }
        }
      }
    }
  }

  // Compute turn state relative to baselineStepCount
  const hasUnpairedToolCalls = pendingToolItems.some((t) => t.output === null);
  const activeBgTasks = Array.from(pendingBackgroundTasks.values()).filter(
    (t) => t.stepIndex >= baselineStepCount
  );
  const activeSubagents = Array.from(pendingSubagents.values()).filter(
    (s) => s.stepIndex >= baselineStepCount
  );
  const activeTimers = Array.from(pendingTimers.values()).filter(
    (tm) => tm.stepIndex >= baselineStepCount
  );

  const hasPendingBackgroundWork =
    activeBgTasks.length > 0 || activeSubagents.length > 0 || activeTimers.length > 0;

  const latestStep = rawSteps.length > 0 ? rawSteps[rawSteps.length - 1] : null;
  const isLatestStepFinalPlannerResponse = Boolean(
    latestStep &&
      latestStep.step_index >= baselineStepCount &&
      latestStep.type === 'PLANNER_RESPONSE' &&
      latestStep.status === 'DONE' &&
      (!Array.isArray(latestStep.tool_calls) || latestStep.tool_calls.length === 0)
  );

  const isTurnComplete =
    isLatestStepFinalPlannerResponse && !hasUnpairedToolCalls && !hasPendingBackgroundWork;

  // Build human-readable summary of pending background work or active tool
  const bgParts = [];
  if (activeBgTasks.length > 0) {
    bgParts.push(
      `${activeBgTasks.length} background task${activeBgTasks.length > 1 ? 's' : ''}`
    );
  }
  if (activeSubagents.length > 0) {
    bgParts.push(
      `${activeSubagents.length} subagent${activeSubagents.length > 1 ? 's' : ''}`
    );
  }
  if (activeTimers.length > 0) {
    bgParts.push(`${activeTimers.length} timer${activeTimers.length > 1 ? 's' : ''}`);
  }
  const pendingBackgroundSummary =
    bgParts.length > 0 ? `Waiting for ${bgParts.join(', ')}...` : null;

  // Determine latest active activity label for sidebar progress indicator
  let latestActivityLabel = '';
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.role === 'ask_question' && it.status === 'waiting') {
      latestActivityLabel = `Waiting for answer: ${it.summary}`;
      break;
    }
    if (it.role === 'tool_call') {
      latestActivityLabel = `${it.toolName}: ${it.summary || it.detail || ''}`.trim();
      break;
    }
    if (it.role === 'thought') {
      const firstLine = (it.content || '').split(/\r?\n/)[0].slice(0, 50);
      latestActivityLabel = `Thinking: ${firstLine}`;
      break;
    }
  }
  if (pendingBackgroundSummary) {
    latestActivityLabel = pendingBackgroundSummary;
  }

  const turnState = {
    hasUnpairedToolCalls,
    hasPendingBackgroundWork,
    pendingBackgroundCount:
      activeBgTasks.length + activeSubagents.length + activeTimers.length,
    pendingBackgroundSummary,
    isLatestStepFinalPlannerResponse,
    isTurnComplete,
    latestActivityLabel
  };

  return {
    rawSteps,
    items,
    turnState,
    workspaceCwd
  };
}

module.exports = {
  stripSystemMessages,
  parseSystemMessages,
  extractUserRequest,
  parseAskQuestionOutput,
  extractBackgroundTaskId,
  isBackgroundedCommandOutput,
  parseTranscriptLines
};
