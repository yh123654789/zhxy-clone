/**
 * 用 CDP 自动验收秒哒应用：截图 + 点击一键体验 + 发起 AI 提问
 *   node verify-miaoda.js [url]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const URL_ = process.argv[2] || 'https://app-g2f70gc631fl.miaoda.online';
const OUT = path.join(__dirname, 'miaoda');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9444;
const PF = path.join(__dirname, '.cdp-profile');
const sleep = ms => new Promise(r => setTimeout(r, ms));

fs.mkdirSync(OUT, { recursive: true });

let msgId = 0;
function send(ws, method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { ws.removeEventListener('message', on); reject(new Error('timeout ' + method)); }, 90000);
    function on(ev) {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id !== id) return;
      clearTimeout(t); ws.removeEventListener('message', on);
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
    ws.addEventListener('message', on);
  });
}

(async () => {
  fs.rmSync(PF, { recursive: true, force: true });
  const proc = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--window-size=1440,1000',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${PF}`, 'about:blank',
  ], { stdio: 'ignore' });

  let ver = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { ver = await r.json(); break; } } catch { }
  }
  if (!ver) { console.error('CDP 未就绪'); proc.kill(); process.exit(1); }
  console.log('Chrome:', ver.Browser);

  const pages = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json());
  const page = pages.find(p => p.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  await send(ws, 'Page.enable');
  await send(ws, 'Runtime.enable');
  await send(ws, 'Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

  const shot = async (name) => {
    const r = await send(ws, 'Page.captureScreenshot', { format: 'png' });
    const f = path.join(OUT, name);
    fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
    console.log('  截图:', name, (fs.statSync(f).size / 1024).toFixed(0) + 'KB');
  };
  const evalJs = async (expr) => {
    const r = await send(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result && r.result.value;
  };
  const text = () => evalJs('document.body ? document.body.innerText : ""');

  console.log('\n[1] 打开首页…');
  await send(ws, 'Page.navigate', { url: URL_ });
  await sleep(9000);
  await shot('01-登录页.png');
  const t1 = await text();
  console.log('---- 首页可见文本（前 600 字）----');
  console.log(t1.slice(0, 600));
  console.log('---- 结束 ----');

  console.log('\n[2] 查找「一键体验」按钮…');
  const found = await evalJs(`(() => {
    const els = [...document.querySelectorAll('button,a,div,span,p')];
    const hit = els.find(e => /一键体验|一键登录|体验/.test(e.innerText || ''));
    if (!hit) return 'NOT_FOUND';
    hit.scrollIntoView({block:'center'});
    return hit.tagName + ' | ' + (hit.innerText || '').trim().slice(0, 40);
  })()`);
  console.log('   找到:', found);

  if (found !== 'NOT_FOUND') {
    await evalJs(`(() => {
      const els = [...document.querySelectorAll('button,a,div,span,p')];
      const hit = els.find(e => /一键体验|一键登录|体验/.test(e.innerText || ''));
      if (hit) hit.click();
      return true;
    })()`);
    await sleep(6000);
    await shot('02-点击一键体验后.png');
    const t2 = await text();
    console.log('---- 点击后文本（前 700 字）----');
    console.log(t2.slice(0, 700));
    console.log('---- 结束 ----');

    console.log('\n[3] 尝试发起 AI 提问…');
    const typed = await evalJs(`(() => {
      const box = [...document.querySelectorAll('input,textarea')].find(e =>
        !e.disabled && (e.offsetParent !== null));
      if (!box) return 'NO_INPUT';
      box.focus();
      box.value = '查一下五年级1班的成绩';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      box.dispatchEvent(new Event('change', { bubbles: true }));
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      return box.tagName + ' | placeholder=' + (box.placeholder || '');
    })()`);
    console.log('   输入框:', typed);
    await sleep(2500);
    const clickedSend = await evalJs(`(() => {
      const b = [...document.querySelectorAll('button')].find(e => /发送|提问|问一问|提交/.test(e.innerText || ''));
      if (!b) return 'NO_SEND_BTN';
      b.click(); return 'clicked';
    })()`);
    console.log('   发送按钮:', clickedSend);
    await sleep(6000);
    await shot('03-AI提问后.png');
    const t3 = await text();
    console.log('---- AI 交互后文本（前 900 字）----');
    console.log(t3.slice(0, 900));
    console.log('---- 结束 ----');
  }

  await sleep(500);
  try { ws.close(); } catch { }
  proc.kill();
  console.log('\n完成，截图在', OUT);
})();
