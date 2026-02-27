'use strict';

const WebSocket = require('ws');
const chalk     = require('chalk');
const os        = require('os');
const args      = require('minimist')(process.argv.slice(2));

// ── Config ────────────────────────────────────────────────────────────────────
const RELAY_URL = args.relay || args.r || process.env.RTERM_RELAY || 'ws://localhost:4242';
const ROOM_ID   = args.room  || args.id || process.env.RTERM_ROOM;
const PASSWORD  = args.pass  || args.pw || process.env.RTERM_PASS;

if (!ROOM_ID || !PASSWORD) {
  console.error(chalk.red('\n  [rterm-client] ERROR: --room and --pass are required\n'));
  console.error('  Example:');
  console.error(chalk.cyan('    rterm-client --relay ws://yourserver.com --room myroom --pass s3cr3tPass\n'));
  process.exit(1);
}

// ── State ─────────────────────────────────────────────────────────────────────
let joined   = false;
let rawMode  = false;
const isWin  = os.platform() === 'win32';

// ── Windows: enable ANSI/VT processing ───────────────────────────────────────
if (isWin) {
  try {
    // Enable VT100 sequences on Windows 10+ console
    process.stdout._handle?.setBlocking?.(true);
    // Try to enable ENABLE_VIRTUAL_TERMINAL_PROCESSING via undocumented binding
    const { execSync } = require('child_process');
    execSync(''); // warm up
  } catch {}
}

// ── Raw mode helpers ──────────────────────────────────────────────────────────
function enterRawMode() {
  if (rawMode || !process.stdin.isTTY) return;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  rawMode = true;
}

function exitRawMode() {
  if (!rawMode || !process.stdin.isTTY) return;
  try { process.stdin.setRawMode(false); } catch {}
  rawMode = false;
}

// ── Connect ───────────────────────────────────────────────────────────────────
console.log(chalk.gray(`\n  [rterm-client] Connecting to ${RELAY_URL} ...`));
const ws = new WebSocket(RELAY_URL);

ws.on('open', () => {
  console.log(chalk.gray('  [rterm-client] Connected. Joining room...'));
  ws.send(JSON.stringify({
    type:     'client_join',
    roomId:   ROOM_ID,
    password: PASSWORD,
    cols:     process.stdout.columns || 80,
    rows:     process.stdout.rows    || 24,
  }));
});

ws.on('message', (raw) => {
  let msg;
  try { msg = JSON.parse(raw); } catch {
    process.stdout.write(String(raw));
    return;
  }

  switch (msg.type) {

    // ── Successfully joined ────────────────────────────────────────────────
    case 'joined': {
      joined = true;
      const hi = msg.hostInfo || {};
      console.log(chalk.green(`\n  [rterm-client] ✓ Connected to room "${ROOM_ID}"`));
      if (hi.hostname) {
        console.log(chalk.gray(
          `  [rterm-client] Host: ${hi.user}@${hi.hostname} | ${hi.platform} ${hi.arch}`
        ));
      }
      console.log(chalk.gray('  [rterm-client] Press Ctrl+C twice quickly to disconnect.\n'));

      // ── Raw mode — pipe stdin → relay ────────────────────────────────────
      enterRawMode();

      let ctrlCCount = 0;
      let ctrlCTimer = null;

      process.stdin.on('data', (data) => {
        if (data === '\u0003') {                      // Ctrl+C
          ctrlCCount++;
          if (ctrlCCount === 1) {
            ctrlCTimer = setTimeout(() => { ctrlCCount = 0; }, 1000);
          }
          if (ctrlCCount >= 2) {
            clearTimeout(ctrlCTimer);
            console.log(chalk.yellow('\n\n  [rterm-client] Disconnecting...\n'));
            ws.close();
            return;
          }
        } else {
          ctrlCCount = 0;
          clearTimeout(ctrlCTimer);
        }

        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'input', data }));
        }
      });

      // ── Resize events ─────────────────────────────────────────────────────
      process.stdout.on('resize', () => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'resize',
            cols: process.stdout.columns || 80,
            rows: process.stdout.rows    || 24,
          }));
        }
      });

      break;
    }

    // ── Terminal output from host ──────────────────────────────────────────
    case 'output':
      process.stdout.write(msg.data);
      break;

    // ── Auth failures / errors ─────────────────────────────────────────────
    case 'auth_fail':
      console.error(chalk.red(`\n  [rterm-client] Authentication failed: ${msg.message}\n`));
      ws.close();
      process.exit(1);
      break;

    case 'error':
      console.error(chalk.red(`\n  [rterm-client] Relay error: ${msg.message}\n`));
      break;

    // ── Host / shell closed ────────────────────────────────────────────────
    case 'shell_exit':
      console.log(chalk.yellow(`\n\n  [rterm-client] Shell exited (code ${msg.code}).\n`));
      ws.close();
      break;

    case 'host_disconnected':
      console.log(chalk.yellow(`\n\n  [rterm-client] Host closed the room: ${msg.message}\n`));
      ws.close();
      break;

    case 'notice':
      console.log(chalk.cyan(`\n  [rterm-client] Notice: ${msg.message}\n`));
      break;

    default:
      break;
  }
});

ws.on('close', () => {
  exitRawMode();
  if (joined) console.log(chalk.gray('\n  [rterm-client] Connection closed.\n'));
  process.exit(0);
});

ws.on('error', (err) => {
  exitRawMode();
  console.error(chalk.red(`\n  [rterm-client] Error: ${err.message}`));
  if (err.code === 'ECONNREFUSED') {
    console.error(chalk.red(`  Cannot reach relay at ${RELAY_URL}\n`));
  }
  process.exit(1);
});

// ── Graceful exit ─────────────────────────────────────────────────────────────
process.on('SIGINT', () => {
  exitRawMode();
  ws.close();
  process.exit(0);
});
