/**
 * 抖音登录窗口「长驻承载器」
 *
 *   node tools/douyin/dy_login.mjs [--minutes 25]
 *
 * 本机宿主会回收工具启动的子进程，窗口必须由一个持续运行的任务托住。
 * 启动 Chrome → 打开抖音首页 → 若未登录则打开登录框 → 静默保持，
 * 期间绝不点击/刷新/导航，避免打断扫码或短信登录。
 * 登录成功后写 data/douyin/login_ok.json，供后续抓取脚本判断。
 */
import fs from 'node:fs';
import path from 'node:path';
import { ensure } from '../lib/chrome.mjs';
import { loginProfile } from '../lib/paths.mjs';

const PORT = parseInt(process.env.DY_LOGIN_PORT || '9430', 10);
const PROFILE = process.env.DY_PROFILE || loginProfile();
// 产物与截图落当前工作区的 dy_output（原实现引用了不存在的 DATA_ROOT，一跑就 ReferenceError）
const OUTDIR = process.env.DY_DATA_DIR || path.join(process.env.DY_ROOT || process.cwd(), 'dy_output');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fetchT = (u, o = {}, ms = 6000) => fetch(u, { ...o, signal: AbortSignal.timeout(ms) });

const mArg = process.argv.indexOf('--minutes');
const MINUTES = mArg > 0 ? (parseFloat(process.argv[mArg + 1]) || 25) : 25;

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.p = new Map(); }
  static async open(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws fail')); });
    const c = new CDP(ws);
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && c.p.has(m.id)) {
        const { res, rej } = c.p.get(m.id); c.p.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error).slice(0, 160))) : res(m.result);
      }
    };
    return c;
  }
  send(method, params = {}, tmo = 20000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.p.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.p.has(id)) { this.p.delete(id); rej(new Error('timeout:' + method)); } }, tmo);
    });
  }
  async eval(e, t = 20000) {
    const r = await this.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true }, t);
    return r.exceptionDetails ? { __err: JSON.stringify(r.exceptionDetails).slice(0, 200) } : r.result.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

// 登录窗口必须可见、可交互：visible=true 把窗口放到屏幕内（采集时则是移出屏幕）
async function bootChrome() {
  try {
    const ver = await ensure({
      port: PORT,
      profile: PROFILE,
      visible: true,
      winPos: '60,30',
      extraArgs: ['--lang=zh-CN'],
      bootTimeoutMs: 30000,
    });
    console.log(`[chrome] ${ver.browser}${ver.reused ? '（复用）' : ''}`);
    return true;
  } catch (e) {
    console.error('[chrome] ' + e.message);
    return false;
  }
}

async function getPageTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetchT(`http://127.0.0.1:${PORT}/json/list`)).json();
      const pages = list.filter(t => t.type === 'page' && !String(t.url).startsWith('devtools'));
      const dy = pages.find(t => /douyin\.com/.test(t.url));
      if (dy) return dy;
      if (pages[0]) return pages[0];
    } catch { /* ignore */ }
    await sleep(500);
  }
  return null;
}

// 登录态判定：cookie 里出现 sessionid（httpOnly，走 CDP 才读得到）
async function loginState(cdp) {
  try {
    const { cookies } = await cdp.send('Network.getAllCookies', {}, 8000);
    const names = new Set(cookies.map(c => c.name));
    const hasSession = names.has('sessionid') || names.has('sessionid_ss') || names.has('sid_tt');
    const uid = cookies.find(c => c.name === 'uid_tt' || c.name === 'uid_tt_ss');
    return { ok: hasSession, cookies: cookies.length, uid: uid ? String(uid.value).slice(0, 12) : null };
  } catch (e) {
    return { ok: false, err: String(e.message || e).slice(0, 80) };
  }
}

async function shoot(cdp, file) {
  try {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' }, 20000);
    fs.mkdirSync(OUTDIR, { recursive: true });
    fs.writeFileSync(path.join(OUTDIR, file), Buffer.from(r.data, 'base64'));
    return path.join(OUTDIR, file);
  } catch { return null; }
}

(async () => {
  fs.mkdirSync(OUTDIR, { recursive: true });
  if (!await bootChrome()) { console.error('[fail] Chrome 启动失败'); process.exit(2); }

  const target = await getPageTarget();
  if (!target) { console.error('[fail] 找不到页面 target'); process.exit(3); }
  console.log('[page] ' + target.url);

  const cdp = await CDP.open(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable', {}).catch(() => {});
  await cdp.send('Network.enable', {}).catch(() => {});
  await cdp.send('Runtime.enable', {}).catch(() => {});

  // 只在「当前不在抖音」时导航一次，避免打断已有页面
  if (!/douyin\.com/.test(target.url)) {
    await cdp.send('Page.navigate', { url: 'https://www.douyin.com/' }, 30000).catch(() => {});
    await sleep(4500);
  }

  let st = await loginState(cdp);
  console.log('[cookie] ' + JSON.stringify(st));

  if (!st.ok) {
    // 尝试点开登录框（只点一次，找不到就算了，用户可手动点右上角「登录」）
    const clicked = await cdp.eval(`(() => {
      const cands = [...document.querySelectorAll('div,span,button,a')]
        .filter(el => el.offsetParent !== null && (el.innerText || '').trim() === '登录');
      if (cands.length) { cands[0].click(); return 'clicked'; }
      return 'not-found';
    })()`).catch(() => 'err');
    console.log('[login-panel] ' + clicked);
    await sleep(2500);
  }

  const shot = await shoot(cdp, 'dy_login_window.png');
  console.log('[shot] ' + (shot || 'fail'));

  // 静默守护：每 5 秒查一次登录态，登录成功即写标记并继续保活
  const deadline = Date.now() + MINUTES * 60 * 1000;
  let lastOk = st.ok, ticks = 0;
  while (Date.now() < deadline) {
    await sleep(5000);
    ticks++;
    const cur = await loginState(cdp);
    if (cur.ok && !lastOk) {
      fs.writeFileSync(path.join(OUTDIR, 'login_ok.json'),
        JSON.stringify({ at: new Date().toISOString(), cookies: cur.cookies, uid: cur.uid }, null, 2));
      console.log('[login] ✅ 检测到登录态，已写 data/douyin/login_ok.json');
      await shoot(cdp, 'dy_login_ok.png');
      lastOk = true;
    }
    if (!cur.ok && lastOk) { console.log('[login] ⚠️ 登录态消失'); lastOk = false; }
    if (ticks % 6 === 0) console.log(`[hold] ${Math.round((deadline - Date.now()) / 1000)}s left · logged=${cur.ok} · cookies=${cur.cookies}`);
  }
  console.log('[hold] 到时退出，窗口保留');
  process.exit(0);
})().catch(e => { console.error('[fatal]', e.message); process.exit(1); });
