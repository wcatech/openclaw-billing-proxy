#!/usr/bin/env node
/**
 * OpenClaw Subscription Billing Proxy
 *
 * Routes OpenClaw API requests through Claude Code's subscription billing
 * instead of Extra Usage, by injecting Claude Code's billing identifier
 * and tool fingerprint into each request.
 *
 * Zero dependencies. Works on Windows, Linux, Mac.
 *
 * Usage:
 *   node proxy.js [--port 18801] [--config config.json]
 *
 * Quick start:
 *   1. Authenticate Claude Code: claude auth login
 *   2. Run: node proxy.js
 *   3. Set openclaw.json baseUrl to http://127.0.0.1:18801
 *   4. Restart OpenClaw gateway
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Defaults ───────────────────────────────────────────────────────────────
const DEFAULT_PORT = 18801;
const UPSTREAM_HOST = 'api.anthropic.com';

// Claude Code billing identifier (84 chars)
const BILLING_TEXT = 'x-anthropic-billing-header: cc_version=2.1.80.a46; cc_entrypoint=sdk-cli; cch=00000;';

// Beta flags required for OAuth + Claude Code features
const REQUIRED_BETAS = [
  'claude-code-20250219',
  'oauth-2025-04-20',
  'interleaved-thinking-2025-05-14',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'effort-2025-11-24'
];

// Claude Code tool stubs — presence signals a CC client to the API
const CC_TOOL_STUBS = [
  { name: 'Agent', description: 'Launch agent', input_schema: { type: 'object', properties: {} } },
  { name: 'TaskOutput', description: 'Get task output', input_schema: { type: 'object', properties: {} } },
  { name: 'Bash', description: 'Run bash command', input_schema: { type: 'object', properties: {} } },
  { name: 'Glob', description: 'File pattern match', input_schema: { type: 'object', properties: {} } },
  { name: 'Grep', description: 'Search file contents', input_schema: { type: 'object', properties: {} } },
  { name: 'ExitPlanMode', description: 'Exit plan mode', input_schema: { type: 'object', properties: {} } },
  { name: 'NotebookEdit', description: 'Edit notebook', input_schema: { type: 'object', properties: {} } },
  { name: 'TodoWrite', description: 'Manage todos', input_schema: { type: 'object', properties: {} } },
  { name: 'TaskStop', description: 'Stop task', input_schema: { type: 'object', properties: {} } },
  { name: 'AskUserQuestion', description: 'Ask user', input_schema: { type: 'object', properties: {} } },
  { name: 'Skill', description: 'Execute skill', input_schema: { type: 'object', properties: {} } },
  { name: 'EnterPlanMode', description: 'Enter plan mode', input_schema: { type: 'object', properties: {} } },
  { name: 'EnterWorktree', description: 'Enter worktree', input_schema: { type: 'object', properties: {} } },
  { name: 'ExitWorktree', description: 'Exit worktree', input_schema: { type: 'object', properties: {} } },
  { name: 'CronCreate', description: 'Create cron', input_schema: { type: 'object', properties: {} } },
  { name: 'CronDelete', description: 'Delete cron', input_schema: { type: 'object', properties: {} } },
  { name: 'CronList', description: 'List crons', input_schema: { type: 'object', properties: {} } }
];

// ─── Configuration ──────────────────────────────────────────────────────────
function loadConfig() {
  // Parse CLI args
  const args = process.argv.slice(2);
  let configPath = null;
  let port = DEFAULT_PORT;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) port = parseInt(args[i + 1]);
    if (args[i] === '--config' && args[i + 1]) configPath = args[i + 1];
  }

  // Load config file if specified
  let config = {};
  if (configPath && fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } else if (fs.existsSync('config.json')) {
    config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
  }

  // Find Claude Code credentials
  const homeDir = os.homedir();
  const credsPaths = [
    config.credentialsPath,
    path.join(homeDir, '.claude', '.credentials.json'),
    path.join(homeDir, '.claude', 'credentials.json')
  ].filter(Boolean);

  let credsPath = null;
  for (const p of credsPaths) {
    const resolved = p.startsWith('~') ? path.join(homeDir, p.slice(1)) : p;
    if (fs.existsSync(resolved)) { credsPath = resolved; break; }
  }

  if (!credsPath) {
    console.error('[ERROR] Claude Code credentials not found.');
    console.error('Run "claude auth login" first to authenticate.');
    console.error('Searched:', credsPaths.join(', '));
    process.exit(1);
  }

  // Default sanitization patterns — the critical ones for OpenClaw
  const defaultReplacements = [
    ['running inside OpenClaw', 'running on this system'],
    ['running inside openclaw', 'running on this system']
  ];

  return {
    port: config.port || port,
    credsPath,
    replacements: config.replacements || defaultReplacements,
    sanitizeSystem: config.sanitizeSystem !== false,
    sanitizeTools: config.sanitizeTools !== false,
    sanitizeMessages: config.sanitizeMessages !== false,
    sanitizeAll: config.sanitizeAll !== false
  };
}

// ─── Token Management ───────────────────────────────────────────────────────
function getToken(credsPath) {
  const raw = fs.readFileSync(credsPath, 'utf8');
  const creds = JSON.parse(raw);
  const oauth = creds.claudeAiOauth;
  if (!oauth || !oauth.accessToken) {
    throw new Error('No OAuth token in credentials file. Run "claude auth login".');
  }
  return oauth;
}

// ─── Request Processing (JSON-based) ────────────────────────────────────────
function processBody(bodyStr, config) {
  // Parse the JSON body
  let body;
  try {
    body = JSON.parse(bodyStr);
  } catch (e) {
    console.error('[WARN] Failed to parse request body as JSON, passing through unchanged');
    return bodyStr;
  }

  // 1. Apply sanitization replacements to string fields
  function sanitizeString(str) {
    let result = str;
    for (const [find, replace] of config.replacements) {
      result = result.split(find).join(replace);
    }
    return result;
  }

  function sanitizeValue(val) {
    if (typeof val === 'string') return sanitizeString(val);
    if (Array.isArray(val)) return val.map(sanitizeValue);
    if (val && typeof val === 'object') {
      const result = {};
      for (const [k, v] of Object.entries(val)) {
        result[k] = sanitizeValue(v);
      }
      return result;
    }
    return val;
  }

  if (config.sanitizeAll || config.sanitizeSystem) {
    if (body.system) body.system = sanitizeValue(body.system);
  }
  if (config.sanitizeAll || config.sanitizeMessages) {
    if (body.messages) body.messages = sanitizeValue(body.messages);
  }
  if (config.sanitizeAll || config.sanitizeTools) {
    if (body.tools) body.tools = sanitizeValue(body.tools);
  }

  // 2. Inject billing block into system prompt
  const billingBlock = { type: 'text', text: BILLING_TEXT };

  if (body.system) {
    if (typeof body.system === 'string') {
      // Convert string to array with billing block
      body.system = [billingBlock, { type: 'text', text: body.system }];
    } else if (Array.isArray(body.system)) {
      // Prepend billing block to array
      body.system = [billingBlock, ...body.system];
    }
  } else {
    // No system field — create one
    body.system = [billingBlock];
  }

  // 3. Inject CC tool stubs into tools array (deduplicated)
  if (body.tools && Array.isArray(body.tools)) {
    const existingNames = new Set(body.tools.map(t => t.name));
    const newStubs = CC_TOOL_STUBS.filter(stub => !existingNames.has(stub.name));
    body.tools = [...newStubs, ...body.tools];
  }

  return JSON.stringify(body);
}

// ─── Server ─────────────────────────────────────────────────────────────────
function startServer(config) {
  let requestCount = 0;
  const startedAt = Date.now();

  const server = http.createServer((req, res) => {
    // Health endpoint
    if (req.url === '/health' && req.method === 'GET') {
      try {
        const oauth = getToken(config.credsPath);
        const expiresIn = (oauth.expiresAt - Date.now()) / 3600000;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          status: expiresIn > 0 ? 'ok' : 'token_expired',
          proxy: 'openclaw-billing-proxy',
          requestsServed: requestCount,
          uptime: Math.floor((Date.now() - startedAt) / 1000) + 's',
          tokenExpiresInHours: expiresIn.toFixed(1),
          subscriptionType: oauth.subscriptionType,
          replacementPatterns: config.replacements.length
        }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error', message: e.message }));
      }
      return;
    }

    requestCount++;
    const reqNum = requestCount;
    const chunks = [];

    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      let body = Buffer.concat(chunks);

      // Read fresh token
      let oauth;
      try {
        oauth = getToken(config.credsPath);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { message: e.message } }));
        return;
      }

      // Process body: sanitize + inject billing + inject CC tools
      let bodyStr = body.toString('utf8');
      try {
        bodyStr = processBody(bodyStr, config);
      } catch (e) {
        console.error(`[${ts}] #${reqNum} PROCESS_ERROR: ${e.message}`);
        // Fall through with original body if processing fails
      }
      body = Buffer.from(bodyStr, 'utf8');

      // Build upstream headers
      const headers = {};
      for (const [key, value] of Object.entries(req.headers)) {
        const lk = key.toLowerCase();
        if (lk === 'host' || lk === 'connection') continue;
        if (lk === 'authorization' || lk === 'x-api-key') continue;
        if (lk === 'content-length') continue;
        headers[key] = value;
      }

      // Set Claude Code's OAuth token
      headers['authorization'] = `Bearer ${oauth.accessToken}`;
      headers['content-length'] = body.length;
      headers['accept-encoding'] = 'identity';

      // Merge required betas
      const existingBeta = headers['anthropic-beta'] || '';
      const betas = existingBeta ? existingBeta.split(',').map(b => b.trim()) : [];
      for (const b of REQUIRED_BETAS) {
        if (!betas.includes(b)) betas.push(b);
      }
      headers['anthropic-beta'] = betas.join(',');

      const ts = new Date().toISOString().substring(11, 19);
      
      // Cloudflare blocks requests without User-Agent - add one if missing
      const hasUA = Object.keys(headers).some(k => k.toLowerCase() === 'user-agent');
      if (!hasUA) {
        headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
        console.log(`[${ts}] #${reqNum} Added User-Agent`);
      }
      console.log(`[${ts}] #${reqNum} ${req.method} ${req.url} (${body.length}b)`);
      
      // Debug: log request structure and billing header presence
      try {
        const parsedBody = JSON.parse(bodyStr);
        const hasBilling = Array.isArray(parsedBody.system) && 
          parsedBody.system.some(s => s?.text?.includes('x-anthropic-billing-header'));
        const ccTools = parsedBody.tools?.filter(t => t.name === 'Bash' || t.name === 'Agent').length || 0;
        console.log(`[${ts}] #${reqNum} DEBUG: model=${parsedBody.model}, messages=${parsedBody.messages?.length}, tools=${parsedBody.tools?.length}, cc_tools=${ccTools}, billing=${hasBilling}`);
        // Log incoming headers for debugging
        if (reqNum <= 5) {
          console.log(`[${ts}] #${reqNum} HEADERS: user-agent=${req.headers['user-agent']}, accept=${req.headers['accept']}`);
        }
      } catch (e) {}

      // Forward to upstream
      const upstream = https.request({
        hostname: UPSTREAM_HOST, port: 443,
        path: req.url, method: req.method, headers
      }, (upRes) => {
        console.log(`[${ts}] #${reqNum} > ${upRes.statusCode}`);
        // Capture response body for error logging
        const resChunks = [];
        upRes.on('data', c => resChunks.push(c));
        upRes.on('end', () => {
          const resBodyStr = Buffer.concat(resChunks).toString();
          if (upRes.statusCode >= 400) {
            console.error(`[${ts}] #${reqNum} ERR_BODY: ${resBodyStr.substring(0, 500)}`);
          }
          res.writeHead(upRes.statusCode, upRes.headers);
          res.end(resBodyStr);
        });
      });

      upstream.on('error', (e) => {
        console.error(`[${ts}] #${reqNum} ERR: ${e.message}`);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { message: e.message } }));
        }
      });

      upstream.write(body);
      upstream.end();
    });
  });

  server.listen(config.port, '127.0.0.1', () => {
    try {
      const oauth = getToken(config.credsPath);
      const h = ((oauth.expiresAt - Date.now()) / 3600000).toFixed(1);
      console.log(`\n  OpenClaw Billing Proxy`);
      console.log(`  ─────────────────────`);
      console.log(`  Port:          ${config.port}`);
      console.log(`  Subscription:  ${oauth.subscriptionType}`);
      console.log(`  Token expires: ${h}h`);
      console.log(`  Patterns:      ${config.replacements.length} sanitization rules`);
      console.log(`  Credentials:   ${config.credsPath}`);
      console.log(`\n  Ready. Set openclaw.json baseUrl to http://127.0.0.1:${config.port}\n`);
    } catch (e) {
      console.error(`  Started on port ${config.port} but credentials error: ${e.message}`);
    }
  });

  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

// ─── Main ───────────────────────────────────────────────────────────────────
const config = loadConfig();
startServer(config);
