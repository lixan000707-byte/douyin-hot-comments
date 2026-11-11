/**
 * healthcheck.mjs — 换机第一件事：把环境说清楚，别让人靠猜
 *
 *   node healthcheck.mjs            # 静态检查（约 2 秒，不发网络请求）
 *   node healthcheck.mjs --strict   # 警告也算失败（打包/上线前用）
 *   node healthcheck.mjs --smoke    # 加一次真实冒烟抓取（约 10 秒）
 *
 * 检查项：语法 / 单测 / 浏览器 / 登录态 / 词级冷却 / 废弃脚本阻断 /
 *        端口占用 / profile 体积 / 磁盘 / 平台显示环境
 *
 * 退出码：0 全通过 / 3 有警告 / 4 有失败
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser, pidOnPort, freeDiskGB, displayAvailable, platformSummary } from '../lib/platform.mjs';
import { loginProfile, sizeMB } from '../lib/paths.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.DY_ROOT || process.cwd();
const DATA_ROOT = process.env.DY_DATA_DIR || path.join(ROOT, 'dy_output');
const LIB = path.join(__dir, '..', 'lib');
const SMOKE = process.argv.includes('--smoke');
const STRICT = process.argv.includes('--strict');

const results = [];
const add = (name, status, detail = '') => {
  results.push({ name, status, detail });
  const icon = status === 'PASS' ? '✅' : status === 'WARN' ? '⚠️ ' : '❌';
  console.log(`${icon} ${name}${detail ? '  —  ' + detail : ''}`);
};

console.log('='.repeat(70));
console.log('抖音抓取链路自检  ' + new Date().toLocaleString('zh-CN'));
console.log('平台：' + platformSummary());
console.log('='.repeat(70));

// ── 1. 语法检查
const scripts = [
  'dy_scrape.mjs', 'dy_top.mjs', 'dy_account.mjs', 'dy_search.mjs', 'dy_search_batch.mjs',
  'dy_pipeline.mjs', 'dy_tiered_scrape.mjs', 'dy_build_library.mjs',
  'dy_find_hot.mjs', 'dy_login.mjs', 'gen_report_xhs_style.mjs', 'gen_result_html.mjs',
  'dy_rebuild_index.mjs', 'dy_range_stats.mjs', 'audit_scheme.mjs', 'smoke.mjs',
];
let syntaxFail = 0;
for (const s of scripts) {
  const p = path.join(__dir, s);
  if (!fs.existsSync(p)) { add(`语法 ${s}`, 'WARN', '文件不存在'); continue; }
  const r = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' });
  if (r.status !== 0) { syntaxFail++; add(`语法 ${s}`, 'FAIL', (r.stderr || '').split('\n')[0]); }
}
for (const lf of ['platform.mjs', 'paths.mjs', 'cdp.mjs', 'chrome.mjs', 'depth_judge.mjs', 'quality.mjs']) {
  const p = path.join(LIB, lf);
  if (!fs.existsSync(p)) { add(`语法 lib/${lf}`, 'FAIL', '缺失'); syntaxFail++; continue; }
  const r = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' });
  if (r.status !== 0) { syntaxFail++; add(`语法 lib/${lf}`, 'FAIL', (r.stderr || '').split('\n')[0]); }
}
if (!syntaxFail) add(`语法检查（${scripts.length} 个脚本 + 6 个模块）`, 'PASS');

// ── 2. 单元测试
const testFile = path.join(LIB, 'test_depth_judge.mjs');
if (fs.existsSync(testFile)) {
  const r = spawnSync(process.execPath, [testFile], { encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/通过 (\d+) \/ 失败 (\d+)/);
  if (r.status === 0 && m) add('判定逻辑单元测试', 'PASS', `${m[1]} 例全通过`);
  else add('判定逻辑单元测试', 'FAIL', m ? `失败 ${m[2]} 例` : '执行异常');
} else add('判定逻辑单元测试', 'WARN', '测试文件缺失');

// ── 3. 浏览器
const chrome = findBrowser();
if (chrome) add('浏览器', 'PASS', chrome);
else add('浏览器', 'FAIL', '找不到 Chrome/Edge，请装 Chrome 或设 DY_CHROME');

// ── 4. 登录态
const profile = process.env.DY_PROFILE || loginProfile();
const cookieFiles = ['Default/Network/Cookies', 'Default/Cookies', 'Network/Cookies', 'Cookies'];
if (fs.existsSync(profile)) {
  const hit = cookieFiles.find(f => fs.existsSync(path.join(profile, f)));
  if (hit) add('登录态 profile', 'PASS', path.join(profile, hit));
  else add('登录态 profile', 'WARN', 'profile 存在但没找到 Cookies，可能未登录');
} else add('登录态 profile', 'WARN', '不存在，首次运行需 login 扫码');

// ── 5. 词级冷却
const cdFile = path.join(DATA_ROOT, '.kw_cooldown.json');
if (fs.existsSync(cdFile)) {
  try {
    const j = JSON.parse(fs.readFileSync(cdFile, 'utf8'));
    const now = Date.now();
    const cooling = Object.entries(j)
      .map(([k, t]) => ({ k, left: +(10 - (now - t) / 60000).toFixed(1) }))
      .filter(x => x.left > 0);
    if (cooling.length) add('词级冷却账本', 'WARN', cooling.map(x => `${x.k}(${x.left}分钟)`).join(' '));
    else add('词级冷却账本', 'PASS', '无词在冷却期');
  } catch { add('词级冷却账本', 'WARN', '文件损坏'); }
} else add('词级冷却账本', 'PASS', '尚无记录');

// ── 6. 废弃脚本阻断
for (const dead of ['dy_top_comments.mjs', 'dy_find_big.mjs']) {
  const p = path.join(__dir, dead);
  if (!fs.existsSync(p)) continue;
  const src = fs.readFileSync(p, 'utf8');
  if (/DY_ALLOW_DEPRECATED/.test(src)) add(`废弃阻断 ${dead}`, 'PASS', '已加运行时拦截');
  else add(`废弃阻断 ${dead}`, 'WARN', '未加拦截，可能被误用');
}

// ── 7. 端口占用（占用本身不是错，但要让人知道是谁）
for (const port of [9222, 9333, 9334, 9335]) {
  const pid = pidOnPort(port);
  if (pid) add(`端口 ${port}`, 'WARN', `被 pid ${pid} 占用（若是采集实例可复用；否则先关掉）`);
  else add(`端口 ${port}`, 'PASS', '空闲');
}

// ── 8. profile 体积（长跑连败的第一嫌疑）
for (const [label, dir] of [['登录 profile', profile], ['抓取 profile', `${profile}-work`]]) {
  if (!fs.existsSync(dir)) { add(label + ' 体积', 'PASS', '不存在（首跑会建）'); continue; }
  const mb = sizeMB(dir, ['BrowserMetrics']);
  add(label + ' 体积', mb < 300 ? 'PASS' : 'WARN', `${mb} MB（阈值 300，超了启动前会自动清缓存）`);
}

// ── 9. 磁盘
const free = freeDiskGB(process.cwd());
if (free == null) add('磁盘剩余', 'PASS', '读不到（跳过）');
else add('磁盘剩余', free > 2 ? 'PASS' : 'WARN', `${free} GB（${path.parse(process.cwd()).root}）`);

// ── 10. 平台显示环境
if (displayAvailable()) add('图形界面', 'PASS', '可用');
else add('图形界面', 'FAIL', '无 DISPLAY：抖音对 headless 降级渲染，本机会抓 0 条');

// ── 11. 冒烟（可选）
if (SMOKE) {
  console.log('\n[冒烟] 真实抓取一条视频的 TOP3 评论…');
  const smokeId = process.env.DY_SMOKE_ID || '7629701428957054053';
  const out = path.join(DATA_ROOT, 'dy_test', `_health_smoke_${Date.now()}.json`);
  const r = spawnSync(process.execPath, [
    path.join(__dir, 'dy_top.mjs'), smokeId, '--n', '3', '--pages', '10', '-o', out,
  ], { encoding: 'utf8' });
  const combined = (r.stdout || '') + (r.stderr || '');
  const m = combined.match(/抓取 (\d+) 条 \/ (\d+) 页 \/ ([\d.]+)s \/ 深度[^[]*\[(\w+)\]/);
  if (r.status === 0 && m) add('冒烟抓取', 'PASS', `${m[1]} 条/${m[2]} 页/${m[3]}s ${m[4]}`);
  else add('冒烟抓取', 'FAIL', `退出码 ${r.status}${m ? ' / ' + m[4] : ''}`);
  if (fs.existsSync(out)) fs.unlinkSync(out);
}

// ── 汇总
const fails = results.filter(r => r.status === 'FAIL').length;
const warns = results.filter(r => r.status === 'WARN').length;
console.log('\n' + '='.repeat(70));
console.log(`结果：通过 ${results.length - fails - warns} / 警告 ${warns} / 失败 ${fails}`);
if (fails) {
  console.log('\n失败项：');
  results.filter(r => r.status === 'FAIL').forEach(r => console.log('  · ' + r.name + ' — ' + r.detail));
}
if (warns) {
  console.log('\n警告项：');
  results.filter(r => r.status === 'WARN').forEach(r => console.log('  · ' + r.name + ' — ' + r.detail));
}
console.log('='.repeat(70));
process.exit(fails ? 4 : (warns && STRICT) ? 4 : warns ? 3 : 0);
