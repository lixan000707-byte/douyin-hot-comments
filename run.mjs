#!/usr/bin/env node
/**
 * 抖音抓取技能 · 统一入口
 *
 *   node run.mjs <子命令> [参数...]
 *
 * 子命令：
 *   keyword <词>        关键词 → TOP视频 → 评价 → 报告       (dy_pipeline keyword)
 *   hot                 首页推荐流 → 评价 → 报告              (dy_pipeline hot)
 *   tier                按点赞区间分层抽样抓取                (dy_tiered_scrape)
 *   library             按关键词批量建库（断点续抓）           (dy_build_library)
 *   top <id...>         指定 videoId 抓评价（支持 --verify）   (dy_top)
 *   search <词>         只搜索，不抓评价                      (dy_search)
 *   batch <词...>       多关键词批量搜索                      (dy_search_batch)
 *   login               扫码登录（长驻窗口）                   (dy_login)
 *   report              生成报告（小红书样式，折叠式）         (gen_report_xhs_style)
 *   report2             生成报告（分组样式）                  (gen_result_html)
 *   xlsx                生成 Excel（5 表）                    (gen_result_xlsx.py)
 *   ledger <json...>    追加式台账                            (gen_ledger.py)
 *   index               重建总索引 + 评论明细                  (dy_rebuild_index)
 *   stats               按视频区间的评价分布统计               (dy_range_stats)
 *   validate <json...>  校验产物字段是否符合数据规范           (validate)
 *   health              环境自检（11 项）                     (healthcheck)
 *   audit               方案自检（检查方案与代码一致性）        (audit_scheme)
 *   smoke               真实抓取验收（三类数据 + 基线对比）      (smoke)
 *   check               静态门禁（CI 同款，不需要浏览器）        (ci_check)
 *
 * 产物统一落在「当前工作目录/dy_output/」；可用 DY_DATA_DIR 覆盖。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser } from './lib/platform.mjs';
import { loginProfile } from './lib/paths.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.join(__dir, 'scripts');
const LIB = path.join(__dir, 'lib');

const ROUTES = {
  keyword: { script: 'dy_pipeline.mjs', pre: ['keyword'] },
  hot: { script: 'dy_pipeline.mjs', pre: ['hot'] },
  tier: { script: 'dy_tiered_scrape.mjs' },
  library: { script: 'dy_build_library.mjs' },
  top: { script: 'dy_top.mjs' },
  account: { script: 'dy_account.mjs' },
  search: { script: 'dy_search.mjs' },
  batch: { script: 'dy_search_batch.mjs' },
  login: { script: 'dy_login.mjs' },
  report: { script: 'gen_report_xhs_style.mjs' },
  report2: { script: 'gen_result_html.mjs' },
  xlsx: { script: 'gen_result_xlsx.py', py: true },
  ledger: { script: 'gen_ledger.py', py: true },
  index: { script: 'dy_rebuild_index.mjs', pre: ['--comments-csv'] },
  stats: { script: 'dy_range_stats.mjs' },
  health: { script: 'healthcheck.mjs' },
  audit: { script: 'audit_scheme.mjs' },
  smoke: { script: 'smoke.mjs' },
  validate: { script: 'validate.mjs' },
  check: { script: 'ci_check.mjs' },
};

const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1);

function help() {
  console.log(`抖音抓取技能 · 统一入口

用法：node run.mjs <子命令> [参数...]

抓取类：
  keyword <词> [--top 6] [--n 20]     关键词 → 视频 → 评价 → 报告
  hot [--top 6] [--n 20]              首页热门 → 评价 → 报告
  tier --keywords A B --tier "0,5000,5"  按点赞区间分层抽样
  library --keywords A B --top 10     按词批量建库（断点续抓）
  top <id...> [--n 20] [--verify]     指定视频抓评价（--verify 抓两遍复检）
  account <secUid...> [--pages 8]     达人主页：资料 + 作品列表 + 每条指标
  search <词> [--scroll 14]           只搜索
  batch <词...> [--cooldown 45]       多关键词批量搜索
  login [--minutes 25]                扫码登录

产出类：
  report                              报告（小红书样式）
  report2                             报告（分组样式）
  xlsx                                Excel（5 个 sheet）
  ledger <json...>                    追加台账
  index                               重建总索引 + 评论明细
  stats                               按视频区间的评价分布
  validate <json...>                  校验产物字段是否符合数据规范

自检类：
  health                              环境自检（11 项）
  audit                               方案自检（方案 vs 代码一致性）
  smoke [--rounds 3]                  真实抓取验收（视频/评价/达人 + 基线对比）
  check                               静态门禁（frontmatter/文件/语法/平台收口，CI 同款）

产物目录：./dy_output/    可用 DY_DATA_DIR 覆盖

示例：
  node run.mjs keyword "牛仔裤" --top 6
  node run.mjs tier --keywords 女裤 裤子 --tier "0,5000,5" --merge --random
  node run.mjs top 7612479763365754993 --verify
  node run.mjs health && node run.mjs audit
`);
}

if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') {
  help();
  process.exit(cmd ? 0 : 1);
}

const route = ROUTES[cmd];
if (!route) {
  console.error(`[FATAL] 未知子命令：${cmd}`);
  console.error(`        可用：${Object.keys(ROUTES).join(' / ')}`);
  console.error(`        查看帮助：node run.mjs help`);
  process.exit(1);
}

const scriptPath = path.join(SCRIPTS, route.script);
if (!fs.existsSync(scriptPath)) {
  console.error(`[FATAL] 脚本不存在：${scriptPath}`);
  console.error('        技能包可能不完整，请重新安装');
  process.exit(4);
}

// ── 启动预检：换电脑后能立刻知道缺什么 ──
const NEED_LOGIN = ['keyword', 'search', 'batch', 'library', 'tier', 'account'];
const PROFILE = process.env.DY_PROFILE || loginProfile();

function preflight() {
  const fatal = [];
  const warn = [];

  // Node 版本（内置 WebSocket 需要 ≥22）
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < 22) {
    fatal.push(`Node ${process.versions.node} 版本过低 —— 内置 WebSocket 需要 Node ≥ 22`);
  }

  // Chrome
  const chrome = findBrowser();
  if (!chrome) {
    fatal.push('未找到 Chrome/Edge —— 可用 DY_CHROME=/path/to/chrome 指定\n     macOS 默认 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n     Linux 默认 /usr/bin/google-chrome');
  }

  // 登录态（搜索/达人主页需要）。Chrome 新版 Cookie 在 Default/Network/ 下，老版在 Default/。
  const hasCookies = ['Default/Network/Cookies', 'Default/Cookies', 'Network/Cookies', 'Cookies'].some(f => {
    try { return fs.existsSync(path.join(PROFILE, f)); } catch { return false; }
  });
  if (NEED_LOGIN.includes(cmd) && !hasCookies) {
    fatal.push(`未登录（profile 不存在：${PROFILE}）
     搜索类命令必须先登录，否则必弹验证码。
     　　　先扫码：node run.mjs login
     　　　只想抓已知视频（不需要登录）：node run.mjs top <videoId>`);
  }

  return { fatal, warn, chrome, hasCookies };
}

const pf = preflight();
if (pf.fatal.length) {
  console.error('❌ 环境不满足，无法执行：');
  pf.fatal.forEach(f => console.error('   · ' + f));
  console.error('\n修复后再试。完整检查：node run.mjs health');
  process.exit(4);
}
if (pf.warn.length) {
  console.warn('⚠️  注意：');
  pf.warn.forEach(w => console.warn('   · ' + w));
  console.warn('');
}

let runtime = process.execPath;
if (route.py) {
  const candidates = ['python', 'python3', 'py'];
  const found = candidates.find(c => {
    const r = spawnSync(c, ['--version'], { encoding: 'utf8', timeout: 10000 });
    return r.status === 0;
  });
  if (!found) {
    console.error('[FATAL] 找不到 Python 解释器（xlsx / ledger 子命令需要 openpyxl）');
    console.error('        安装：pip install openpyxl');
    process.exit(4);
  }
  runtime = found;
}

// 产物目录：cwd/dy_output（不落在技能目录）
const dataDir = process.env.DY_DATA_DIR || path.join(process.cwd(), 'dy_output');
fs.mkdirSync(dataDir, { recursive: true });

// 在技能目录内执行时提醒（产物会写进技能目录，不符合设计意图）
{
  const cwdAbs = path.resolve(process.cwd());
  const skillAbs = path.resolve(__dir);
  if (cwdAbs === skillAbs || cwdAbs.startsWith(skillAbs + path.sep)) {
    console.warn('⚠️  当前在技能目录内执行');
    console.warn(`    产物会写入：${dataDir}`);
    console.warn('    建议先切到你的项目工作区再执行，例如：');
    console.warn('       cd /path/to/your-project');
    console.warn(`       node ${path.join(skillAbs, 'run.mjs')} ${cmd}`);
    console.warn('    或用 DY_DATA_DIR 指定产物目录。');
    console.warn('');
  }
}


// xlsx 依赖 index_all.json（由 index 子命令生成）。
// 用户刚跑完 keyword/hot 就想要 Excel 时，不该被一句 FileNotFoundError 拦住 —— 自动补建。
if (cmd === 'xlsx' && !fs.existsSync(path.join(dataDir, 'index_all.json'))) {
  console.log('[run] 未找到 index_all.json，先重建索引…');
  const rIdx = spawnSync(process.execPath,
    [path.join(SCRIPTS, 'dy_rebuild_index.mjs'), '--comments-csv'],
    { stdio: 'inherit', env: { ...process.env, DY_DATA_DIR: dataDir, DY_ROOT: process.env.DY_ROOT || process.cwd() }, cwd: process.cwd() });
  if (rIdx.status !== 0) {
    console.error('[FATAL] 重建索引失败，无法生成 Excel');
    process.exit(rIdx.status || 4);
  }
}

const args = [...(route.pre || []), ...rest, ...(route.py ? [] : [])];
const env = {
  ...process.env,
  DY_DATA_DIR: dataDir,
  // 让子脚本以 cwd 为根，产物落 dy_output
  DY_ROOT: process.env.DY_ROOT || process.cwd(),
};

console.log(`[run] ${cmd} → ${route.script}${route.py ? ' (python)' : ''}`);
console.log(`[run] 产物目录 ${dataDir}`);

const r = spawnSync(runtime, [scriptPath, ...args], {
  stdio: 'inherit',        // 不缓冲，实时看日志
  env,
  cwd: process.cwd(),      // 产物落当前工作区
});

// 退出码原样传递，定时任务才能感知失败
process.exit(r.status === null ? 1 : r.status);
