/**
 * 第三轮：传统菜单、功能页、卡片内审批
 */
'use strict';
const fs = require('fs'), path = require('path');
const { spawn } = require('child_process');

const URL_ = process.argv[2] || 'https://app-g2f70gc631fl.miaoda.online';
const OUT = path.join(__dirname, 'miaoda3');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9446, PF = path.join(__dirname, '.cdp-profile3');
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

let id = 0; const pending = new Map();
const send = (ws, method, params = {}) => {
  const mid = ++id; ws.send(JSON.stringify({ id: mid, method, params }));
  return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout ' + method)), 90000); pending.set(mid, { res, rej, t }); });
};

(async () => {
  fs.rmSync(PF, { recursive: true, force: true });
  const proc = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
    '--window-size=1440,1000', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PF}`, 'about:blank'], { stdio: 'ignore' });
  let ver = null;
  for (let i = 0; i < 40; i++) { await sleep(500); try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { ver = await r.json(); break; } } catch { } }
  if (!ver) { console.error('CDP fail'); proc.kill(); process.exit(1); }
  const pages = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json());
  const ws = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
  ws.addEventListener('message', (e2) => { let m; try { m = JSON.parse(e2.data); } catch { return; } if (m.id && pending.has(m.id)) { const p = pending.get(m.id); clearTimeout(p.t); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  await send(ws, 'Page.enable'); await send(ws, 'Runtime.enable');
  await send(ws, 'Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

  const ev = async (expr) => {
    const r = await send(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.exceptionDetails ? 'EX: ' + r.exceptionDetails.text : (r.result && r.result.value);
  };
  const shot = async n => { const r = await send(ws, 'Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, n), Buffer.from(r.data, 'base64')); console.log('  📷', n); };

  await send(ws, 'Page.navigate', { url: URL_ });
  await sleep(9000);
  await ev(`[...document.querySelectorAll('button')].find(b=>/一键体验/.test(b.innerText))?.click()`);
  await sleep(6000);

  console.log('\n[A] 侧边栏结构');
  console.log(await ev(`JSON.stringify([...document.querySelectorAll('aside button, nav button, [class*=sidebar] button, [class*=Sidebar] button, [class*=side] button')].map((b,i)=>({i, t:(b.innerText||'').trim(), title:b.title||'', aria:b.getAttribute('aria-label')||'', svg:!!b.querySelector('svg')})))`));

  console.log('\n[B] 点「切换到传统菜单」');
  await ev(`[...document.querySelectorAll('button,a,span,div')].find(e=>/切换到传统菜单/.test(e.innerText||''))?.click()`);
  await sleep(3000);
  await shot('01-传统菜单.png');
  const t1 = await ev('document.body.innerText');
  console.log(t1.slice(0, 500));

  console.log('\n[C] 当前所有带文字的按钮');
  console.log(await ev(`JSON.stringify([...document.querySelectorAll('button')].filter(b=>b.offsetParent).map(b=>(b.innerText||'').trim()).filter(Boolean).slice(0,30))`));

  console.log('\n[D] 点侧边栏第 2 个按钮（学生）');
  const r2 = await ev(`(() => {
    const bs=[...document.querySelectorAll('aside button, nav button, [class*=sidebar] button, [class*=side] button')];
    if(bs.length<2) return 'only '+bs.length+' buttons';
    bs[1].click(); return 'clicked #1: '+(bs[1].innerText||bs[1].title||'');
  })()`);
  console.log(' ', r2);
  await sleep(3500);
  await shot('02-学生页.png');
  const t2 = await ev('document.body.innerText');
  console.log('  学生页文本前 400:', t2.slice(0, 400).replace(/\n+/g, ' | '));

  console.log('\n[E] 测「待审批请假」卡片内审批');
  await ev(`[...document.querySelectorAll('button')].find(b=>/AI ?助手/.test(b.innerText||''))?.click()`);
  await sleep(1500);
  const typed = await ev(`(() => {
    const box=[...document.querySelectorAll('textarea,input')].find(e=>e.offsetParent && !/账号|密码/.test(e.placeholder||''));
    if(!box) return 'NO_BOX';
    const s=Object.getOwnPropertyDescriptor(box.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set;
    box.focus(); s.call(box,'待审批的请假');
    box.dispatchEvent(new Event('input',{bubbles:true}));
    box.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));
    return 'ok';
  })()`);
  console.log('  输入:', typed);
  await sleep(1500);
  await ev(`[...document.querySelectorAll('button')].find(b=>/发送/.test(b.innerText||''))?.click()`);
  await sleep(6000);
  await shot('03-请假卡片.png');
  const t3 = await ev('document.body.innerText');
  console.log('  请假相关文本:', t3.slice(-800).replace(/\n+/g, ' | '));

  console.log('\n[F] 卡片上的审批按钮');
  const apBtns = await ev(`JSON.stringify([...document.querySelectorAll('button')].filter(b=>b.offsetParent&&/通过|驳回/.test(b.innerText||'')).map(b=>(b.innerText||'').trim()))`);
  console.log('  审批按钮:', apBtns);
  if (apBtns && apBtns !== '[]') {
    const before = await ev('document.body.innerText.length');
    await ev(`[...document.querySelectorAll('button')].find(b=>/通过/.test(b.innerText||''))?.click()`);
    await sleep(3000);
    await shot('04-点了通过之后.png');
    const after = await ev('document.body.innerText.length');
    console.log('  点击后文本长度变化:', before, '→', after, before !== after ? '（有变化 ✓）' : '（无变化 ✗）');
    const t4 = await ev('document.body.innerText');
    console.log('  尾部:', t4.slice(-400).replace(/\n+/g, ' | '));
  }

  console.log('\n[G] 刷新后数据是否保留');
  await send(ws, 'Page.reload');
  await sleep(8000);
  const t5 = await ev('document.body.innerText');
  console.log('  刷新后首页:', t5.slice(0, 120).replace(/\n+/g, ' | '), '| 是否还在后台:', /智圃 AI 助手|一键体验/.test(t5));

  await sleep(300); try { ws.close(); } catch { } proc.kill();
  console.log('\n完成 →', OUT);
})();
