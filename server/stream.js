// WebSocket handlers: pod logs (live + previous), interactive pod shell, kubectl console.
import { PassThrough, Writable } from 'node:stream';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as k8s from '@kubernetes/client-node';
import { audit, canExec, canWrite } from './audit.js';
import { demoLogLine, demoShell } from '../public/js/shared/mock.js';
import { fakeKubectl } from '../public/js/shared/kubectl-demo.js';

const send = (ws, d) => { if (ws.readyState === 1) ws.send(d); };

// ------------------------------------------------------------------ logs
export async function handleLogs(ws, { cfg, kcFor, user, q }) {
  const { cluster, ns, pod, container } = q;
  const follow = q.follow === '1';
  const previous = q.previous === '1';
  const tailLines = Math.min(Number(q.tail || 500), 10000);
  audit({ event: 'logs', user, cluster, ns, pod, container, follow, previous });

  if (cfg.demo) {
    const lines = [];
    for (let i = 0; i < Math.min(tailLines, 200); i++) { const l = demoLogLine(pod, container, i, previous); if (l) lines.push(l); }
    send(ws, lines.join('\n') + '\n');
    if (!follow || previous) return;
    let i = 200;
    const t = setInterval(() => send(ws, demoLogLine(pod, container, i++).replace(/^\S+/, new Date().toISOString()) + '\n'), 900);
    ws.on('close', () => clearInterval(t));
    return;
  }

  const kc = await kcFor(cluster);
  const out = new Writable({ write(chunk, _e, cb) { send(ws, chunk.toString()); cb(); } });
  const ac = await new k8s.Log(kc).log(ns, pod, container, out, { follow, previous, tailLines, timestamps: q.timestamps !== '0' });
  ws.on('close', () => ac.abort());
  out.on('finish', () => ws.close(1000));
}

// ------------------------------------------------------------------ exec
const SHELL = ['/bin/sh', '-c', 'TERM=xterm-256color; export TERM; if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi'];

export async function handleExec(ws, { cfg, kcFor, user, q }) {
  const { cluster, ns, pod, container } = q;
  if (!canExec(cfg, user)) { send(ws, '\r\n\x1b[31mPod shell is disabled for your user (READ_ONLY or EXEC_ALLOWED_USERS).\x1b[0m\r\n'); return ws.close(1008); }
  audit({ event: 'exec.open', user, cluster, ns, pod, container });
  const started = Date.now();
  ws.on('close', () => audit({ event: 'exec.close', user, cluster, ns, pod, container, seconds: Math.round((Date.now() - started) / 1000) }));

  if (cfg.demo) return demoExec(ws, pod, container, user, { cluster, ns });

  const kc = await kcFor(cluster);
  const stdout = new PassThrough(); stdout.rows = 30; stdout.columns = 120; // resizable => client-node sends TTY size
  const stdin = new PassThrough();
  stdout.on('data', (d) => send(ws, d));
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type === 'stdin') stdin.write(m.data);
    if (m.type === 'resize' && m.cols && m.rows) { stdout.columns = m.cols; stdout.rows = m.rows; stdout.emit('resize'); }
  });
  const conn = await new k8s.Exec(kc).exec(ns, pod, container, SHELL, stdout, stdout, stdin, true, (status) => {
    if (status?.status === 'Failure') send(ws, `\r\n\x1b[31m${status.message}\x1b[0m\r\n`);
    ws.close(1000);
  });
  ws.on('close', () => { try { conn.close(); } catch {} });
}

function demoExec(ws, pod, container, user, { cluster, ns }) {
  const prompt = `\x1b[32m${container}@${pod.slice(0, 28)}\x1b[0m:\x1b[34m/app\x1b[0m$ `;
  send(ws, `\x1b[90m[demo] connected to ${ns}/${pod} (${container}) - this is a simulated shell. Type "help".\x1b[0m\r\n` + prompt);
  let buf = '';
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type !== 'stdin') return;
    for (const ch of m.data) {
      if (ch === '\r') {
        audit({ event: 'exec.cmd', user, cluster, ns, pod, cmd: buf });
        const out = demoShell(pod, container, buf);
        buf = '';
        if (out === null) { send(ws, '\r\nexit\r\n'); return ws.close(1000); }
        send(ws, '\r\n' + (out ? out.replace(/\n/g, '\r\n') + '\r\n' : '') + prompt);
      } else if (ch === '\x7f') { if (buf) { buf = buf.slice(0, -1); send(ws, '\b \b'); } }
      else if (ch === '\x03') { buf = ''; send(ws, '^C\r\n' + prompt); }
      else if (ch >= ' ') { buf += ch; send(ws, ch); }
    }
  });
}

// ------------------------------------------------------------------ kubectl console
const READ_VERBS = new Set(['get', 'describe', 'logs', 'top', 'events', 'explain', 'api-resources', 'api-versions', 'version', 'auth', 'cluster-info']);
const WRITE_VERBS = new Set(['rollout', 'scale', 'delete', 'label', 'annotate', 'cordon', 'uncordon', 'create', 'set', 'patch', 'drain', 'taint']);
const BLOCKED_FLAGS = /^--(kubeconfig|token|server|context|cluster|user|as|as-group|certificate-authority|insecure-skip-tls-verify)/;

export function splitArgs(s) {
  const out = []; let cur = ''; let quote = null;
  for (const ch of s) {
    if (quote) { if (ch === quote) quote = null; else cur += ch; }
    else if (ch === '"' || ch === "'") quote = ch;
    else if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = ''; } }
    else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

export async function handleKubectl(ws, { cfg, kcFor, user, q, snapshot }) {
  const { cluster } = q;
  const writeAllowed = process.env.KUBECTL_WRITE !== 'false' && canWrite(cfg, user);
  let kubeconfigPath = null;
  ws.on('close', () => { if (kubeconfigPath) fs.rmSync(path.dirname(kubeconfigPath), { recursive: true, force: true }); });

  ws.on('message', async (raw) => {
    let m; try { m = JSON.parse(raw.toString()); } catch { return; }
    if (m.type !== 'run') return;
    let args = splitArgs(String(m.cmd || '').trim());
    if (args[0] === 'kubectl') args = args.slice(1);
    const verb = args[0];
    const done = (code = 0) => send(ws, JSON.stringify({ type: 'exit', code }));
    if (!verb) return done();
    if (args.some((a) => BLOCKED_FLAGS.test(a))) { send(ws, JSON.stringify({ type: 'out', data: 'error: connection flags are managed by EKS Lens and cannot be overridden\n' })); return done(1); }
    if (!READ_VERBS.has(verb) && !(WRITE_VERBS.has(verb) && writeAllowed)) {
      send(ws, JSON.stringify({ type: 'out', data: `error: "${verb}" is not allowed here. Allowed: ${[...READ_VERBS].join(', ')}${writeAllowed ? ', ' + [...WRITE_VERBS].join(', ') : ''}\n(changes are disabled: READ_ONLY, WRITE_ENABLED=false or KUBECTL_WRITE=false)\n` }));
      return done(1);
    }
    if (verb === 'logs' && args.some((a) => a === '-f' || a === '--follow')) {
      send(ws, JSON.stringify({ type: 'out', data: 'tip: use the Logs tab for live streaming; running without --follow\n' }));
      args = args.filter((a) => a !== '-f' && a !== '--follow');
    }
    audit({ event: 'kubectl', user, cluster, args });

    if (cfg.demo) {
      const snap = await snapshot(cluster);
      send(ws, JSON.stringify({ type: 'out', data: fakeKubectl(snap, args) }));
      return done(0);
    }
    try {
      if (!kubeconfigPath) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eksl-'));
        kubeconfigPath = path.join(dir, 'config');
      }
      const kc = await kcFor(cluster); // refreshes token when near expiry
      fs.writeFileSync(kubeconfigPath, kc.exportConfig(), { mode: 0o600 });
      const p = spawn('kubectl', args, { env: { PATH: process.env.PATH, KUBECONFIG: kubeconfigPath, HOME: os.tmpdir() }, timeout: 60_000 });
      p.stdout.on('data', (d) => send(ws, JSON.stringify({ type: 'out', data: d.toString() })));
      p.stderr.on('data', (d) => send(ws, JSON.stringify({ type: 'err', data: d.toString() })));
      p.on('error', (e) => { send(ws, JSON.stringify({ type: 'err', data: `kubectl not available: ${e.message}\n` })); done(127); });
      p.on('close', (code) => done(code ?? 0));
    } catch (e) {
      send(ws, JSON.stringify({ type: 'err', data: e.message + '\n' })); done(1);
    }
  });
}
