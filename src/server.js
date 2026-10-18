const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
loadEnvFile();
const config = { host: process.env.HOST || '0.0.0.0', port: Number(process.env.PORT || 80), webhookPath: process.env.WEBHOOK_PATH || '/webhook/openwa', webhookSecret: process.env.WEBHOOK_SECRET || '', openwaUrl: process.env.OPENWA_URL || 'http://192.168.1.245:2785/', openwaApiKey: process.env.OPENWA_API_KEY || '', openwaSessionId: process.env.OPENWA_SESSION_ID || '', nvidiaKey: process.env.NVIDIA_API_KEY || '', nvidiaBaseUrl: (process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/$/, ''), model: process.env.NVIDIA_MODEL || 'nvidia/nemotron-3.5-super-vl-120b-a12b', temperature: Number(process.env.NVIDIA_TEMPERATURE || 0.2), maxTokens: Number(process.env.NVIDIA_MAX_TOKENS || 500), logDir: process.env.LOG_DIR || './logs' };
const promptRules = fs.readFileSync(path.join(__dirname, '..', 'MODEL_REPLY_RULES.md'), 'utf8');
const logDir = path.resolve(config.logDir); fs.mkdirSync(logDir, { recursive: true });
function loadEnvFile() { const file = path.resolve('.env'); if (!fs.existsSync(file)) return; for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) { const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, ''); } }
function log(level, event, data = {}) { const record = { timestamp: new Date().toISOString(), level, event, ...data }; const line = JSON.stringify(record) + '\n'; process.stdout.write(line); fs.appendFileSync(path.join(logDir, 'app.log'), line); }
function get(obj, ...keys) { for (const key of keys) if (obj && obj[key] !== undefined && obj[key] !== null) return obj[key]; }
function extractEvent(payload) { const message = payload?.message || payload?.data || payload?.body || payload; const chatId = get(message, 'chatId', 'chat_id', 'from', 'author', 'sender', 'to') || get(message?.chat, 'id', 'chatId', 'formattedName'); const text = get(message, 'body', 'text', 'message', 'content', 'caption') || get(message?.content, 'text', 'body') || ''; return { chatId: typeof chatId === 'object' ? get(chatId, 'id', '_serialized') : chatId, messageId: get(message, 'id', 'messageId', 'msgId', 'uid'), text: typeof text === 'string' ? text : JSON.stringify(text), type: get(message, 'type', 'messageType'), timestamp: get(message, 'timestamp', 't', 'time'), sender: get(message, 'sender', 'author', 'from'), raw: payload }; }
async function sendReply(event, reply) {
  const sessionId = event.raw?.sessionId || config.openwaSessionId;
  if (!config.openwaApiKey || !sessionId) {
    log('warn', 'reply_not_sent', { reason: !config.openwaApiKey ? 'OPENWA_API_KEY_not_configured' : 'OPENWA_SESSION_ID_not_available', chatId: event.chatId });
    return null;
  }
  const response = await fetch(`${config.openwaUrl.replace(/\/$/, '')}/api/sessions/${encodeURIComponent(sessionId)}/messages/send-text`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-API-Key': config.openwaApiKey },
    body: JSON.stringify({ chatId: event.chatId, text: reply })
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`OpenWA send API ${response.status}: ${body}`);
  log('info', 'reply_sent', { chatId: event.chatId, sessionId, response: body });
  return body;
}
async function analyze(event) { if (!config.nvidiaKey || config.nvidiaKey === 'PASTE_YOUR_NVIDIA_API_KEY_HERE') throw new Error('NVIDIA_API_KEY is not configured'); const response = await fetch(`${config.nvidiaBaseUrl}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${config.nvidiaKey}` }, body: JSON.stringify({ model: config.model, temperature: config.temperature, max_tokens: config.maxTokens, messages: [{ role: 'system', content: promptRules }, { role: 'user', content: JSON.stringify({ chatId: event.chatId, messageId: event.messageId, text: event.text, type: event.type, timestamp: event.timestamp, sender: event.sender }) }] }) }); const body = await response.json(); if (!response.ok) throw new Error(`NVIDIA API ${response.status}: ${JSON.stringify(body)}`); return body.choices?.[0]?.message?.content?.trim() || ''; }
function readBody(req) { return new Promise((resolve, reject) => { let body = ''; req.on('data', chunk => { body += chunk; if (body.length > 2000000) req.destroy(new Error('Payload too large')); }); req.on('end', () => resolve(body)); req.on('error', reject); }); }
const server = http.createServer(async (req, res) => { const requestId = crypto.randomUUID(); if (req.method === 'GET' && req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, openwaUrl: config.openwaUrl, model: config.model })); } if (req.method !== 'POST' || req.url.split('?')[0] !== config.webhookPath) { res.writeHead(404); return res.end('Not found'); } if (config.webhookSecret && req.headers['x-webhook-secret'] !== config.webhookSecret) { log('warn', 'webhook_rejected', { requestId, reason: 'invalid_secret' }); res.writeHead(401); return res.end('Unauthorized'); } try { const raw = await readBody(req); const payload = JSON.parse(raw || '{}'); const event = extractEvent(payload); log('info', 'webhook_received', { requestId, chatId: event.chatId, messageId: event.messageId, type: event.type, text: event.text, payload }); const reply = await analyze(event); log('info', 'model_completed', { requestId, chatId: event.chatId, model: config.model, reply }); await sendReply(event, reply); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, requestId, chatId: event.chatId, reply })); } catch (error) { log('error', 'webhook_failed', { requestId, error: error.message, stack: error.stack }); res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, requestId, error: error.message })); } });
server.listen(config.port, config.host, () => log('info', 'server_started', { host: config.host, port: config.port, webhookPath: config.webhookPath, openwaUrl: config.openwaUrl })); server.on('error', error => log('error', 'server_error', { error: error.message }));


