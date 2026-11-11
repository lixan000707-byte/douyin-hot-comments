/**
 * chrome.mjs — 浏览器生命周期（唯一实现）
 *
 *   ensure()      启动或复用带调试端口的 Chrome
 *   newTab()      后台建标签（不抢焦点）+ 强制活跃（防后台节流）
 *   closeTab()    真正关闭 target，而不是只关 WebSocket
 *   browserClose()协议层关闭整个浏览器（比杀进程干净，不留文件句柄）
 *   restart()     关闭 → 清 profile → 重拉（长跑每 N 个账号调用一次）
 *   sweep()       profile 体积治理
 *   stats()       一行可观测日志
 *
 * 约定：进程退出时只清理「自己启动的」实例；复用别人起的实例绝不动手。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CDP } from './cdp.mjs';
import { findBrowser, offscreenPos, pidOnPort, killTree, SPAWN_DETACHED } from './platform.mjs';
import { expand, sizeMB } from './paths.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 本进程启动过的浏览器：只在 exit 时清理这些
const owned = new Set();
let hookInstalled = false;

function installExitHook() {
  if (hookInstalled) return;
  hookInstalled = true;
  process.on('exit', () => {
    for (const pid of owned) killTree(pid);
    owned.clear();
  });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      for (const pid of owned) killTree(pid);
      owned.clear();
      process.exit(130);
    });
  }
}

async function fetchJson(url, ms = 2000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

/** 探测调试端口；活着返回 /json/version 内容 */
export async function probe(port, ms = 1500) {
  return fetchJson(`http://127.0.0.1:${port}/json/version`, ms);
}

/**
 * 启动或复用 Chrome。
 * @returns {{port:number, reused:boolean, pid:number|null, browser:string}}
 */
export async function ensure({
  port = 9333,
  profile,
  headless = false,
  visible = false,
  winPos,
  extraArgs = [],
  bootTimeoutMs = 20000,
} = {}) {
  const dir = path.resolve(expand(profile));
  const alive = await probe(port);
  if (alive) return { port, reused: true, pid: null, browser: alive.Browser || 'unknown' };

  // 端口被占但 CDP 不通：残留实例，清掉再拉（不清就会白白等 20 秒然后报「启动超时」）
  const holder = pidOnPort(port);
  if (holder) {
    killTree(holder);
    await sleep(1500);
    if (await probe(port, 1200)) {
      return { port, reused: true, pid: null, browser: 'recovered' };
    }
  }

  const exe = findBrowser();
  if (!exe) {
    throw new Error('找不到 Chrome/Edge。请安装 Chrome，或设置 DY_CHROME=/path/to/chrome');
  }

  fs.mkdirSync(dir, { recursive: true });
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${dir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion',
    '--disk-cache-size=104857600',
    '--window-size=1280,900',
    `--window-position=${winPos || (visible ? '60,40' : offscreenPos())}`,
    'about:blank',
    ...extraArgs,
  ];
  if (headless) args.unshift('--headless=new');

  const child = spawn(exe, args, {
    stdio: 'ignore',
    detached: SPAWN_DETACHED,
  });
  child.on('error', () => {});
  child.unref?.();
  // DY_KEEP_CHROME=1：留给批处理复用同一个实例（避免每个词冷启 30s）；
  // 默认退出即清理，不把浏览器留在后台。
  if (child.pid && process.env.DY_KEEP_CHROME !== '1') {
    installExitHook();
    owned.add(child.pid);
  }

  const deadline = Date.now() + bootTimeoutMs;
  while (Date.now() < deadline) {
    const v = await probe(port, 1500);
    if (v) return { port, reused: false, pid: child.pid || null, browser: v.Browser || 'unknown' };
    await sleep(300);
  }

  const nowHolder = pidOnPort(port);
  const hint = nowHolder
    ? `端口 ${port} 被 pid ${nowHolder} 占用且无响应，可执行 killTree 清理或换 DY_PORT`
    : `检查 DY_CHROME 路径：${exe}`;
  throw new Error(`Chrome 启动超时（${bootTimeoutMs / 1000}s）：${hint}`);
}

/**
 * 后台新建标签页并连上 CDP。
 * 先走 Target.createTarget（background=true 不抢焦点），失败才退回 /json/new。
 * 建完强制「假装前台」，否则后台标签定时器冻结，页面 JS 不跑，抓 0 条。
 */
export async function newTab(port, { url = 'about:blank' } = {}) {
  let target = null;

  const ver = await probe(port);
  if (ver?.webSocketDebuggerUrl) {
    let bw = null;
    try {
      bw = await CDP.open(ver.webSocketDebuggerUrl, { retries: 1, timeout: 8000 });
      const r = await bw.send('Target.createTarget', { url, background: true }, 15000);
      const targetId = r.targetId;
      for (let i = 0; i < 30 && targetId; i++) {
        const list = await fetchJson(`http://127.0.0.1:${port}/json/list`, 3000);
        const t = (list || []).find((x) => x.id === targetId && x.webSocketDebuggerUrl);
        if (t) { target = t; break; }
        await sleep(200);
      }
    } catch {
      target = null;
    } finally {
      try { bw?.close(); } catch {}
    }
  }

  if (!target) {
    // 兜底：老接口会激活标签，但至少能跑
    const r = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
      .catch(() => null);
    if (!r || !r.ok) throw new Error(`创建标签页失败（端口 ${port} 无响应，浏览器可能未启动 / 已崩溃）`);
    target = await r.json();
  }

  const cdp = await CDP.open(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  // 后台标签若不声明活跃，抖音页面脚本不完整执行（报错与「风控」一模一样）
  try { await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch {}
  try { await cdp.send('Page.setWebLifecycleState', { state: 'active' }); } catch {}

  return { cdp, targetId: target.id };
}

/** 关闭标签页：HTTP 的 /json/close 会真正销毁 target */
export async function closeTab(port, targetId) {
  if (!targetId) return false;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/close/${targetId}`,
      { signal: AbortSignal.timeout(4000) });
    return r.ok;
  } catch { return false; }
}

/** 协议层关闭整个浏览器：最彻底，不留文件句柄 */
export async function browserClose(port, { timeoutMs = 8000 } = {}) {
  const ver = await probe(port, 1200);
  if (!ver?.webSocketDebuggerUrl) return false;
  let bw = null;
  try {
    bw = await CDP.open(ver.webSocketDebuggerUrl, { retries: 1, timeout: 6000 });
    await bw.send('Browser.close', {}, timeoutMs);
  } catch {
  } finally {
    try { bw?.close(); } catch {}
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await probe(port, 800))) return true;
    await sleep(300);
  }
  // 协议关不掉（极少见）→ 退化为杀进程树
  const pid = pidOnPort(port);
  if (pid) killTree(pid);
  return !(await probe(port, 800));
}

/**
 * 可安全删除的 profile 子目录（保留 Cookies / Login Data / Preferences）
 *
 * BrowserMetrics 是膨胀真凶：实测单目录 248MB，全是崩溃与性能指标日志，
 * 删了 Chrome 会自己重建，与登录态无关。只盯 Cache 会一直清不下来。
 */
const CACHE_DIRS = [
  'BrowserMetrics',
  'optimization_guide_model_store',
  'Safe Browsing',
  'component_crx_cache',
  'Default/Cache',
  'Default/Code Cache',
  'Default/GPUCache',
  'Default/DawnGraphiteCache',
  'Default/DawnWebGPUCache',
  'Default/Service Worker/CacheStorage',
  'Default/Media Cache',
  'GrShaderCache',
  'ShaderCache',
  'GraphiteDawnCache',
];

/**
 * profile 体积治理。必须在浏览器已关闭时调用（否则文件被占用，删了也白删）。
 *
 * 体积口径排除 BrowserMetrics：它是 Chrome 预分配的指标文件（实测恒定 ~256MB），
 * 不代表真实增长；按总量判断会导致每轮都「超阈值」，清了个寂寞。
 *
 * @param {boolean} reset  true = 整目录删除（只对可丢弃的抓取 profile 用）
 */
export async function sweep({
  port, profile, maxMB = 300, reset = false, retries = 3, log = true,
} = {}) {
  const dir = path.resolve(expand(profile));
  if (!fs.existsSync(dir)) return { before: 0, after: 0, raw: 0, rounds: 0, skipped: true };

  const before = sizeMB(dir, ['BrowserMetrics']);
  const raw = sizeMB(dir);
  if (before <= maxMB) return { before, after: before, raw, rounds: 0, skipped: true };

  let after = before;
  let rounds = 0;
  for (; rounds < retries; rounds++) {
    if (port) await browserClose(port, { timeoutMs: 6000 });
    await sleep(1200);

    if (reset) {
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {}
    } else {
      for (const sub of CACHE_DIRS) {
        try { fs.rmSync(path.join(dir, sub), { recursive: true, force: true, maxRetries: 2 }); } catch {}
      }
    }

    after = sizeMB(dir, ['BrowserMetrics']);
    if (after <= maxMB) break;
  }

  // 清完还超标，说明增长的不是缓存：给出可执行建议，不要假装成功
  if (log) {
    const ok = after <= maxMB;
    console.log(`[profile] 有效体积 ${before}MB → ${after}MB（总 ${raw}MB，已排除 BrowserMetrics）${ok ? '' : `，仍超 ${maxMB}MB；${reset ? '建议检查磁盘' : '可设 DY_PROFILE_RESET=1 整目录重建'}`}`);
  }
  return { before, after, raw, rounds: rounds + 1, deleted: reset ? 'all' : 'cache' };
}

/** 关闭 + 治理 + 重拉（长跑时每 N 个账号调用一次） */
export async function restart(opts = {}) {
  const { port, profile, maxMB = 300, reset = false } = opts;
  await browserClose(port, { timeoutMs: 6000 });
  await sleep(1500);
  await sweep({ ...opts, maxMB, reset });
  return ensure(opts);
}

/** 一行可观测日志：出问题时一眼看出第几个开始劣化 */
export function stats({ tag = 'stats', account = null, elapsed = null, profileMB = null, posts = null, top = null, extra = '' } = {}) {
  const parts = [];
  if (account != null) parts.push(`account=${account}`);
  if (elapsed != null) parts.push(`elapsed=${Math.round(elapsed)}s`);
  if (profileMB != null) parts.push(`profile_mb=${profileMB}`);
  if (posts != null) parts.push(`posts=${posts}`);
  if (top != null) parts.push(`top=${top}`);
  if (extra) parts.push(extra);
  console.log(`[${tag}] ${parts.join(' ')}`);
}

/** 当前 page 数量（验收用：应稳定在个位数） */
export async function pageCount(port) {
  const list = await fetchJson(`http://127.0.0.1:${port}/json/list`, 3000);
  return (list || []).filter((t) => t.type === 'page').length;
}
