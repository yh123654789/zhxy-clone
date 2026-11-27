/**
 * 第四轮：验证侧边栏路由、7 个页面数据、等级标签、菜单展开宽度
 */
'use strict';
const fs = require('fs'), path = require('path');
const { spawn } = require('child_process');

const URL_ = process.argv[2] || 'https://app-g2f70gc631fl.miaoda.online';
const OUT = path.join(__dirname, 'miaoda4');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9447, PF = path.join(__dirname, '.cdp-profile4');
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

let id = 0; const pending = new Map();
const send = (ws, method, params = {}) => {
  const mid = ++id; ws.send(JSON.stringify({ id: mid, method, params }));
  return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout ' + method)), 60000); pending.set(mid, { res, rej, t }); });
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
  const shot = async n => { const r = await send(ws, 'Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, n), Buffer.from(r.data, 'base64')); };

  await send(ws, 'Page.navigate', { url: URL_ });
  await sleep(9000);
  await ev(`[...document.querySelectorAll('button')].find(b=>/一键体验/.test(b.innerText))?.click()`);
  await sleep(6000);
  console.log('登录后 URL:', await ev('location.pathname'));

  const sidebar = await ev(`JSON.stringify([...document.querySelectorAll('aside button, nav button, [class*=sidebar] button, [class*=side] button')].map((b,i)=>({i,t:b.title||b.getAttribute('aria-label')||'',w:b.offsetWidth})))`);
  console.log('\n侧边栏按钮:', sidebar);

  const names = ['概览', '学生', '教师', '班级', '成绩', '通知', '请假', 'AI助手'];
  console.log('\n===== 逐个点击 8 个图标 =====');
  for (let i = 0; i < 8; i++) {
    const r = await ev(`(() => {
      const bs=[...document.querySelectorAll('aside button, nav button, [class*=sidebar] button, [class*=side] button')];
      if(!bs[${i}]) return 'no button ${i}';
      bs[${i}].click(); return 'clicked ' + (bs[${i}].title||bs[${i}].getAttribute('aria-label')||'#'+${i});
    })()`);
    await sleep(2600);
    const info = await ev(`JSON.stringify({
      url: location.pathname,
      text: (document.body.innerText||'').replace(/\\n+/g,' | ').slice(0,240),
      rows: document.querySelectorAll('tbody tr').length,
      cards: document.querySelectorAll('[class*=card],[class*=stat]').length,
    })`);
    console.log(`[${i}] ${names[i]}: ${r}`);
    console.log('     ', info);
    await shot(`0${i + 1}-${names[i]}.png`);
  }

  console.log('\n===== 学生页翻页测试 =====');
  await ev(`[...document.querySelectorAll('aside button, nav button, [class*=side] button')][1]?.click()`);
  await sleep(2500);
  const p1 = await ev(`JSON.stringify({rows:document.querySelectorAll('tbody tr').length, first:document.querySelector('tbody tr')?.innerText?.replace(/\\s+/g,' ')})`);
  console.log('  第1页:', p1);
  const nextOk = await ev(`(() => {
    const b=[...document.querySelectorAll('button')].find(x=>/下一页|下页|>/.test(x.innerText||'')||x.getAttribute('aria-label')==='next');
    if(!b) return 'NO_NEXT'; b.click(); return 'clicked next';
  })()`);
  console.log('  翻页:', nextOk);
  await sleep(2200);
  const p2 = await ev(`JSON.stringify({rows:document.querySelectorAll('tbody tr').length, first:document.querySelector('tbody tr')?.innerText?.replace(/\\s+/g,' ')})`);
  console.log('  第2页:', p2);
  await shot('09-学生第2页.png');

  console.log('\n===== 成绩页等级标签 =====');
  await ev(`[...document.querySelectorAll('aside button, nav button, [class*=side] button')][4]?.click()`);
  await sleep(2500);
  const grade = await ev(`JSON.stringify({
    url: location.pathname,
    stats: [...document.querySelectorAll('[class*=card],[class*=stat]')].length,
    labels: [...document.body.innerText.matchAll(/优秀|及格|不及格/g)].map(m=>m[0]).slice(0,40),
    hasBar: !!document.querySelector('[class*=progress],[style*=width]'),
  })`);
  console.log('  ', grade);
  await shot('10-成绩页.png');

  console.log('\n===== 请假页审批 =====');
  await ev(`[...document.querySelectorAll('aside button, nav button, [class*=side] button')][6]?.click()`);
  await sleep(2500);
  const before = await ev(`(document.body.innerText||'').slice(0,200).replace(/\\n+/g,' | ')`);
  console.log('  进入时:', before);
  await shot('11-请假页.png');
  const ap = await ev(`(() => {
    const b=[...document.querySelectorAll('button')].find(x=>/^通过$/.test((x.innerText||'').trim()));
    if(!b) return 'NO_APPROVE'; b.click(); return 'clicked 通过';
  })()`);
  console.log('  审批:', ap);
  await sleep(2500);
  console.log('  审批后:', await ev(`(document.body.innerText||'').slice(0,220).replace(/\\n+/g,' | ')`));
  await shot('12-请假审批后.png');

  console.log('\n===== 切换到传统菜单（量宽度） =====');
  await ev(`[...document.querySelectorAll('aside button, nav button, [class*=side] button')][0]?.click()`);
  await sleep(1500);
  const w0 = await ev(`(() => { const s=document.querySelector('aside,[class*=sidebar],[class*=side]'); return s?s.offsetWidth:-1; })()`);
  const toggled = await ev(`(() => {
    const b=[...document.querySelectorAll('button,a,span,div')].find(x=>/切换到传统菜单/.test(x.innerText||''));
    if(!b) return 'NO_TOGGLE'; b.click(); return 'clicked toggle';
  })()`);
  await sleep(2500);
  const w1 = await ev(`(() => { const s=document.querySelector('aside,[class*=sidebar],[class*=side]'); return s?s.offsetWidth:-1; })()`);
  const menuText = await ev(`(document.body.innerText||'').slice(0,200).replace(/\\n+/g,' | ')`);
  console.log(`  点击前宽 ${w0}px → 点击后 ${w1}px | ${toggled}`);
  console.log('  菜单文本:', menuText);
  await shot('13-展开传统菜单.png');

  console.log('\n===== 控制台报错检查 =====');
  const errs = await ev(`JSON.stringify(window.__errs||[])`);
  console.log('  ', errs);

  await sleep(300); try { ws.close(); } catch { } proc.kill();
  console.log('\n完成 →', OUT);
})();
