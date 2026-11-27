/**
 * 第五轮：按 title 精确点击，避开「退出登录」
 */
'use strict';
const fs = require('fs'), path = require('path');
const { spawn } = require('child_process');

const URL_ = process.argv[2] || 'https://app-g2f70gc631fl.miaoda.online';
const OUT = path.join(__dirname, 'miaoda5');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9448, PF = path.join(__dirname, '.cdp-profile5');
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
  const shot = async n => { const r = await send(ws, 'Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, n), Buffer.from(r.data, 'base64')); console.log('  📷', n); };

  await send(ws, 'Page.navigate', { url: URL_ });
  await sleep(9000);
  await ev(`[...document.querySelectorAll('button')].find(b=>/一键体验/.test(b.innerText))?.click()`);
  await sleep(6000);

  console.log('[0] 登录后状态');
  console.log('  URL:', await ev('location.pathname'), '| hash:', await ev('location.hash'));
  console.log('  带 title 的元素:', await ev(`JSON.stringify([...document.querySelectorAll('[title]')].map(e=>({t:e.getAttribute('title'), tag:e.tagName, w:e.offsetWidth})))`));

  // 先展开菜单（点「收起菜单/展开菜单」或「切换到传统菜单」）
  const expand = await ev(`(() => {
    const b=[...document.querySelectorAll('button')].find(x=>/切换到传统菜单|展开菜单/.test(x.innerText||''));
    if(!b) return 'no expand btn'; b.click(); return 'expanded';
  })()`);
  console.log('\n[1] 展开菜单:', expand);
  await sleep(2500);
  const sideW = await ev(`(() => { const s=document.querySelector('aside,[class*=sidebar],[class*=side]'); return s?{w:s.offsetWidth, text:(s.innerText||'').replace(/\\n+/g,'|').slice(0,200)}:'none'; })()`);
  console.log('  侧边栏:', JSON.stringify(sideW));
  await shot('00-展开后的侧边栏.png');

  const items = ['概览', '学生', '教师', '班级', '成绩', '通知', '请假', 'AI 助手'];
  console.log('\n[2] 逐个点击（排除含"退出"的元素）');
  for (const name of items) {
    const r = await ev(`(() => {
      const cands=[...document.querySelectorAll('button,a,li,span,div')].filter(e=>{
        if(!e.offsetParent) return false;
        const t=(e.innerText||'').trim();
        if(!t || t.length>8) return false;
        if(/退出|登录|体验|收起/.test(t)) return false;
        return t==='${name}';
      });
      if(!cands.length) return 'NOT_FOUND';
      const el=cands[cands.length-1];
      el.click();
      return 'clicked ' + el.tagName + ' title=' + (el.getAttribute('title')||'');
    })()`);
    await sleep(2800);
    const info = await ev(`JSON.stringify({
      url: location.pathname + location.hash,
      rows: document.querySelectorAll('tbody tr').length,
      th: [...document.querySelectorAll('thead th')].map(t=>t.innerText.trim()).join('/'),
      head: (document.body.innerText||'').replace(/\\n+/g,' | ').slice(0,150),
      labels: [...(document.body.innerText||'').matchAll(/优秀|及格|不及格/g)].map(m=>m[0]).slice(0,12),
    })`);
    console.log(`  ${name.padEnd(6)} → ${r}`);
    console.log('     ', info);
    await shot(`${items.indexOf(name) + 1}-${name}.png`);
  }

  console.log('\n[3] 学生页翻页');
  await ev(`[...document.querySelectorAll('button,a,li,span,div')].find(e=>e.offsetParent&&(e.innerText||'').trim()==='学生')?.click()`);
  await sleep(2500);
  const pg1 = await ev(`JSON.stringify({rows:document.querySelectorAll('tbody tr').length, first:document.querySelector('tbody tr')?.innerText.replace(/\\s+/g,' ')})`);
  console.log('  第1页:', pg1);
  const nxt = await ev(`(() => {
    const b=[...document.querySelectorAll('button')].find(x=>/下一页|下页/.test(x.innerText||''));
    if(!b) return 'NO_NEXT'; b.click(); return 'clicked';
  })()`);
  await sleep(2200);
  console.log('  翻页:', nxt, '| 第2页:', await ev(`JSON.stringify({rows:document.querySelectorAll('tbody tr').length, first:document.querySelector('tbody tr')?.innerText.replace(/\\s+/g,' ')})`));
  await shot('09-学生第2页.png');

  console.log('\n[4] 请假页审批');
  await ev(`[...document.querySelectorAll('button,a,li,span,div')].find(e=>e.offsetParent&&(e.innerText||'').trim()==='请假')?.click()`);
  await sleep(2500);
  console.log('  进入:', await ev(`(document.body.innerText||'').replace(/\\n+/g,' | ').slice(0,220)`));
  const ap = await ev(`(() => {
    const b=[...document.querySelectorAll('button')].find(x=>/^通过$/.test((x.innerText||'').trim()));
    if(!b) return 'NO_APPROVE'; b.click(); return 'clicked';
  })()`);
  await sleep(2500);
  console.log('  审批:', ap, '| 之后:', await ev(`(document.body.innerText||'').replace(/\\n+/g,' | ').slice(0,240)`));
  await shot('10-请假审批后.png');

  console.log('\n[5] 收起菜单');
  const collapse = await ev(`(() => {
    const b=[...document.querySelectorAll('button')].find(x=>/收起菜单/.test(x.innerText||''));
    if(!b) return 'no collapse btn'; b.click(); return 'collapsed';
  })()`);
  await sleep(2000);
  console.log('  ', collapse, '| 宽度:', await ev(`(() => { const s=document.querySelector('aside,[class*=sidebar],[class*=side]'); return s?s.offsetWidth:-1; })()`));

  await sleep(300); try { ws.close(); } catch { } proc.kill();
  console.log('\n完成 →', OUT);
})();
