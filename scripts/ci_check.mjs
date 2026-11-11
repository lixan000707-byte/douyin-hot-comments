/**
 * ci_check.mjs — 静态门禁：不需要 Chrome、不需要网络、不需要登录
 *
 *   node scripts/ci_check.mjs
 *
 * 检查项
 *   1. SKILL.md 存在且 frontmatter 合法（name/description/必填字段）
 *   2. name 与目录同名、≤64、小写连字符；description ≤1024 且不含尖括号
 *   3. 必需文件齐全（入口 / lib / scripts / references / assets）
 *   4. 所有 .mjs 语法通过（node --check）
 *   5. SKILL.md 引用的 references 文件都存在
 *   6. 平台判断只在 lib/platform.mjs；其他文件不得出现 taskkill / Program Files
 *   7. config.json 不含绝对路径
 *   8. SKILL.md 正文 < 500 行（规范建议）
 *
 * 用途：GitHub Actions 的 push / PR 门禁，也可本地随时跑。
 * 退出码：0 通过 / 1 失败
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const rows = [];
const add = (ok, name, detail = '') => {
  rows.push({ ok, name, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  —  ' + detail : ''}`);
};

const read = (p) => { try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch { return null; } };
const has = (p) => fs.existsSync(path.join(ROOT, p));

// ---------- 1. SKILL.md + frontmatter ----------
const skill = read('SKILL.md');
if (!skill) {
  add(false, 'SKILL.md', '缺失');
  finish();
}

const fmMatch = skill.match(/^---\r?\n([\s\S]*?)\r?\n---/);
if (!fmMatch) add(false, 'frontmatter', '缺少 --- 包围的 YAML 头');
else {
  const fm = fmMatch[1];
  const nameM = fm.match(/^name:\s*(.+)$/m);
  const descM = fm.match(/^description:\s*(.+)$/m);
  const name = nameM ? nameM[1].trim().replace(/^['"]|['"]$/g, '') : '';
  const desc = descM ? descM[1].trim().replace(/^['"]|['"]$/g, '') : '';

  if (!name) add(false, 'frontmatter.name', '缺失');
  else {
    const dirName = path.basename(ROOT);
    const bad = [];
    if (name !== dirName) bad.push(`与目录名「${dirName}」不一致`);
    if (name.length > 64) bad.push('超过 64 字符');
    if (!/^[a-z0-9-]+$/.test(name)) bad.push('只能是数字/小写字母/连字符');
    if (/^-|-$|--/.test(name)) bad.push('不能首尾连字符或连续连字符');
    add(!bad.length, 'frontmatter.name', bad.length ? bad.join('；') : name);
  }

  if (!desc) add(false, 'frontmatter.description', '缺失');
  else {
    const bad = [];
    if (desc.length > 1024) bad.push(`长度 ${desc.length} > 1024`);
    if (/[<>]/.test(desc)) bad.push('含尖括号 < >');
    add(!bad.length, 'frontmatter.description', bad.length ? bad.join('；') : `${desc.length} 字符`);
  }

  for (const key of ['license', 'compatibility']) {
    const m = fm.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    add(!!m, `frontmatter.${key}`, m ? '已声明' : '建议补上（换机与分发时需要）');
  }
  const verM = fm.match(/version:\s*["']?([\d.]+)/);
  add(!!verM, 'frontmatter.metadata.version', verM ? verM[1] : '建议写版本号');
}

// ---------- 2. 必需文件 ----------
const REQUIRED = [
  'run.mjs', 'config.json',
  'lib/platform.mjs', 'lib/paths.mjs', 'lib/cdp.mjs', 'lib/chrome.mjs',
  'lib/depth_judge.mjs', 'lib/quality.mjs', 'lib/test_depth_judge.mjs',
  'scripts/dy_scrape.mjs', 'scripts/dy_top.mjs', 'scripts/dy_account.mjs',
  'scripts/dy_search.mjs', 'scripts/dy_find_hot.mjs', 'scripts/dy_login.mjs',
  'scripts/dy_pipeline.mjs', 'scripts/healthcheck.mjs', 'scripts/smoke.mjs',
  'scripts/validate.mjs', 'scripts/audit_scheme.mjs',
  'references/scheme.md', 'references/tiers.md', 'references/schema.md',
  'references/ledger.md', 'references/troubleshooting.md',
  'references/portability.md', 'references/upgrade-log.md',
];
const missing = REQUIRED.filter((f) => !has(f));
add(!missing.length, '必需文件', missing.length ? `缺 ${missing.join(', ')}` : `${REQUIRED.length} 个齐全`);

// ---------- 3. 语法 ----------
const walk = (dir, out = []) => {
  let ents = [];
  try { ents = fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', 'dy_output', '.git', 'assets'].includes(e.name)) continue;
      walk(rel, out);
    } else if (/\.(mjs|js)$/.test(e.name)) out.push(rel);
  }
  return out;
};
const jsFiles = walk('.').map((p) => p.replace(/^\.\//, ''));
let syntaxBad = [];
for (const f of jsFiles) {
  const r = spawnSync(process.execPath, ['--check', path.join(ROOT, f)], { encoding: 'utf8' });
  if (r.status !== 0) syntaxBad.push(f);
}
add(!syntaxBad.length, `语法检查（${jsFiles.length} 个文件）`, syntaxBad.join(', '));

// ---------- 4. 文档引用 ----------
const refs = [...skill.matchAll(/\]\((references\/[^)]+)\)/g)].map((m) => m[1]);
const refMissing = [...new Set(refs)].filter((p) => !has(p));
add(!refMissing.length, 'SKILL.md 文档引用', refMissing.length ? `缺 ${refMissing.join(', ')}` : `${new Set(refs).size} 个引用均存在`);

// ---------- 5. 平台判断收口 ----------
const ownPlatform = [];
const hardcoded = [];
for (const f of jsFiles) {
  if (f.endsWith('lib/platform.mjs') || f.endsWith('ci_check.mjs')) continue;
  const src = read(f) || '';
  if (/process\.platform/.test(src)) ownPlatform.push(f);
  // Windows 专属命令行：只允许出现在 platform.mjs
  if (/taskkill/i.test(src) || /Program Files\/Google/.test(src)) hardcoded.push(f);
}
add(!ownPlatform.length, '平台判断收口', ownPlatform.length ? `这些文件直接用了 process.platform：${ownPlatform.join(', ')}` : '只在 lib/platform.mjs');
add(!hardcoded.length, '无 Windows 硬编码', hardcoded.length ? hardcoded.join(', ') : '未发现 taskkill / 固定安装路径');

// ---------- 6. config 不含绝对路径 ----------
try {
  const cfg = JSON.parse(read('config.json') || '{}');
  const flat = JSON.stringify(cfg);
  const abs = /"[A-Za-z]:[\\/]|"\/Users\/|"\/home\//.test(flat);
  add(!abs, 'config.json 不含绝对路径', abs ? '把路径改成相对或交给 lib/paths.mjs' : 'OK');
} catch (e) {
  add(false, 'config.json', '解析失败：' + e.message);
}

// ---------- 7. SKILL.md 行数 ----------
const lines = skill.split('\n').length;
add(lines < 500, 'SKILL.md 行数 <500', `${lines} 行`);

finish();

function finish() {
  const fail = rows.filter((r) => !r.ok).length;
  console.log('\n' + '='.repeat(64));
  console.log(`静态门禁：${rows.length - fail}/${rows.length} 通过`);
  if (fail) {
    console.log('\n未通过：');
    for (const r of rows.filter((x) => !x.ok)) console.log(`  · ${r.name} — ${r.detail}`);
  }
  console.log('='.repeat(64));
  process.exit(fail ? 1 : 0);
}
