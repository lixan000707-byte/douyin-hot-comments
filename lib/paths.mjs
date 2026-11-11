/**
 * paths.mjs — 路径解析（跨平台）
 *
 * 目标：配置里不出现任何绝对路径；所有目录都由这里推导。
 *   - `~` / `%VAR%` / `$VAR` 统一展开
 *   - 登录 profile 与抓取 profile 分离：前者保 cookie，后者可整删
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir() || '.';
}

/** 展开 ~、%APPDATA%、$HOME、${HOME}；非字符串原样返回 */
export function expand(p) {
  if (typeof p !== 'string' || !p) return p;
  let s = p;
  if (s === '~') s = homeDir();
  else if (s.startsWith('~/') || s.startsWith('~\\')) s = path.join(homeDir(), s.slice(2));
  s = s.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, k) => process.env[k] ?? m);
  s = s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (m, a, b) => process.env[a || b] ?? m);
  return s;
}

export function ensureDir(dir) {
  const abs = path.resolve(expand(dir));
  fs.mkdirSync(abs, { recursive: true });
  return abs;
}

/** WorkBuddy 全局缓存目录（各平台一致，都在用户目录下的 .workbuddy） */
export function cacheDir() {
  return path.join(homeDir(), '.workbuddy', 'cache');
}

/** 登录 profile：带 cookie，绝不能整删（删了就要重新扫码） */
export function loginProfile() {
  const env = process.env.DY_PROFILE || process.env.DY_PROFILE_DIR;
  if (env) return path.resolve(expand(env));
  return path.join(cacheDir(), 'dy-scrape-profile');
}

/**
 * 抓取 profile：评论/达人抓取不需要登录态时用它。
 * 单独目录的意义：可以整目录删掉重建，不伤登录态。
 * 若调用方显式指定 DY_PROFILE，则沿用那个目录（保持与外部批处理兼容）。
 */
export function workProfile() {
  const env = process.env.DY_WORK_PROFILE;
  if (env) return path.resolve(expand(env));
  const base = loginProfile();
  return base.endsWith('-work') ? base : `${base}-work`;
}

/** 产物目录：DY_DATA_DIR > 当前工作目录/dy_output */
export function dataDir(cwd = process.cwd()) {
  return path.resolve(expand(process.env.DY_DATA_DIR || path.join(cwd, 'dy_output')));
}

/** 技能内资源路径 */
export function skillPath(...parts) {
  return path.join(SKILL_ROOT, ...parts);
}

/**
 * 目录体积（MB，保留 1 位）；读不到返回 0
 * @param {string[]} excludeTop 顶层目录名黑名单（如 BrowserMetrics 是预分配文件，不代表真实增长）
 */
export function sizeMB(dir, excludeTop = []) {
  const skip = new Set(excludeTop);
  let total = 0;
  const walk = (d, depth) => {
    if (depth > 6) return;
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (depth === 0 && e.isDirectory() && skip.has(e.name)) continue;
      const fp = path.join(d, e.name);
      try {
        if (e.isDirectory()) walk(fp, depth + 1);
        else if (e.isFile()) total += fs.statSync(fp).size;
      } catch {}
    }
  };
  walk(path.resolve(expand(dir)), 0);
  return +(total / 1024 / 1024).toFixed(1);
}
