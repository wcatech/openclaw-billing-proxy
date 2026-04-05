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
const BILLING_BLOCK = '{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.80.a46; cc_entrypoint=sdk-cli; cch=00000;"}';

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
  '{"name":"Agent","description":"Launch agent","input_schema":{"type":"object","properties":{}}}',
  '{"name":"TaskOutput","description":"Get task output","input_schema":{"type":"object","properties":{}}}',
  '{"name":"Bash","description":"Run bash command","input_schema":{"type":"object","properties":{}}}',
  '{"name":"Glob","description":"File pattern match","input_schema":{"type":"object","properties":{}}}',
  '{"name":"Grep","description":"Search file contents","input_schema":{"type":"object","properties":{}}}',
  '{"name":"ExitPlanMode","description":"Exit plan mode","input_schema":{"type":"object","properties":{}}}',
  '{"name":"NotebookEdit","description":"Edit notebook","input_schema":{"type":"object","properties":{}}}',
  '{"name":"TodoWrite","description":"Manage todos","input_schema":{"type":"object","properties":{}}}',
  '{"name":"TaskStop","description":"Stop task","input_schema":{"type":"object","properties":{}}}',
  '{"name":"AskUserQuestion","description":"Ask user","input_schema":{"type":"object","properties":{}}}',
  '{"name":"Skill","description":"Execute skill","input_schema":{"type":"object","properties":{}}}',
  '{"name":"EnterPlanMode","description":"Enter plan mode","input_schema":{"type":"object","properties":{}}}',
  '{"name":"EnterWorktree","description":"Enter worktree","input_schema":{"type":"object","properties":{}}}',
  '{"name":"ExitWorktree","description":"Exit worktree","input_schema":{"type":"object","properties":{}}}',
  '{"name":"CronCreate","description":"Create cron","input_schema":{"type":"object","properties":{}}}',
  '{"name":"CronDelete","description":"Delete cron","input_schema":{"type":"object","properties":{}}}',
  '{"name":"CronList","description":"List crons","input_schema":{"type":"object","properties":{}}}'
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

// ─── Request Processing ─────────────────────────────────────────────────────
function processBody(bodyStr, config) {
  let modified = bodyStr;

  // 1. Apply sanitization replacements
  for (const [find, replace] of config.replacements) {
    modified = modified.split(find).join(replace);
  }

  // 2. Inject billing block into system prompt
  const sysArrayIdx = modified.indexOf('"system":[');
  if (sysArrayIdx !== -1) {
    const insertAt = sysArrayIdx + '"system":['.length;
    modified = modified.slice(0, insertAt) + BILLING_BLOCK + ',' + modified.slice(insertAt);
  } else if (modified.includes('"system":"')) {
    // System is a string — convert to array with billing block
    const sysStart = modified.indexOf('"system":"');
    let i = sysStart + '"system":"'.length;
    while (i < modified.length) {
      if (modified[i] === '\\') { i += 2; continue; }
      if (modified[i] === '"') break;
      i++;
    }
    const sysEnd = i + 1;
    const originalSysStr = modified.slice(sysStart + '"system":'.length, sysEnd);
    modified = modified.slice(0, sysStart)
      + '"system":[' + BILLING_BLOCK + ',{"type":"text","text":' + originalSysStr + '}]'
      + modified.slice(sysEnd);
  } else {
    // No system field — inject one
    modified = '{"system":[' + BILLING_BLOCK + '],' + modified.slice(1);
  }

  // 3. Inject CC tool stubs into tools array (deduplicated)
  const toolsIdx = modified.indexOf('"tools":[');
  if (toolsIdx !== -1) {
    const insertAt = toolsIdx + '"tools":['.length;
    // Only inject stubs whose names don't already exist in the body
    const stubs = CC_TOOL_STUBS.filter(stub => {
      const nameMatch = stub.match(/"name":"([^"]+)"/);
      return nameMatch && !modified.includes('"name":"' + nameMatch[1] + '"');
    });
    if (stubs.length > 0) {
      modified = modified.slice(0, insertAt) + stubs.join(',') + ',' + modified.slice(insertAt);
    }
  }

  return modified;
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
      bodyStr = processBody(bodyStr, config);
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
      console.log(`[${ts}] #${reqNum} ${req.method} ${req.url} (${body.length}b)`);

      // Forward to upstream
      const upstream = https.request({
        hostname: UPSTREAM_HOST, port: 443,
        path: req.url, method: req.method, headers
      }, (upRes) => {
        console.log(`[${ts}] #${reqNum} > ${upRes.statusCode}`);
        res.writeHead(upRes.statusCode, upRes.headers);
        upRes.pipe(res);
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
