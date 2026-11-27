/**
 * 对比三条候选链接在「未登录」状态下能否看到应用
 */
'use strict';
const fs = require('fs'), path = require('path');
const { spawn } = require('child_process');
const OUT = path.join(__dirname, 'linkcheck');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9451, PF = path.join(__dirname, '.cdp-link');
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

const URLS = [
  ['A-appmiaoda', 'https://app-g2f70gc631fl.appmiaoda.com'],
  ['B-apps', 'https://www.miaoda.cn/apps/app-g2f70gc631fl'],
  ['C-projects', 'https://www.miaoda.cn/projects/app-g2f70gc631fl'],
  ['D-online', 'https://app-g2f70gc631fl.miaoda.online'],
];

let id = 0; const pending = new Map();
const send = (ws, m, p = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p })); return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('to ' + m)), 60000); pending.set(i, { res, rej, t }); }); };

(async () => {
  fs.rmSync(PF, { recursive: true, force: true });
  const proc = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
    '--window-size=1440,1000', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PF}`, 'about:blank'], { stdio: 'ignore' });
  let v = null;
  for (let i = 0; i < 40; i++) { await sleep(500); try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { v = await r.json(); break; } } catch { } }
  const pages = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json());
  const ws = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
  ws.addEventListener('message', e => { let m; try { m = JSON.parse(e.data); } catch { return; } if (m.id && pending.has(m.id)) { const p = pending.get(m.id); clearTimeout(p.t); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  await send(ws, 'Page.enable'); await send(ws, 'Runtime.enable');
  await send(ws, 'Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  const ev = async (x) => { const r = await send(ws, 'Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); return r.exceptionDetails ? null : (r.result && r.result.value); };
  const shot = async n => { const r = await send(ws, 'Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, n), Buffer.from(r.data, 'base64')); };

  for (const [tag, url] of URLS) {
    console.log('\n' + '='.repeat(60));
    console.log('测试:', tag, url);
    await send(ws, 'Page.navigate', { url });
    await sleep(10000);
    const info = await ev(`JSON.stringify({
      finalUrl: location.href,
      title: document.title,
      text: (document.body.innerText||'').replace(/\\n+/g,' | ').slice(0, 500),
      hasDemo: /一键体验/.test(document.body.innerText||''),
      hasAi: /AI 助手|AI助手/.test(document.body.innerText||''),
      needsLogin: /登录|扫码|账号/.test(document.body.innerText||''),
      iframes: [...document.querySelectorAll('iframe')].map(f=>f.src),
    })`);
    console.log(info);
    await shot(tag + '.png');
  }

  await sleep(300); try { ws.close(); } catch { } proc.kill();
  console.log('\n截图 →', OUT);
})();
