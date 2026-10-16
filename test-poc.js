const assert = require('assert');
const http = require('http');
const { app } = require('./server');
const { parseTranscriptLines } = require('./lib/turnState');

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

async function main() {
  const runLiveAsk = process.argv.includes('--ask');
  const server = app.listen(0, '127.0.0.1', async () => {
    const { port } = server.address();
    console.log(`=== Express + node-pty Web UI POC Server on http://127.0.0.1:${port} ===\n`);

    try {
      // 1. Static HTML page and modular assets check
      const indexRes = await httpGet(port, '/');
      const cssRes = await httpGet(port, '/styles.css');
      const jsRes = await httpGet(port, '/app.js');
      assert.strictEqual(indexRes.statusCode, 200);
      assert.strictEqual(cssRes.statusCode, 200);
      assert.strictEqual(jsRes.statusCode, 200);
      console.log(
        `1. Static Web UI: GET / (${indexRes.body.length}B), /styles.css (${cssRes.body.length}B), /app.js (${jsRes.body.length}B)`
      );

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

      if (runLiveAsk) {
        console.log('\n4. Running Live ask_question Roundtrip Test (POST /api/chat -> POST /api/ask-question)...');
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
