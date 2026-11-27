/**
 * 终验：评审视角全流程（无痕环境 → 一键体验 → 8 页 → AI 三类意图 → 审批 → 移动端 → 报错）
 * 输出 PASS/FAIL 清单
 */
'use strict';
const fs = require('fs'), path = require('path');
const { spawn } = require('child_process');

const URL_ = process.argv[2] || 'https://app-g2f70gc631fl.miaoda.online';
const OUT = path.join(__dirname, 'final');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9450, PF = path.join(__dirname, '.cdp-final');
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

const R = [];
const ck = (name, ok, detail = '') => {
  R.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`);
};

let id = 0; const pending = new Map();
const send = (ws, m, p = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p })); return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout ' + m)), 60000); pending.set(i, { res, rej, t }); }); };

(async () => {
  fs.rmSync(PF, { recursive: true, force: true });
  const proc = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--hide-scrollbars', '--window-size=1440,1000', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PF}`, 'about:blank'], { stdio: 'ignore' });

  let v = null;
  for (let i = 0; i < 40; i++) { await sleep(500); try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { v = await r.json(); break; } } catch { } }
  if (!v) { console.error('CDP 未就绪'); proc.kill(); process.exit(1); }
  const pages = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json());
  const ws = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
  const jsErrors = [];
  ws.addEventListener('message', e => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); clearTimeout(p.t); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); return; }
    if (m.method === 'Runtime.exceptionThrown') jsErrors.push((m.params.exceptionDetails?.exception?.description || 'exception').slice(0, 120));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
      jsErrors.push((m.params.args || []).map(a => a.value || a.description || '').join(' ').slice(0, 120));
  });
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  await send(ws, 'Page.enable'); await send(ws, 'Runtime.enable');
  await send(ws, 'Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

  const ev = async (x) => { const r = await send(ws, 'Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); return r.exceptionDetails ? null : (r.result && r.result.value); };
  const shot = async n => { const r = await send(ws, 'Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(OUT, n), Buffer.from(r.data, 'base64')); };
  const body = () => ev('document.body.innerText || ""');

  /* 1. 无痕打开 */
  console.log('\n【1】评审视角：未登录打开\n');
  const t0 = Date.now();
  await send(ws, 'Page.navigate', { url: URL_ });
  await sleep(7000);
  const first = await body();
  ck('未登录能打开（无痕环境）', first.length > 50, `${Date.now() - t0}ms 首屏`);
  ck('显示产品名', /智圃|AI 校园管理/.test(first));
  ck('有「一键体验」入口', /一键体验/.test(first));
  ck('有账号登录表单', /账号|密码/.test(first));
  await shot('01-登录页.png');

  /* 2. 一键体验 */
  console.log('\n【2】一键体验\n');
  const clicked = await ev(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/一键体验/.test(x.innerText||'')); if(!b) return false; b.click(); return true; })()`);
  await sleep(6000);
  const t2 = await body();
  ck('点「一键体验」能进入', clicked && /AI 助手|助手/.test(t2));
  ck('首屏是 AI 对话而非表格', /你好，我是/.test(t2));
  ck('有快捷指令胶囊', /查学生名单|查成绩统计/.test(t2));
  await shot('02-AI首屏.png');

  /* 3. AI 三类意图 */
  console.log('\n【3】AI 意图识别\n');
  const ask = async (q) => {
    const ok = await ev(`(() => {
      const b=[...document.querySelectorAll('textarea,input')].find(e=>e.offsetParent && !/账号|密码/.test(e.placeholder||''));
      if(!b) return false;
      const s=Object.getOwnPropertyDescriptor(b.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set;
      b.focus(); s.call(b, ${JSON.stringify(q)}); b.dispatchEvent(new Event('input',{bubbles:true}));
      b.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',keyCode:13,which:13,bubbles:true})); return true;
    })()`);
    if (!ok) return '';
    await sleep(1200);
    await ev(`[...document.querySelectorAll('button')].find(b=>/发送/.test(b.innerText||''))?.click()`);
    await sleep(5500);
    return await body();
  };

  let a = await ask('查一下五年级1班的成绩');
  ck('问成绩 → 返回成绩卡片', /成绩概况|均分/.test(a) && /及格率/.test(a), (a.match(/均分\s*[\d.]+/g) || []).slice(0, 3).join(' '));
  await shot('03-成绩卡片.png');

  a = await ask('待审批的请假');
  const hasApprove = await ev(`[...document.querySelectorAll('button')].filter(b=>/^通过$/.test((b.innerText||'').trim())).length`);
  ck('问请假 → 卡片带审批按钮', hasApprove > 0, `${hasApprove} 个「通过」按钮`);
  await shot('04-请假卡片.png');

  const before = (a.match(/待审批请假（(\d+)\s*条）/) || [])[1];
  await ev(`[...document.querySelectorAll('button')].find(b=>/^通过$/.test((b.innerText||'').trim()))?.click()`);
  await sleep(3000);
  const a2 = await body();
  const after = (a2.match(/待审批请假（(\d+)\s*条）/) || [])[1];
  ck('卡片内审批生效（数字递减）', before && after && Number(after) === Number(before) - 1, `${before} → ${after}`);
  await shot('05-审批后.png');

  a = await ask('最新通知');
  ck('问通知 → 返回通知卡片', /通知|公告/.test(a));
  await shot('06-通知卡片.png');

  /* 4. 八个页面 */
  console.log('\n【4】侧边栏 8 个功能页\n');
  const titles = ['概览', '学生管理', '教师管理', '班级管理', '成绩管理', '通知公告', '请假审批', 'AI 助手'];
  const expect = { '概览': /在校学生|学生/, '学生管理': /学号|共 \d+ 名/, '教师管理': /工号/, '班级管理': /班主任/,
    '成绩管理': /均分|及格率/, '通知公告': /阅读|置顶|通知/, '请假审批': /待审批|审批/, 'AI 助手': /助手/ };
  for (const t of titles) {
    const r = await ev(`(() => { const e=[...document.querySelectorAll('[title]')].find(x=>x.getAttribute('title')===${JSON.stringify(t)}); if(!e) return 'MISS'; e.click(); return 'OK'; })()`);
    await sleep(2400);
    const txt = await body();
    const ok = r === 'OK' && (expect[t] ? expect[t].test(txt) : true);
    ck(`页面「${t}」可进入且有内容`, ok, r === 'MISS' ? '找不到该菜单' : '');
    await shot(`10-${t}.png`);
  }

  /* 5. 三档等级 */
  await ev(`[...document.querySelectorAll('[title]')].find(x=>x.getAttribute('title')==='成绩管理')?.click()`);
  await sleep(2500);
  const gt = await body();
  ck('成绩页三档等级同屏', /优秀/.test(gt) && /及格/.test(gt) && /不及格/.test(gt),
    (gt.match(/优秀/g) || []).length + '优秀/' + (gt.match(/不及格/g) || []).length + '不及格');
  await shot('20-成绩三档.png');

  /* 6. 传统菜单 */
  console.log('\n【5】传统菜单与移动端\n');
  await ev(`[...document.querySelectorAll('button')].find(b=>/切换到传统菜单/.test(b.innerText||''))?.click()`);
  await sleep(2500);
  const w = await ev(`(() => { const s=document.querySelector('aside,[class*=sidebar],[class*=side]'); return s?s.offsetWidth:-1; })()`);
  ck('「切换到传统菜单」能展开', w > 120, `宽度 ${w}px`);
  await shot('30-展开菜单.png');

  await send(ws, 'Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(2500);
  const of = await ev(`JSON.stringify({sw:document.documentElement.scrollWidth, cw:document.documentElement.clientWidth})`);
  const o = JSON.parse(of || '{}');
  ck('移动端无横向溢出', o.sw === o.cw, `scrollWidth=${o.sw} clientWidth=${o.cw}`);
  await shot('40-移动端.png');

  /* 7. 报错 */
  ck('无 JS 运行时错误', jsErrors.length === 0, jsErrors.slice(0, 3).join(' | ') || 'clean');

  const pass = R.filter(x => x.ok).length;
  console.log(`\n${'='.repeat(50)}`);
  console.log(`终验结果：${pass}/${R.length} 通过`);
  if (pass !== R.length) { console.log('未通过：'); R.filter(x => !x.ok).forEach(x => console.log('  ✗ ' + x.name + ' ' + x.detail)); }
  console.log('='.repeat(50));

  await sleep(300); try { ws.close(); } catch { } proc.kill();
  console.log('截图 →', OUT);
})();
