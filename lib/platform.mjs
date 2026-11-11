/**
 * platform.mjs — 全技能唯一允许出现平台判断的地方
 *
 * 设计原则
 *   1. 其它任何文件禁止写 process.platform
 *   2. 所有外部命令都必须带 timeout，失败一律返回 null/false，绝不抛给调用方
 *   3. 不用 PowerShell（换机后可能被策略拦、且只存在于 Windows）
 *
 * 平台差异只体现在这里：找浏览器、杀进程树、查端口占用、磁盘剩余、窗口移屏。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const IS_WIN = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';
export const IS_LINUX = process.platform === 'linux';
export const PLATFORM = IS_WIN ? 'windows' : IS_MAC ? 'macos' : IS_LINUX ? 'linux' : process.platform;

/** 子进程是否需要独立进程组（posix 下才能整组杀掉） */
export const SPAWN_DETACHED = !IS_WIN;

const exists = (p) => { try { return !!p && fs.existsSync(p); } catch { return false; } };

function which(cmd) {
  const bin = IS_WIN ? 'where' : 'which';
  const r = spawnSync(bin, [cmd], { encoding: 'utf8', timeout: 6000 });
  if (r.status !== 0) return null;
  const line = (r.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
  return line && exists(line) ? line : null;
}

// ---------- 浏览器 ----------
const BROWSER_CANDIDATES = [
  // Windows
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Microsoft/Edge/Application/msedge.exe'),
  // macOS
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  // Linux
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/usr/bin/microsoft-edge',
];

const PATH_NAMES = IS_WIN
  ? ['chrome.exe', 'msedge.exe']
  : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'];

let _browser = null;

/** 返回浏览器可执行文件绝对路径；找不到返回 null（不抛异常） */
export function findBrowser() {
  if (_browser) return _browser;
  const env = process.env.DY_CHROME || process.env.CHROME_PATH;
  if (env && exists(env)) return (_browser = env);
  for (const p of BROWSER_CANDIDATES) if (exists(p)) return (_browser = p);
  for (const name of PATH_NAMES) {
    const p = which(name);
    if (p) return (_browser = p);
  }
  return null;
}

/** 浏览器品牌标识，用于报告和 doctor */
export function browserBrand(exe) {
  if (!exe) return 'none';
  const b = path.basename(exe).toLowerCase();
  if (b.includes('edge')) return 'edge';
  if (b.includes('chromium')) return 'chromium';
  return 'chrome';
}

// ---------- 进程 ----------
/** 杀掉整个进程树。Windows 必须 /T，否则渲染子进程残留。 */
export function killTree(pid) {
  const n = Number(pid);
  if (!n || n < 1) return false;
  try {
    if (IS_WIN) {
      const r = spawnSync('taskkill', ['/PID', String(n), '/T', '/F'], { stdio: 'ignore', timeout: 8000 });
      return r.status === 0;
    }
    // posix：子进程必须以 detached 启动，才有独立进程组可杀
    try { process.kill(-n, 'SIGKILL'); return true; } catch {}
    try { process.kill(n, 'SIGKILL'); return true; } catch {}
    return false;
  } catch { return false; }
}

/** 查监听某端口的进程 PID；查不到返回 null（不是 0，0 会被误当成合法 pid） */
export function pidOnPort(port) {
  const p = Number(port);
  if (!p) return null;
  try {
    if (IS_WIN) {
      const r = spawnSync('netstat', ['-ano'], { encoding: 'utf8', timeout: 12000 });
      if (r.status !== 0) return null;
      for (const line of (r.stdout || '').split(/\r?\n/)) {
        if (!line.includes('LISTENING')) continue;
        if (!new RegExp(`:${p}\\s`).test(line)) continue;
        const cols = line.trim().split(/\s+/);
        const pid = parseInt(cols[cols.length - 1], 10);
        if (pid > 0) return pid;
      }
      return null;
    }
    const r = spawnSync('lsof', ['-ti', `:${p}`], { encoding: 'utf8', timeout: 12000 });
    if (r.status !== 0) return null;
    const pid = parseInt((r.stdout || '').trim().split(/\s+/)[0], 10);
    return pid > 0 ? pid : null;
  } catch { return null; }
}

// ---------- 磁盘 ----------
/** 剩余空间 GB；读不到返回 null */
export function freeDiskGB(p) {
  try {
    const st = fs.statfsSync(p);
    return +((st.bavail * st.bsize) / 1024 ** 3).toFixed(1);
  } catch { return null; }
}

// ---------- 窗口 ----------
/**
 * 采集窗口坐标：移到可见桌面之外，用户看不见也不抢焦点。
 * macOS 允许更大的负坐标；Linux 需要 X11（Wayland 下可能被忽略）。
 */
export function offscreenPos() {
  if (IS_MAC) return '-3000,-3000';
  return '-2400,-2400';
}

/** Linux 无图形界面时，抖音会降级渲染导致抓 0 条 —— 提前告知，别让人白跑 */
export function displayAvailable() {
  if (IS_WIN || IS_MAC) return true;
  if (!IS_LINUX) return true;
  return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

// ---------- 杂项 ----------
export function openPath(p) {
  const cmd = IS_WIN ? 'explorer' : IS_MAC ? 'open' : 'xdg-open';
  try { spawnSync(cmd, [p], { stdio: 'ignore', timeout: 5000 }); } catch {}
}

export function platformSummary() {
  return `${PLATFORM} ${process.arch} · node ${process.versions.node}`;
}
