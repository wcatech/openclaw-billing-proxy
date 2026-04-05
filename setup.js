#!/usr/bin/env node
/**
 * Setup script for OpenClaw Billing Proxy
 *
 * Auto-detects OpenClaw configuration and generates
 * sanitization rules for the proxy.
 *
 * Usage: node setup.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const homeDir = os.homedir();

console.log('\n  OpenClaw Billing Proxy Setup');
console.log('  ───────────────────────────\n');

// Step 1: Check Claude Code auth
console.log('1. Checking Claude Code authentication...');
const credsPaths = [
  path.join(homeDir, '.claude', '.credentials.json'),
  path.join(homeDir, '.claude', 'credentials.json')
];

let credsPath = null;
for (const p of credsPaths) {
  if (fs.existsSync(p)) { credsPath = p; break; }
}

if (!credsPath) {
  console.error('   NOT FOUND. Run "claude auth login" first.');
  console.error('   Searched:', credsPaths.join(', '));
  process.exit(1);
}

const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
if (!creds.claudeAiOauth?.accessToken) {
  console.error('   No OAuth token found. Run "claude auth login".');
  process.exit(1);
}

const expiresIn = ((creds.claudeAiOauth.expiresAt - Date.now()) / 3600000).toFixed(1);
console.log(`   OK: ${creds.claudeAiOauth.subscriptionType} subscription, token expires in ${expiresIn}h`);

// Step 2: Find OpenClaw config
console.log('\n2. Finding OpenClaw configuration...');
const oclawPaths = [
  path.join(homeDir, '.openclaw', 'openclaw.json'),
  '/etc/openclaw/openclaw.json'
];

let oclawPath = null;
for (const p of oclawPaths) {
  if (fs.existsSync(p)) { oclawPath = p; break; }
}

let platformName = 'OpenClaw';
let assistantName = null;
let replacements = [
  ['running inside OpenClaw', 'running on this system'],
  ['running inside openclaw', 'running on this system']
];

if (oclawPath) {
  console.log(`   Found: ${oclawPath}`);
  const oclawConfig = JSON.parse(fs.readFileSync(oclawPath, 'utf8'));

  // Detect current baseUrl
  const baseUrl = oclawConfig.models?.providers?.anthropic?.baseUrl || 'unknown';
  console.log(`   Current baseUrl: ${baseUrl}`);

  // Detect assistant name from workspace files
  const workspaceDir = oclawConfig.agents?.defaults?.workspace;
  if (workspaceDir) {
    // Check for common identity files
    const identityFiles = ['SOUL.md', 'USER.md', 'AGENTS.md'];
    for (const f of identityFiles) {
      const fPath = path.join(workspaceDir, f);
      if (fs.existsSync(fPath)) {
        const content = fs.readFileSync(fPath, 'utf8');
        // Try to find assistant name
        const nameMatch = content.match(/(?:name|assistant|bot).*?:\s*(\w+)/i);
        if (nameMatch && nameMatch[1].length > 2 && nameMatch[1] !== 'the') {
          assistantName = nameMatch[1];
          break;
        }
      }
    }
  }

  // Check Telegram bot name
  if (oclawConfig.channels?.telegram?.botToken) {
    console.log('   Telegram channel: configured');
  }

  // Detect agent system prompt for "running inside" pattern
  const agentDir = path.join(path.dirname(oclawPath), 'agents', 'main', 'agent');
  if (fs.existsSync(agentDir)) {
    console.log(`   Agent dir: ${agentDir}`);
  }
} else {
  console.log('   OpenClaw config not found (will use defaults)');
}

if (assistantName) {
  console.log(`   Detected assistant name: ${assistantName}`);
}

// Step 3: Generate config
console.log('\n3. Generating configuration...');

const config = {
  port: 18801,
  credentialsPath: credsPath,
  replacements,
  sanitizeAll: true,
  _comment: 'Add more [find, replace] pairs to the replacements array if needed'
};

const configPath = path.join(process.cwd(), 'config.json');
fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log(`   Written: ${configPath}`);

// Step 4: Instructions
console.log('\n4. Setup complete!\n');
console.log('   Next steps:');
console.log('   ─────────────');
console.log(`   a) Start the proxy:     node proxy.js`);
console.log(`   b) Update OpenClaw:     Set baseUrl to http://127.0.0.1:${config.port} in openclaw.json`);
console.log(`   c) Restart gateway:     Restart your OpenClaw gateway`);
console.log(`   d) Test:                Send your assistant a message\n`);

if (oclawPath) {
  console.log(`   To update baseUrl automatically:`);
  if (process.platform === 'win32') {
    console.log(`     powershell -c "(gc '${oclawPath}') -replace '\"baseUrl\":\\s*\"[^\"]*\"', '\"baseUrl\": \"http://127.0.0.1:${config.port}\"' | sc '${oclawPath}'"`);
  } else {
    console.log(`     sed -i 's|"baseUrl": "[^"]*"|"baseUrl": "http://127.0.0.1:${config.port}"|' '${oclawPath}'`);
  }
}

console.log('\n   If requests fail, add more sanitization patterns to config.json.');
console.log('   The proxy logs each request — check the console for errors.\n');
