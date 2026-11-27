/**
 * 精确定位版验收：列出所有按钮 → 点「一键体验」→ 进后台 → 列菜单 → 测 AI 对话
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const URL_ = process.argv[2] || 'https://app-g2f70gc631fl.miaoda.online';
const OUT = path.join(__dirname, 'miaoda2');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9445;
const PF = path.join(__dirname, '.cdp-profile2');
const sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

let id = 0;
const pending = new Map();
function send(ws, method, params = {}) {
  const mid = ++id;
  ws.send(JSON.stringify({ id: mid, method, params }));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout ' + method)), 90000);
    pending.set(mid, { resolve, reject, t });
  });
}

(async () => {
  fs.rmSync(PF, { recursive: true, force: true });
  const proc = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
    '--window-size=1440,1000', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PF}`, 'about:blank'], { stdio: 'ignore' });

  let ver = null;
  for (let i = 0; i < 40; i++) { await sleep(500); try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { ver = await r.json(); break; } } catch { } }
  if (!ver) { console.error('CDP 未就绪'); proc.kill(); process.exit(1); }

  const pages = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json());
  const ws = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
  ws.addEventListener('message', (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); clearTimeout(p.t); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
  });
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  await send(ws, 'Page.enable'); await send(ws, 'Runtime.enable');
  await send(ws, 'Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

  const ev = async (expr) => {
    const r = await send(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return 'EXCEPTION: ' + (r.exceptionDetails.text || '');
    return r.result && r.result.value;
  };
  const shot = async (n) => {
    const r = await send(ws, 'Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, n), Buffer.from(r.data, 'base64'));
    console.log('  📷', n);
  };
  const txt = () => ev('document.body.innerText');

  console.log('[1] 打开…');
  await send(ws, 'Page.navigate', { url: URL_ });
  await sleep(9000);
  await shot('01-登录页.png');

  console.log('\n[2] 列出页面所有按钮');
  const btns = await ev(`JSON.stringify([...document.querySelectorAll('button,[role=button]')].map((b,i)=>({i, t:(b.innerText||'').trim().slice(0,30), cls:(b.className||'').toString().slice(0,40)})))`);
  console.log(btns);

  console.log('\n[3] 点击「一键体验」');
  const clicked = await ev(`(() => {
    const b = [...document.querySelectorAll('button,[role=button]')].find(x => /一键体验/.test(x.innerText||''));
    if (!b) return 'NO_BUTTON';
    b.click(); return 'clicked: ' + (b.innerText||'').trim().slice(0,20);
  })()`);
  console.log('  ', clicked);
  await sleep(7000);
  await shot('02-后台首页.png');
  const t2 = await txt();
  console.log('\n---- 点击后页面文本（前 1200 字）----');
  console.log(t2.slice(0, 1200));
  console.log('---- 结束 ----\n');

  // 判断是否进入后台
  const inApp = /概览|学生|成绩|AI 助手|助手/.test(t2) && !/请输入账号/.test(t2.slice(0, 300));
  console.log('[4] 是否进入后台:', inApp ? '是 ✓' : '否 ✗');

  if (inApp) {
    console.log('\n[5] 列出可点击的导航/菜单项');
    const navs = await ev(`JSON.stringify([...document.querySelectorAll('a,button,[role=button],li,div')].filter(e=>e.offsetParent&&/^(概览|学生管理|教师管理|班级管理|成绩管理|通知公告|请假审批|AI ?助手|学生|教师|班级|成绩|通知|请假)$/.test((e.innerText||'').trim())).map(e=>(e.innerText||'').trim()))`);
    console.log('  ', navs);

    console.log('\n[6] 找 AI 输入框并提问');
    const inputs = await ev(`JSON.stringify([...document.querySelectorAll('input,textarea')].filter(e=>e.offsetParent).map(e=>({tag:e.tagName, ph:e.placeholder||'', type:e.type||''})))`);
    console.log('  输入框:', inputs);

    const typed = await ev(`(() => {
      const box = [...document.querySelectorAll('input,textarea')].find(e=>e.offsetParent && !/账号|密码/.test(e.placeholder||''));
      if (!box) return 'NO_CHAT_INPUT';
      const setter = Object.getOwnPropertyDescriptor(box.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set;
      box.focus(); setter.call(box, '查一下五年级1班的成绩');
      box.dispatchEvent(new Event('input',{bubbles:true}));
      box.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true}));
      return 'typed into: ' + (box.placeholder||box.tagName);
    })()`);
    console.log('  ', typed);
    await sleep(2000);
    const sendBtn = await ev(`(() => {
      const b=[...document.querySelectorAll('button')].find(x=>/发送|提问|问一问|提交|→/.test(x.innerText||''));
      if(!b) return 'NO_SEND'; b.click(); return 'clicked send';
    })()`);
    console.log('  发送:', sendBtn);
    await sleep(8000);
    await shot('03-AI对话.png');
    const t3 = await txt();
    console.log('\n---- 提问后文本（后 1200 字，看 AI 回复）----');
    console.log(t3.slice(-1200));
    console.log('---- 结束 ----');

    // 逐个点菜单截图
    console.log('\n[7] 遍历菜单截图');
    for (const name of ['学生', '成绩', '通知', '请假', '教师', '班级', '概览']) {
      const ok = await ev(`(() => {
        const e=[...document.querySelectorAll('a,button,li,div,span')].find(x=>x.offsetParent&&(x.innerText||'').trim()==='${name}');
        if(!e) return 'miss'; e.click(); return 'ok';
      })()`);
      await sleep(2500);
      if (ok === 'ok') await shot('04-菜单-' + name + '.png');
      console.log('  ' + name + ':', ok);
    }
  }

  // 移动端
  console.log('\n[8] 移动端视口测试');
  await send(ws, 'Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(2500);
  await shot('05-移动端.png');

  const overflow = await ev('JSON.stringify({sw:document.documentElement.scrollWidth, cw:document.documentElement.clientWidth})');
  console.log('  横向溢出检查:', overflow);

  await sleep(300);
  try { ws.close(); } catch { }
  proc.kill();
  console.log('\n完成 →', OUT);
})();
