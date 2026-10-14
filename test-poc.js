const http = require('http');
const { app } = require('./server');

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

async function main() {
  const runLiveAsk = process.argv.includes('--ask');
  const server = app.listen(0, '127.0.0.1', async () => {
    const { port } = server.address();
    console.log(`=== Express + node-pty Web UI POC Server on http://127.0.0.1:${port} ===\n`);

    try {
      // 1. Static HTML page check
      const indexRes = await httpGet(port, '/');
      console.log(`1. Static Web UI (GET /): status=${indexRes.statusCode}, bytes=${indexRes.body.length}`);

      // 2. Check session e1fad8fe (user's gh repo session with ask_question)
      const askSessionRes = await httpGet(port, '/api/sessions/e1fad8fe-826f-4914-bea8-ee27e4112d8b');
      const askSessionData = JSON.parse(askSessionRes.body);
      const askItems = (askSessionData.items || []).filter((i) => i.role === 'ask_question');
      console.log(
        `2. Historical ask_question Parser (e1fad8fe): found ${askItems.length} ask_question UI card(s):`,
        askItems.map((i) => ({ summary: i.summary, status: i.status, questions: i.questions }))
      );

      if (runLiveAsk) {
        console.log('\n3. Running Live ask_question Roundtrip Test (POST /api/chat -> POST /api/ask-question)...');
        const turn = await streamChatRequest(
          port,
          {
            prompt:
              'Call ask_question right now to ask me "Should the repository be Private or Public?" with options ["(Recommended) Private repository", "Public repository"]. Once I answer, reply with "SELECTED_VISIBILITY=" followed by my choice.'
          },
          (askData) => {
            // Wait 600ms for BubbleTea AskQuestion UI to finish rendering, then select option index 1 ("Public repository")
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
