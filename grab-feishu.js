/**
 * 用已登录的 Chrome profile 抓取飞书文档正文
 *   node grab-feishu.js <url> [profileDir]
 * 前置：Chrome 必须完全关闭（否则 profile/Cookies 被独占锁）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const URL_ = process.argv[2] || 'https://ecncxji1a4kf.feishu.cn/wiki/HvZjwElAgi8SkYkezF5cXQmIns5';
const SRC = process.argv[3] || path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data');
const TMP = path.join(__dirname, '.tmp-profile');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9333;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function copyProfile() {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(path.join(TMP, 'Default'), { recursive: true });
  const items = ['Cookies', 'Network/Cookies', 'Preferences', 'Login Data', 'Local Storage', 'Session Storage', 'Web Data'];
  let ok = 0;
  for (const it of items) {
    const s = path.join(SRC, 'Default', it);
    const t = path.join(TMP, 'Default', it);
    if (!fs.existsSync(s)) continue;
    try {
      fs.mkdirSync(path.dirname(t), { recursive: true });
      fs.cpSync(s, t, { recursive: true });
      ok++;
    } catch (e) {
      console.log(`  ! 复制失败 ${it}: ${e.code || e.message}`);
    }
  }
  // Local State 里存着解密 cookie 的密钥
  try { fs.copyFileSync(path.join(SRC, 'Local State'), path.join(TMP, 'Local State')); ok++; } catch { }
  console.log(`  已复制 ${ok} 项到临时 profile`);
  return ok > 0;
}

async function cdp(ws, method, params = {}) {
  const id = Math.floor(Math.random() * 1e6);
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('CDP 超时 ' + method)), 60000);
    const onMsg = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id === id) { clearTimeout(t); ws.removeEventListener('message', onMsg); resolve(m.result); }
    };
    ws.addEventListener('message', onMsg);
  });
}

(async () => {
  if (!fs.existsSync(CHROME)) { console.error('未找到 Chrome:', CHROME); process.exit(1); }
  console.log('1) 复制登录态…');
  if (!copyProfile()) { console.error('复制失败：请先完全关闭 Chrome'); process.exit(1); }

  console.log('2) 启动 headless Chrome…');
  const proc = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${TMP}`,
    '--window-size=1440,2400', 'about:blank',
  ], { stdio: 'ignore', detached: false });

  // 等 CDP 就绪
  let ver = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) { ver = await r.json(); break; }
    } catch { }
  }
  if (!ver) { console.error('CDP 未就绪'); proc.kill(); process.exit(1); }
  console.log('   Chrome', ver.Browser);

  const pages = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json());
  const page = pages.find(p => p.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  console.log('3) 打开文档…');
  await cdp(ws, 'Page.enable');
  await cdp(ws, 'Page.navigate', { url: URL_ });

  console.log('4) 等待渲染（25 秒）…');
  await sleep(25000);

  const read = async () => {
    const r = await cdp(ws, 'Runtime.evaluate', {
      expression: `(() => {
        const pick = (sel) => document.querySelector(sel)?.innerText || '';
        const body = document.body ? document.body.innerText : '';
        const blocks = [...document.querySelectorAll('[data-block-id]')].map(e => e.innerText).filter(Boolean);
        return JSON.stringify({
          title: document.title,
          url: location.href,
          loginWall: /登录|扫码登录|sign in/i.test(body.slice(0, 400)),
          bodyLen: body.length,
          body: body.slice(0, 20000),
          blocks: blocks.join('\\n').slice(0, 20000),
        });
      })()`, returnByValue: true,
    });
    return JSON.parse(r.result.value);
  };

  let out = await read();
  if (out.bodyLen < 200 || out.loginWall) {
    console.log('   页面似乎需要登录，再等 20 秒重试…');
    await sleep(20000);
    out = await read();
  }

  const txt = [out.title, out.url, '', out.blocks && out.blocks.length > out.bodyLen ? out.blocks : out.body].join('\n');
  fs.writeFileSync(path.join(__dirname, 'feishu-doc.txt'), txt, 'utf8');
  console.log(`\n5) 完成：title=${out.title}`);
  console.log(`   正文长度 ${out.bodyLen}，loginWall=${out.loginWall}`);
  console.log(`   已写入 feishu-doc.txt（${(txt.length / 1024).toFixed(1)} KB）`);
  console.log('--- 前 600 字 ---');
  console.log(txt.slice(0, 600));

  try { ws.close(); } catch { }
  proc.kill();
})();
