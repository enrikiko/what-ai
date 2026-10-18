const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

loadEnvFile();

const config = {
  host: process.env.HOST || '0.0.0.0',
  port: Number(process.env.PORT || 80),
  webhookPath: process.env.WEBHOOK_PATH || '/webhook/openwa/v2',
  webhookSecret: process.env.WEBHOOK_SECRET || '',
  openwaUrl: process.env.OPENWA_URL || 'http://192.168.1.245:2785/',
  openwaApiKey: process.env.OPENWA_API_KEY || '',
  openwaSessionId: process.env.OPENWA_SESSION_ID || '',
  nvidiaKey: process.env.NVIDIA_API_KEY || '',
  nvidiaBaseUrl: (process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/$/, ''),
  model: process.env.NVIDIA_MODEL || 'nvidia/nemotron-3.5-super-vl-120b-a12b',
  temperature: Number(process.env.NVIDIA_TEMPERATURE || 0.2),
  maxTokens: Number(process.env.NVIDIA_MAX_TOKENS || 500),
  delayMinMs: Number(process.env.MESSAGE_DELAY_MIN_MS || 30000),
  delayMaxMs: Number(process.env.MESSAGE_DELAY_MAX_MS || 1800000),
  contextDir: process.env.CONTEXT_DIR || './contexts',
  contextMaxMessages: Number(process.env.CONTEXT_MAX_MESSAGES || 20),
  nvidiaRetryDelayMs: Number(process.env.NVIDIA_RETRY_DELAY_MS || 60000),
  logDir: process.env.LOG_DIR || './logs'
};

const promptRules = fs.readFileSync(
  path.join(__dirname, '..', 'MODEL_REPLY_RULES.md'),
  'utf8'
);
const logDir = path.resolve(config.logDir);
const contextDir = path.resolve(config.contextDir);
fs.mkdirSync(logDir, { recursive: true });
fs.mkdirSync(contextDir, { recursive: true });

function loadEnvFile() {
  const envFile = path.resolve('.env');
  if (!fs.existsSync(envFile)) return;

  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}

function log(level, event, data = {}) {
  const record = {
    timestamp: new Date().toISOString(),
    level,
    event,
    ...data
  };
  const line = `${JSON.stringify(record)}\n`;

  process.stdout.write(line);
  fs.appendFileSync(path.join(logDir, 'app.log'), line);
}

function firstDefined(object, ...keys) {
  for (const key of keys) {
    if (object?.[key] !== undefined && object[key] !== null) {
      return object[key];
    }
  }
  return undefined;
}

// -----------------------------
// Conversation context storage
// -----------------------------

function contextFile(chatId) {
  const filename = crypto
    .createHash('sha256')
    .update(String(chatId || 'unknown'))
    .digest('hex');

  return path.join(contextDir, `${filename}.json`);
}

function loadContext(chatId) {
  try {
    return JSON.parse(fs.readFileSync(contextFile(chatId), 'utf8'));
  } catch {
    return { chatId, messages: [] };
  }
}

function saveContext(chatId, context) {
  context.messages = context.messages.slice(-config.contextMaxMessages);

  const file = contextFile(chatId);
  const temporaryFile = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(context, null, 2));
  fs.renameSync(temporaryFile, file);
}

// -----------------------------
// OpenWA event parsing
// -----------------------------

function extractEvent(payload) {
  const message = payload?.message || payload?.data || payload?.body || payload;
  const chatId = firstDefined(
    message,
    'chatId',
    'chat_id',
    'from',
    'author',
    'sender',
    'to'
  ) || firstDefined(message?.chat, 'id', 'chatId', 'formattedName');

  const text = firstDefined(
    message,
    'body',
    'text',
    'message',
    'content',
    'caption'
  ) || firstDefined(message?.content, 'text', 'body') || '';

  return {
    chatId: typeof chatId === 'object' ? firstDefined(chatId, 'id', '_serialized') : chatId,
    messageId: firstDefined(message, 'id', 'messageId', 'msgId', 'uid'),
    text: typeof text === 'string' ? text : JSON.stringify(text),
    type: firstDefined(message, 'type', 'messageType'),
    timestamp: firstDefined(message, 'timestamp', 't', 'time'),
    sender: firstDefined(message, 'sender', 'author', 'from'),
    raw: payload
  };
}

// -----------------------------
// NVIDIA model integration
// -----------------------------

async function callNvidia(messages, options = {}) {
  if (!config.nvidiaKey || config.nvidiaKey === 'PASTE_YOUR_NVIDIA_API_KEY_HERE') {
    throw new Error('NVIDIA_API_KEY is not configured');
  }

  const response = await fetch(`${config.nvidiaBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.nvidiaKey}`
    },
    body: JSON.stringify({
      model: config.model,
      temperature: options.temperature ?? config.temperature,
      max_tokens: options.maxTokens ?? config.maxTokens,
      messages
    })
  });

  const body = await response.json();
  if (!response.ok) {
    throw new Error(`NVIDIA API ${response.status}: ${JSON.stringify(body)}`);
  }

  return body.choices?.[0]?.message?.content?.trim() || '';
}

async function summarizeContext(context) {
  return callNvidia([
    {
      role: 'system',
      content: 'Summarize this WhatsApp conversation for future continuity. Preserve names, preferences, facts, decisions, unresolved questions, and relevant context. Be concise. Return only the summary.'
    },
    {
      role: 'user',
      content: JSON.stringify(context.messages)
    }
  ], { temperature: 0.1, maxTokens: 700 });
}

async function analyzeMessage(event, context) {
  return callNvidia([
    { role: 'system', content: promptRules },
    ...context.messages,
    {
      role: 'user',
      content: JSON.stringify({
        chatId: event.chatId,
        messageId: event.messageId,
        text: event.text,
        type: event.type,
        timestamp: event.timestamp,
        sender: event.sender
      })
    }
  ]);
}

// -----------------------------
// OpenWA response delivery
// -----------------------------

async function sendReply(event, reply) {
  const sessionId = event.raw?.sessionId || config.openwaSessionId;

  if (!config.openwaApiKey || !sessionId) {
    log('warn', 'reply_not_sent', {
      reason: !config.openwaApiKey
        ? 'OPENWA_API_KEY_not_configured'
        : 'OPENWA_SESSION_ID_not_available',
      chatId: event.chatId
    });
    return null;
  }

  const response = await fetch(
    `${config.openwaUrl.replace(/\/$/, '')}/api/sessions/${encodeURIComponent(sessionId)}/messages/send-text`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-API-Key': config.openwaApiKey
      },
      body: JSON.stringify({ chatId: event.chatId, text: reply })
    }
  );

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`OpenWA send API ${response.status}: ${body}`);
  }

  log('info', 'reply_sent', {
    chatId: event.chatId,
    sessionId,
    response: body
  });
  return body;
}

// -----------------------------
// Delayed message processing
// -----------------------------

function randomDelayMs() {
  const minimum = Math.max(0, config.delayMinMs);
  const maximum = Math.max(minimum, config.delayMaxMs);
  return Math.floor(minimum + Math.random() * (maximum - minimum + 1));
}

async function processEvent(event, requestId) {
  let lastError;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      if (attempt === 2) {
        log('info', 'nvidia_retry_started', {
          requestId,
          chatId: event.chatId
        });
      }

      const context = loadContext(event.chatId);

      if (context.messages.length >= config.contextMaxMessages) {
        const summary = await summarizeContext(context);
        if (!summary) {
          throw new Error('NVIDIA returned an empty conversation summary');
        }

        context.messages = [
          { role: 'system', content: `Conversation summary: ${summary}` }
        ];
        saveContext(event.chatId, context);
        log('info', 'conversation_context_compacted', {
          requestId,
          chatId: event.chatId,
          summaryLength: summary.length
        });
      }

      const reply = await analyzeMessage(event, context);
      context.messages.push({ role: 'user', content: event.text });
      context.messages.push({ role: 'assistant', content: reply });
      saveContext(event.chatId, context);

      log('info', 'conversation_context_saved', {
        requestId,
        chatId: event.chatId,
        messageCount: context.messages.length
      });
      log('info', 'model_completed', {
        requestId,
        chatId: event.chatId,
        model: config.model,
        reply,
        attempt
      });

      await sendReply(event, reply);
      return;
    } catch (error) {
      lastError = error;

      if (attempt === 1) {
        log('warn', 'nvidia_call_failed_retry_scheduled', {
          requestId,
          chatId: event.chatId,
          retryInMs: config.nvidiaRetryDelayMs,
          error: error.message
        });
        await new Promise(resolve => setTimeout(resolve, config.nvidiaRetryDelayMs));
      }
    }
  }

  log('error', 'delayed_processing_failed', {
    requestId,
    chatId: event.chatId,
    error: lastError.message,
    stack: lastError.stack
  });
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';

    request.on('data', chunk => {
      body += chunk;
      if (body.length > 2_000_000) {
        request.destroy(new Error('Payload too large'));
      }
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

// -----------------------------
// HTTP server
// -----------------------------

const server = http.createServer(async (request, response) => {
  const requestId = crypto.randomUUID();
  const requestPath = request.url.split('?')[0];

  if (request.method === 'GET' && requestPath === '/logs') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return response.end(renderLogsPage());
  }

  if (request.method === 'GET' && requestPath === '/api/logs') {
    const query = new URL(request.url, `http://${request.headers.host || 'localhost'}`).searchParams;
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return response.end(JSON.stringify(readRecentLogs(query.get('limit'))));
  }
  if (request.method === 'GET' && requestPath === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    return response.end(JSON.stringify({
      ok: true,
      openwaUrl: config.openwaUrl,
      model: config.model,
      webhookPath: config.webhookPath
    }));
  }

  if (request.method !== 'POST' || requestPath !== config.webhookPath) {
    response.writeHead(404);
    return response.end('Not found');
  }

  if (
    config.webhookSecret &&
    request.headers['x-webhook-secret'] !== config.webhookSecret
  ) {
    log('warn', 'webhook_rejected', {
      requestId,
      reason: 'invalid_secret'
    });
    response.writeHead(401);
    return response.end('Unauthorized');
  }

  try {
    const payload = JSON.parse(await readBody(request) || '{}');
    const event = extractEvent(payload);
    const delayMs = randomDelayMs();

    log('info', 'webhook_received', {
      requestId,
      chatId: event.chatId,
      messageId: event.messageId,
      type: event.type,
      text: event.text,
      payload
    });
    log('info', 'message_processing_scheduled', {
      requestId,
      chatId: event.chatId,
      delayMs,
      delaySeconds: Math.round(delayMs / 1000),
      processAt: new Date(Date.now() + delayMs).toISOString()
    });

    setTimeout(() => processEvent(event, requestId), delayMs);

    response.writeHead(202, { 'content-type': 'application/json' });
    return response.end(JSON.stringify({
      ok: true,
      accepted: true,
      requestId,
      chatId: event.chatId,
      delayMs
    }));
  } catch (error) {
    log('error', 'webhook_failed', {
      requestId,
      error: error.message,
      stack: error.stack
    });
    response.writeHead(500, { 'content-type': 'application/json' });
    return response.end(JSON.stringify({
      ok: false,
      requestId,
      error: error.message
    }));
  }
});

server.listen(config.port, config.host, () => {
  log('info', 'server_started', {
    host: config.host,
    port: config.port,
    webhookPath: config.webhookPath,
    openwaUrl: config.openwaUrl
  });
});

server.on('error', error => {
  log('error', 'server_error', { error: error.message });
});

