const assert = require('assert');
const http = require('http');
const { app } = require('./server');
const { parseTranscriptLines } = require('./lib/turnState');
const {
  DEFAULT_PAUSE_DURATION_MS,
  shortenHomePath,
  inspectStoredTokenPayload,
  checkAgyCli,
  checkAgyAuth,
  runPrechecks
} = require('./lib/prechecks');

function httpGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    http
      .get({ hostname: '127.0.0.1', port, path: urlPath }, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk.toString('utf8')));
        res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
      })
      .on('error', reject);
  });
}

function httpPostJson(port, urlPath, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        }
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk.toString('utf8')));
        res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function streamChatRequest(port, payload, onAskQuestion) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/api/chat',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          'Content-Length': Buffer.byteLength(body)
        }
      },
      (res) => {
        let buffer = '';
        let exitResult = null;
        const events = [];

        res.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
          const parts = buffer.split('\n\n');
          buffer = parts.pop();

          for (const frame of parts) {
            const lines = frame.split('\n');
            const evtLine = lines.find((l) => l.startsWith('event: '));
            const dataLine = lines.find((l) => l.startsWith('data: '));
            if (!evtLine || !dataLine) continue;

            const event = evtLine.slice(7).trim();
            const data = JSON.parse(dataLine.slice(6));
            events.push({ event, data });

            if (event === 'session') {
              console.log(`  [SSE session] sessionId=${data.sessionId} (from ${data.source})`);
            } else if (event === 'status') {
              console.log(`  [SSE status] ${data.message}`);
            } else if (event === 'transcript') {
              console.log(`  [SSE transcript] ${data.items.length} UI items (${data.stepCount} raw steps)`);
            } else if (event === 'ask_question') {
              console.log(
                `  [SSE ask_question] step=${data.stepIndex} | questions=${JSON.stringify(data.questions)}`
              );
              if (onAskQuestion) {
                onAskQuestion(data);
              }
            } else if (event === 'ask_question_submitted') {
              console.log(`  [SSE ask_question_submitted] step=${data.stepIndex}`);
            } else if (event === 'permission_prompt') {
              console.log(`  [SSE permission_prompt] ${data.title} | ${data.target || data.question}`);
            } else if (event === 'enter_simulated') {
              console.log(`  [SSE enter_simulated] Approved ${data.id} with keySent=${JSON.stringify(data.keySent)}`);
            } else if (event === 'exit') {
              console.log(`  [SSE exit] exitCode=${data.exitCode}, autoApprovalsCount=${data.autoApprovalsCount}`);
              exitResult = data;
            }
          }
        });

        res.on('end', () => {
          resolve({ exitResult, events });
        });
      }
    );

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function runTurnStateUnitTests() {
  console.log('3. Running Turn & Background Lifecycle Unit Tests (gemini-work#49)...');

  // Step 0: User prompt
  // Step 1: PLANNER_RESPONSE calling run_command
  // Step 2: GENERIC step with RUNNING background task id
  // Step 3: Intermediate PLANNER_RESPONSE (DONE, no tool_calls) yielding while waiting for wakeup
  const intermediateLines = [
    JSON.stringify({
      step_index: 0,
      type: 'USER_INPUT',
      content: '<USER_REQUEST>Run a background build</USER_REQUEST>'
    }),
    JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      thinking: 'Starting build in background',
      tool_calls: [
        {
          name: 'run_command',
          args: {
            CommandLine: 'npm run build',
            Cwd: '/Users/jason/projects/agy-test',
            toolAction: 'Running build'
          }
        }
      ]
    }),
    JSON.stringify({
      step_index: 2,
      type: 'GENERIC',
      status: 'RUNNING',
      content:
        'Created At: 2026-10-16T12:00:00Z\nTool is running as a background task with task id: conv-123/task-1'
    }),
    JSON.stringify({
      step_index: 3,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: 'I started the build in the background and will wait for it to finish.',
      tool_calls: []
    })
  ];

  const midParsed = parseTranscriptLines(intermediateLines, { baselineStepCount: 0 });
  assert.strictEqual(midParsed.turnState.hasPendingBackgroundWork, true, 'Should detect active background task');
  assert.strictEqual(midParsed.turnState.isTurnComplete, false, 'Intermediate yield must NOT mark turn complete');
  assert.strictEqual(midParsed.workspaceCwd, '/Users/jason/projects/agy-test', 'Should extract fallback workspaceCwd');
  const bgTool = midParsed.items.find((i) => i.role === 'tool_call');
  assert.strictEqual(bgTool.status, 'running', 'Backgrounded tool call should remain in running state');
  assert.strictEqual(bgTool.isBackground, true, 'Backgrounded tool call should set isBackground=true');

  // Step 4: Reactive wakeup via USER_INPUT containing <SYSTEM_MESSAGE> (must NOT render as fake user message!)
  // Step 5: Final PLANNER_RESPONSE (DONE, no tool_calls)
  const completedLines = [
    ...intermediateLines,
    JSON.stringify({
      step_index: 4,
      type: 'USER_INPUT',
      content:
        'The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-10-16T12:00:05Z sender=conv-123/task-1 priority=MESSAGE_PRIORITY_HIGH content=Task id "conv-123/task-1" finished with result:\n\nThe command exited with code 0.\nOutput:\nBUILD_SUCCESS\n</SYSTEM_MESSAGE>'
    }),
    JSON.stringify({
      step_index: 5,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: 'The background build succeeded.',
      tool_calls: []
    })
  ];

  const finalParsed = parseTranscriptLines(completedLines, { baselineStepCount: 0 });
  assert.strictEqual(finalParsed.turnState.hasPendingBackgroundWork, false, 'Background task should resolve on wakeup');
  assert.strictEqual(finalParsed.turnState.isTurnComplete, true, 'Turn should complete after wakeup and final response');

  const userMessages = finalParsed.items.filter((i) => i.role === 'user');
  assert.strictEqual(userMessages.length, 1, '<SYSTEM_MESSAGE> wakeup must not render as a fake user message');

  const resolvedTool = finalParsed.items.find((i) => i.role === 'tool_call');
  assert.strictEqual(resolvedTool.status, 'done', 'Background tool should transition to done');
  assert.ok(
    resolvedTool.output.includes('BUILD_SUCCESS'),
    'Background tool output should append completion result from <SYSTEM_MESSAGE>'
  );

  // Subagent + TimerCondition='any' early-cancellation lifecycle test
  const subagentId = '11111111-2222-3333-4444-555555555555';
  const subagentAndTimerLines = [
    JSON.stringify({
      step_index: 0,
      type: 'USER_INPUT',
      content: '<USER_REQUEST>Spawn a researcher subagent and set a liveness timer</USER_REQUEST>'
    }),
    JSON.stringify({
      step_index: 1,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      tool_calls: [
        {
          name: 'invoke_subagent',
          args: {
            Subagents: [{ TypeName: 'research', Role: 'Code Researcher', Prompt: 'Audit files' }]
          }
        },
        {
          name: 'schedule',
          args: {
            DurationSeconds: 300,
            Prompt: 'Check subagent progress',
            TimerCondition: 'any'
          }
        }
      ]
    }),
    JSON.stringify({
      step_index: 2,
      type: 'GENERIC',
      status: 'DONE',
      content: `Spawned subagent with conversationID: ${subagentId}`
    }),
    JSON.stringify({
      step_index: 3,
      type: 'GENERIC',
      status: 'DONE',
      content: 'Tool is running as a background task with task id: conv-999/task-2'
    }),
    JSON.stringify({
      step_index: 4,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: 'Waiting for subagent...',
      tool_calls: []
    })
  ];

  const subMid = parseTranscriptLines(subagentAndTimerLines, { baselineStepCount: 0 });
  assert.strictEqual(subMid.turnState.hasPendingBackgroundWork, true, 'Subagent and timer should be pending');
  assert.strictEqual(subMid.turnState.pendingBackgroundCount, 2, 'Should count both subagent and timer');
  assert.strictEqual(subMid.turnState.isTurnComplete, false, 'Must not exit while subagent/timer pending');

  // Subagent sends wakeup message -> resolves subagent AND early-cancels TimerCondition='any'
  const subDoneLines = [
    ...subagentAndTimerLines,
    JSON.stringify({
      step_index: 5,
      type: 'SYSTEM_MESSAGE',
      content: `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-10-16T12:01:00Z sender=${subagentId} priority=NORMAL content=Audit complete: 0 issues.\n</SYSTEM_MESSAGE>`
    }),
    JSON.stringify({
      step_index: 6,
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      content: 'The researcher subagent finished with 0 issues.',
      tool_calls: []
    })
  ];

  const subFinal = parseTranscriptLines(subDoneLines, { baselineStepCount: 0 });
  assert.strictEqual(subFinal.turnState.hasPendingBackgroundWork, false, 'Subagent wakeup should resolve both subagent and any-timer');
  assert.strictEqual(subFinal.turnState.isTurnComplete, true, 'Turn should complete after subagent wakeup');

  console.log('   -> Passed all Turn & Background Lifecycle assertions!');
}

function runPrecheckUnitTests() {
  console.log('5. Running Startup Prechecks Unit Tests (agyolo#6)...');

  assert.strictEqual(DEFAULT_PAUSE_DURATION_MS, 2000, 'Default pause duration should be 2000ms (2s)');
  assert.strictEqual(
    shortenHomePath('/Users/alice/.local/bin/agy', '/Users/alice'),
    '~/.local/bin/agy',
    'Should shorten home directory prefix to ~'
  );

  // inspectStoredTokenPayload tests
  const validNested = inspectStoredTokenPayload({
    token: {
      access_token: 'ya29.test',
      refresh_token: '1//refresh',
      expiry: '2099-01-01T00:00:00Z'
    },
    project_id: 'cloud-proj-123',
    user_tier: 'g1-ultra-tier'
  });
  assert.strictEqual(validNested.valid, true);
  assert.strictEqual(validNested.projectId, 'cloud-proj-123');
  assert.strictEqual(validNested.userTier, 'g1-ultra-tier');

  const expiredNoRefresh = inspectStoredTokenPayload({
    access_token: 'ya29.expired',
    expiry: '2000-01-01T00:00:00Z'
  });
  assert.strictEqual(expiredNoRefresh.valid, false);
  assert.ok(expiredNoRefresh.reason.includes('expired'));

  const emptyPayload = inspectStoredTokenPayload({});
  assert.strictEqual(emptyPayload.valid, false);

  // checkAgyCli passing scenario
  const mockExecFs = {
    statSync(target) {
      if (target === '/Users/alice/.local/bin/agy') {
        return { isFile: () => true, mode: 0o755 };
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }
  };
  const cliPass = checkAgyCli({
    agyBin: '/Users/alice/.local/bin/agy',
    homeDir: '/Users/alice',
    env: { PATH: '/usr/bin' },
    fsModule: mockExecFs,
    execFileSyncFn: () => 'agy version 1.4.2\n'
  });
  assert.strictEqual(cliPass.ok, true);
  assert.strictEqual(cliPass.status, 'passed');
  assert.ok(cliPass.detail.includes('1.4.2'));
  assert.strictEqual(cliPass.remediation, null);

  // checkAgyCli missing scenario
  const cliMissing = checkAgyCli({
    agyBin: '/Users/alice/.local/bin/agy',
    homeDir: '/Users/alice',
    env: { PATH: '' },
    fsModule: {
      statSync() {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
    }
  });
  assert.strictEqual(cliMissing.ok, false);
  assert.strictEqual(cliMissing.status, 'failed');
  assert.ok(cliMissing.detail.includes('not found'));
  assert.ok(cliMissing.remediation.includes('Install Antigravity CLI'));

  // checkAgyCli non-executable scenario
  const cliNotExec = checkAgyCli({
    agyBin: '/Users/alice/.local/bin/agy',
    homeDir: '/Users/alice',
    env: { PATH: '' },
    fsModule: {
      statSync() {
        return { isFile: () => true, mode: 0o644 };
      }
    }
  });
  assert.strictEqual(cliNotExec.ok, false);
  assert.ok(cliNotExec.detail.includes('not executable'));
  assert.ok(cliNotExec.remediation.includes('chmod +x'));

  // checkAgyAuth via stored OAuth token file
  const tokenFilePath = '/Users/alice/.gemini/antigravity-cli/antigravity-oauth-token';
  const authPassFile = checkAgyAuth({
    homeDir: '/Users/alice',
    agyCliDir: '/Users/alice/.gemini/antigravity-cli',
    env: {},
    platform: 'linux',
    fsModule: {
      statSync(p) {
        if (p === tokenFilePath) return { isFile: () => true, size: 512 };
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
      readFileSync(p) {
        if (p === tokenFilePath) {
          return JSON.stringify({
            token: { access_token: 'ya29.valid', refresh_token: '1//ref' },
            project_id: 'demo-gcp-proj'
          });
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
    }
  });
  assert.strictEqual(authPassFile.ok, true);
  assert.strictEqual(authPassFile.status, 'passed');
  assert.strictEqual(authPassFile.meta.method, 'oauth_token_file');
  assert.ok(authPassFile.detail.includes('demo-gcp-proj'));

  // checkAgyAuth unauthenticated failure scenario
  const authFail = checkAgyAuth({
    homeDir: '/Users/alice',
    agyCliDir: '/Users/alice/.gemini/antigravity-cli',
    env: {},
    platform: 'linux',
    fsModule: {
      statSync() {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
      readFileSync() {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
    }
  });
  assert.strictEqual(authFail.ok, false);
  assert.strictEqual(authFail.status, 'failed');
  assert.ok(authFail.remediation.includes('agy login'));

  // runPrechecks with single check filter
  const filteredReport = runPrechecks({
    checkId: 'agy_cli',
    agyBin: '/Users/alice/.local/bin/agy',
    homeDir: '/Users/alice',
    env: { PATH: '' },
    fsModule: mockExecFs,
    execFileSyncFn: () => '1.4.2'
  });
  assert.strictEqual(filteredReport.ok, true);
  assert.strictEqual(filteredReport.pauseDurationMs, 2000);
  assert.strictEqual(filteredReport.checks.length, 1);
  assert.strictEqual(filteredReport.checks[0].id, 'agy_cli');

  // runPrechecks with unknown checkId should fail loudly with INVALID_PRECHECK_ID
  assert.throws(
    () => runPrechecks({ checkId: 'unknown_id' }),
    (err) => err && err.code === 'INVALID_PRECHECK_ID'
  );

  console.log('   -> Passed all Startup Prechecks unit assertions!');
}

async function runSidebarNewSessionTests(indexHtml, appJs) {
  console.log('4. Running Sidebar New Session Button & Placeholder Lifecycle Tests (agyolo#5)...');
  const vm = require('vm');

  // Verify #newSessionBtn is inside #sidebar and before #sidebarList, not inside .topbar
  const topbarMatch = indexHtml.match(/<header class="topbar">([\s\S]*?)<\/header>/);
  assert.ok(topbarMatch, 'Should have topbar header');
  assert.ok(
    !topbarMatch[1].includes('id="newSessionBtn"'),
    '#newSessionBtn should no longer be inside .topbar'
  );

  const sidebarMatch = indexHtml.match(/<aside id="sidebar"[\s\S]*?<\/aside>/);
  assert.ok(sidebarMatch, 'Should have #sidebar aside');
  const newBtnPos = sidebarMatch[0].indexOf('id="newSessionBtn"');
  const listPos = sidebarMatch[0].indexOf('id="sidebarList"');
  assert.ok(newBtnPos > -1, '#newSessionBtn should be inside #sidebar');
  assert.ok(
    newBtnPos < listPos,
    '#newSessionBtn should be placed at the top of the session list before #sidebarList'
  );

  // Create lightweight DOM harness to test app.js behavior
  function makeEl(id, initialClasses = []) {
    const classes = new Set(initialClasses);
    const attrs = new Map();
    const listeners = new Map();
    return {
      id,
      value: '',
      innerHTML: '',
      textContent: '',
      disabled: false,
      scrollTop: 0,
      scrollHeight: 100,
      className: initialClasses.join(' '),
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        toggle: (c, force) => {
          const shouldHave = force !== undefined ? Boolean(force) : !classes.has(c);
          if (shouldHave) classes.add(c);
          else classes.delete(c);
          return shouldHave;
        },
        contains: (c) => classes.has(c)
      },
      setAttribute: (k, v) => attrs.set(k, String(v)),
      getAttribute: (k) => attrs.get(k),
      addEventListener: (evt, fn) => {
        if (!listeners.has(evt)) listeners.set(evt, []);
        listeners.get(evt).push(fn);
      },
      trigger: async (evt, eventObj = {}) => {
        for (const fn of listeners.get(evt) || []) {
          await fn(eventObj);
        }
      },
      focus: () => {}
    };
  }

  const elements = {
    stream: makeEl('stream'),
    viewport: makeEl('viewport'),
    sidebar: makeEl('sidebar', ['sidebar']),
    sidebarToggleBtn: makeEl('sidebarToggleBtn'),
    sidebarList: makeEl('sidebarList', ['sidebar-list']),
    sidebarCount: makeEl('sidebarCount'),
    activeRunsBadge: makeEl('activeRunsBadge'),
    activeRunsText: makeEl('activeRunsText'),
    cwdInput: makeEl('cwdInput'),
    workspacePresets: makeEl('workspacePresets'),
    newSessionBtn: makeEl('newSessionBtn', ['session-item', 'btn-new', 'active']),
    promptInput: makeEl('promptInput'),
    sendBtn: makeEl('sendBtn'),
    statusDot: makeEl('statusDot'),
    statusText: makeEl('statusText')
  };

  let chatPosted = false;
  const mockSessions = [
    {
      id: 'existing-session-1111',
      title: 'Existing First Session',
      workspace: '/Users/jason/projects/agyolo',
      stepCount: 4,
      updatedAt: '2026-10-18T10:00:00.000Z',
      isRunning: false,
      state: 'idle'
    }
  ];

  const sandbox = {
    URL,
    URLSearchParams,
    TextDecoder,
    console,
    setTimeout: () => 1,
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
    window: {
      location: { href: 'http://localhost:3000/', search: '' },
      history: { replaceState: () => {} },
      addEventListener: () => {},
      getSelection: () => ''
    },
    document: {
      getElementById: (id) => elements[id] || makeEl(id)
    },
    fetch: async (url) => {
      if (url === '/api/workspaces') {
        return {
          ok: true,
          json: async () => ({
            defaultWorkspace: '/Users/jason/projects/agyolo',
            workspaces: ['/Users/jason/projects/agyolo']
          })
        };
      }
      if (url === '/api/sessions') {
        return {
          ok: true,
          json: async () => ({ sessions: mockSessions })
        };
      }
      if (url.startsWith('/api/sessions/existing-session-1111')) {
        return {
          ok: true,
          json: async () => ({
            sessionId: 'existing-session-1111',
            transcriptPath: '/mock/transcript.jsonl',
            workspace: '/Users/jason/projects/agyolo',
            items: [{ id: 'u1', role: 'user', content: 'Hello existing' }],
            rawSteps: [{}],
            permissions: [],
            isRunning: false
          })
        };
      }
      if (url === '/api/chat') {
        chatPosted = true;
        // Return a stream that stays open briefly so we can inspect the sidebar state right after first message is sent
        return {
          ok: true,
          body: {
            getReader: () => ({
              read: async () => ({ done: true, value: undefined })
            })
          }
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }
  };

  vm.createContext(sandbox);
  vm.runInContext(appJs, sandbox);
  // Wait for startup IIFE promises to settle
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  // Initial state: New Session button is highlighted, sidebarList only contains the 1 existing session (no extra draft item)
  assert.strictEqual(
    elements.newSessionBtn.classList.contains('active'),
    true,
    '#newSessionBtn should be highlighted on initial New Session state'
  );
  assert.strictEqual(
    elements.sidebarCount.textContent,
    '1',
    'Sidebar count should only count actual sessions, not the New Session button placeholder'
  );
  assert.ok(
    !elements.sidebarList.innerHTML.includes('New Session (Draft)'),
    '#sidebarList should not render a separate New Session (Draft) card'
  );
  assert.ok(
    !elements.sidebarList.innerHTML.includes('class="session-item active"'),
    'Existing session should not be highlighted while New Session button is active'
  );

  // Select the existing session -> existing session becomes highlighted, #newSessionBtn is un-highlighted
  await sandbox.selectSessionFromSidebar('existing-session-1111');
  assert.strictEqual(
    elements.newSessionBtn.classList.contains('active'),
    false,
    '#newSessionBtn should not be highlighted when an existing session is selected'
  );
  assert.ok(
    elements.sidebarList.innerHTML.includes('class="session-item active"') &&
      elements.sidebarList.innerHTML.includes('data-session-key="existing-session-1111"'),
    'Selected existing session should be highlighted in #sidebarList'
  );

  // Click #newSessionBtn -> #newSessionBtn becomes highlighted again as placeholder, no new session added yet
  await elements.newSessionBtn.trigger('click');
  elements.promptInput.value = 'My first message in a new session';
  await elements.promptInput.trigger('input');
  sandbox.renderSidebar();

  assert.strictEqual(
    elements.newSessionBtn.classList.contains('active'),
    true,
    'Clicking #newSessionBtn should highlight #newSessionBtn itself as a placeholder'
  );
  assert.strictEqual(
    elements.sidebarCount.textContent,
    '1',
    'No new session should be added below #newSessionBtn before the first message is sent'
  );
  assert.ok(
    !elements.sidebarList.innerHTML.includes('class="session-item active"'),
    'No session in #sidebarList should be highlighted while #newSessionBtn is active'
  );

  // Send the first message -> new session is added below #newSessionBtn (at top of #sidebarList) and becomes highlighted
  const sendPromise = sandbox.sendChat();
  // Inspect state synchronously right after sendChat updates the sidebar and before stream closes
  assert.strictEqual(
    elements.newSessionBtn.classList.contains('active'),
    false,
    '#newSessionBtn should no longer be highlighted once the first message is sent'
  );
  assert.strictEqual(
    elements.sidebarCount.textContent,
    '2',
    'New session should be added to the session list once the first message is sent'
  );

  const buttonMatches = [
    ...elements.sidebarList.innerHTML.matchAll(
      /<button[^>]*class="([^"]*)"[^>]*data-session-key="([^"]*)"/g
    )
  ];
  assert.strictEqual(buttonMatches.length, 2, 'Should render 2 sessions in #sidebarList');
  assert.ok(
    buttonMatches[0][2].startsWith('turn-'),
    'New session should be added at the very top of #sidebarList (directly below #newSessionBtn)'
  );
  assert.ok(
    buttonMatches[0][1].split(/\s+/).includes('active'),
    'Newly added session below #newSessionBtn should become highlighted (.active)'
  );
  assert.strictEqual(
    buttonMatches[1][2],
    'existing-session-1111',
    'Existing session should appear below the newly added session'
  );
  assert.ok(
    !buttonMatches[1][1].split(/\s+/).includes('active'),
    'Existing session should not be highlighted'
  );

  await sendPromise;
  assert.strictEqual(chatPosted, true, 'Should have posted chat message');

  const postTurnMatches = [
    ...elements.sidebarList.innerHTML.matchAll(
      /<button[^>]*class="([^"]*)"[^>]*data-session-key="([^"]*)"/g
    )
  ];
  assert.strictEqual(postTurnMatches.length, 2, 'Should still render 2 sessions after turn completes');
  assert.ok(
    postTurnMatches[0][1].split(/\s+/).includes('active'),
    'Newly added session should remain at the top and highlighted after turn completes'
  );
  console.log('   -> Passed all Sidebar New Session Button & Placeholder Lifecycle assertions!');
}

async function main() {
  const runLiveAsk = process.argv.includes('--ask');
  const server = app.listen(0, '127.0.0.1', async () => {
    const { port } = server.address();
    console.log(`=== Express + node-pty Web UI POC Server on http://127.0.0.1:${port} ===\n`);

    try {
      // 1. Static HTML page and modular assets check
      const indexRes = await httpGet(port, '/');
      const cssRes = await httpGet(port, '/styles.css');
      const precheckJsRes = await httpGet(port, '/precheckModal.js');
      const jsRes = await httpGet(port, '/app.js');
      assert.strictEqual(indexRes.statusCode, 200);
      assert.strictEqual(cssRes.statusCode, 200);
      assert.strictEqual(precheckJsRes.statusCode, 200);
      assert.strictEqual(jsRes.statusCode, 200);
      assert.ok(indexRes.body.includes('id="precheckModal"'), 'index.html should include startup precheck modal');

      // Verify path selector was moved out of topbar and placed above .composer-box inside .composer-wrap
      const topbarEndIdx = indexRes.body.indexOf('</header>');
      const composerWrapIdx = indexRes.body.indexOf('<footer class="composer-wrap">');
      const cwdInputIdx = indexRes.body.indexOf('id="cwdInput"');
      const browseBtnIdx = indexRes.body.indexOf('id="browsePathBtn"');
      const composerBoxIdx = indexRes.body.indexOf('<div class="composer-box">');
      assert.ok(cwdInputIdx > topbarEndIdx, 'cwdInput should not be inside topbar header');
      assert.ok(
        cwdInputIdx > composerWrapIdx && cwdInputIdx < composerBoxIdx,
        'cwdInput should be inside composer-wrap directly above composer-box'
      );
      assert.ok(
        browseBtnIdx > composerWrapIdx && browseBtnIdx < composerBoxIdx,
        'browsePathBtn should be inside composer-wrap directly above composer-box'
      );
      console.log(
        `1. Static Web UI: GET / (${indexRes.body.length}B), /styles.css (${cssRes.body.length}B), /precheckModal.js (${precheckJsRes.body.length}B), /app.js (${jsRes.body.length}B) [Path selector above composer box verified]`
      );

      // 1b. Native Directory Picker API check (selection, cancellation, and error handling)
      const prevMockPick = process.env.AGY_MOCK_PICK_DIR;
      try {
        process.env.AGY_MOCK_PICK_DIR = '/Users/jason/projects/agyolo/';
        const pickRes = await httpPostJson(port, '/api/pick-directory', {
          initialPath: '/Users/jason/projects'
        });
        assert.strictEqual(pickRes.statusCode, 200);
        const pickData = JSON.parse(pickRes.body);
        assert.strictEqual(pickData.cancelled, false);
        assert.strictEqual(pickData.path, '/Users/jason/projects/agyolo');

        process.env.AGY_MOCK_PICK_DIR = '__CANCEL__';
        const cancelRes = await httpPostJson(port, '/api/pick-directory', {});
        assert.strictEqual(cancelRes.statusCode, 200);
        const cancelData = JSON.parse(cancelRes.body);
        assert.strictEqual(cancelData.cancelled, true);
        assert.strictEqual(cancelData.path, null);

        process.env.AGY_MOCK_PICK_DIR = '__ERROR__';
        const errRes = await httpPostJson(port, '/api/pick-directory', {});
        assert.strictEqual(errRes.statusCode, 500);
        const errData = JSON.parse(errRes.body);
        assert.ok(errData.error, 'Error response should include error message');
      } finally {
        if (prevMockPick === undefined) {
          delete process.env.AGY_MOCK_PICK_DIR;
        } else {
          process.env.AGY_MOCK_PICK_DIR = prevMockPick;
        }
      }
      console.log('1b. Native Directory Picker API (POST /api/pick-directory): passed selection, cancel, and error assertions');

      // 2. Check sessions list includes live progress metadata fields
      const sessionsRes = await httpGet(port, '/api/sessions');
      assert.strictEqual(sessionsRes.statusCode, 200);
      const sessionsData = JSON.parse(sessionsRes.body);
      assert.ok(Array.isArray(sessionsData.sessions), 'sessions should be an array');
      if (sessionsData.sessions.length > 0) {
        const sample = sessionsData.sessions[0];
        assert.strictEqual(typeof sample.isRunning, 'boolean');
        assert.strictEqual(typeof sample.state, 'string');
      }
      console.log(
        `2. Multi-Session API (GET /api/sessions): returned ${sessionsData.sessions.length} sessions with live progress metadata`
      );

      // 3. Unit tests for background task / wakeup lifecycle
      runTurnStateUnitTests();

      // 4. Unit tests for sidebar New Session button & placeholder behavior (agyolo#5)
      await runSidebarNewSessionTests(indexRes.body, jsRes.body);

      // 5. Unit & HTTP API tests for startup prechecks (agyolo#6)
      runPrecheckUnitTests();

      const prechecksAllRes = await httpGet(port, '/api/prechecks');
      assert.strictEqual(prechecksAllRes.statusCode, 200);
      const prechecksAllData = JSON.parse(prechecksAllRes.body);
      assert.strictEqual(prechecksAllData.pauseDurationMs, 2000);
      assert.strictEqual(prechecksAllData.checks.length, 2);
      assert.deepStrictEqual(
        prechecksAllData.checks.map((c) => c.id),
        ['agy_cli', 'agy_auth']
      );

      const prechecksCliRes = await httpGet(port, '/api/prechecks?check=agy_cli');
      assert.strictEqual(prechecksCliRes.statusCode, 200);
      const prechecksCliData = JSON.parse(prechecksCliRes.body);
      assert.strictEqual(prechecksCliData.checks.length, 1);
      assert.strictEqual(prechecksCliData.checks[0].id, 'agy_cli');

      const prechecksAuthRes = await httpGet(port, '/api/prechecks?check=agy_auth');
      assert.strictEqual(prechecksAuthRes.statusCode, 200);
      const prechecksAuthData = JSON.parse(prechecksAuthRes.body);
      assert.strictEqual(prechecksAuthData.checks.length, 1);
      assert.strictEqual(prechecksAuthData.checks[0].id, 'agy_auth');

      const prechecksBadRes = await httpGet(port, '/api/prechecks?check=unknown_id');
      assert.strictEqual(prechecksBadRes.statusCode, 400);
      console.log(
        `6. Prechecks HTTP API (GET /api/prechecks): ok=${prechecksAllData.ok}, checks=${prechecksAllData.checks
          .map((c) => `${c.id}:${c.status}`)
          .join(', ')}, pauseDurationMs=${prechecksAllData.pauseDurationMs}ms`
      );

      if (runLiveAsk) {
        console.log('\n7. Running Live ask_question Roundtrip Test (POST /api/chat -> POST /api/ask-question)...');
        const turn = await streamChatRequest(
          port,
          {
            prompt:
              'Call ask_question right now to ask me "Should the repository be Private or Public?" with options ["(Recommended) Private repository", "Public repository"]. Once I answer, reply with "SELECTED_VISIBILITY=" followed by my choice.'
          },
          (askData) => {
            setTimeout(async () => {
              console.log('  -> Posting answer via POST /api/ask-question (selecting option index 1: Public repository)...');
              const resp = await httpPostJson(port, '/api/ask-question', {
                sessionId: askData.sessionId,
                action: 'submit',
                answers: [{ selectedIndices: [1], writeIn: '' }]
              });
              console.log(`  -> POST /api/ask-question response: ${resp.statusCode} ${resp.body}`);
            }, 600);
          }
        );

        const finalAssistant = (turn.exitResult.items || []).filter((i) => i.role === 'assistant').pop();
        console.log(`   -> Final Assistant Reply: ${finalAssistant ? finalAssistant.content : 'none'}`);
      }

      server.close(() => process.exit(0));
    } catch (err) {
      console.error('POC Test Failed:', err);
      server.close(() => process.exit(1));
    }
  });
}

main();
