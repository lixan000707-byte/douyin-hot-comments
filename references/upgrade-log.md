# 升级记录

## 2.0.3 — 2026-11-11（试跑暴露的 3 个问题）

| # | 现象 | 真因 | 修复 |
|---|---|---|---|
| 1 | `keyword` 报 `[FATAL] killChrome is not defined` | 2.0 把启动逻辑移到 lib 后，`dy_search` 正常路径还留着一处旧调用 | 改为 `closeTab(PORT, targetId)` |
| 2 | `xlsx` 直接跑报 `FileNotFoundError: index_all.json` | Excel 依赖 `index` 子命令的产物，但文档写的是「report && xlsx」 | `xlsx` 前自动补建索引，缺什么自己补 |
| 3 | 搜索页正常但 search 接口 0 个响应 | 登录 profile 里只剩 `passport_csrf_token`，**没有 `sessionid`/`sid_tt`** —— 登录态失效，不是技能问题 | 文档补一条：`SILENT_THROTTLE` 先查 cookie 再怀疑风控 |
| 4 | 「评论抓取 5 条」被误读成「只抓到 5 条评价」 | 5 其实是**视频数**（`--top 5`），评价是 3830 条一级评论 | 文案改为「候选 46 条视频 → 抓取 5 条视频的评论 / 经过 3830 条一级评论 / 展示 TOP 100 条」；报告卡片「评论抓取」改「抓取视频」 |

同批调整：评论端口独立为 **9335**（`DY_PORT_COMMENT`），与搜索 9333、达人 9334 彻底分开。
三个用途原先共用一个端口，先退出的浏览器没关干净时，后一个会复用到错误 profile 的实例。

## 2.0.2 — 2026-11-11（补齐复检机制 + 全检修 5 个 bug）

### 新增

| 能力 | 文件 | 作用 |
|---|---|---|
| 字段校验 | `scripts/validate.mjs` | 按 schema 校验字段名/类型/毫秒时间戳/null 规则/cid 唯一 |
| 静态门禁 | `scripts/ci_check.mjs` | frontmatter/文件/语法/平台收口，不需要浏览器，CI 同款 |
| 基线对比 | `scripts/smoke.mjs` | 与上次验收比条数与 cid，掉 >20% 直接红 |
| CI | `.github/workflows/validate.yml` | push/PR 跑静态门禁 + 单测 + 方案自检 |
| 分发文件 | `LICENSE` `README.md` `.gitignore` | 上 Git 的必备件 |

### 全检发现的 bug

| # | 现象 | 真因 | 修复 |
|---|---|---|---|
| 1 | 同一视频连抓 3 次，第 3 次评论接口报错 | 验收脚本自己违反「单视频最多 2 次」，把配额烧完 | smoke 改为单次 `--verify`（内置两遍），不再外套多轮 |
| 2 | 达人偶发 0 条，粉丝却有值 | 作品接口 0 次请求：页签文本是「作品 128」，旧正则 `^(作品\|Works)\s*\d*$` 匹配不上；reload 后也没重点页签 | 前缀匹配 + 真实滚轮事件 + reload 后重新点；连测 **8/8 成功** |
| 3 | 达人抓 0 但 top 正常 | 评论用 work profile、达人用登录 profile，共用 9333 会复用错实例 | 达人默认端口 **9334**（`DY_PORT_ACCOUNT`） |
| 4 | 校验器放过「10/20 条指标全 0」 | 阈值写成 `> 0.5`，正好等于时不触发 | 改为 `≥30% 且 ≥5 条` 判错，单条只提示 |
| 5 | `hasMore` 类型不一致风险 | 历史数据是 `0/1`，规范示例写 `true` | 校验器两种都接受，但拒绝字符串 |

### 验收基线

| 项 | 结果 |
|---|---|
| 静态门禁 | 12/12 |
| 判定单测 | 14/14 |
| 方案自检 | 9/9 |
| 环境自检 | 11/11 |
| 字段校验（真实产物 + 4 个坏样本） | 真实 0 错 0 警；坏样本 4/4 抓出 |
| 达人连抓 | 8/8 成功，20 条，6.3–19.3s |

## 2.0.1 — 2026-11-11（同日修正三处判断）

| # | 原判断 | 实测结果 | 修正 |
|---|---|---|---|
| 1 | 评论抓取沿用登录 profile，怕未登录翻 20 页撞登录墙 | 空 profile 抓到 **271 条 / 6 页 / hasMore=0**，与登录态完全一致；B 机跑批说明也写着「评论层免登录可用」 | `dy_scrape` 默认改 `workProfile()`，超阈值整目录重建，不碰 Cookie |
| 2 | 首屏等待 8s 够用 | 全新 profile 首次访问要 15–20s，第一次必失败 | 等待上限 8s → 18.75s；空 profile 首跑实测 47.3s 成功 |
| 3 | 0 结果一律提示「登录态失效或风控降级」 | 假 sec_uid 的页面正文只有 526 字，报登录问题会带偏 | 先看正文长度：<1200 字判「账号失效 / 私域 / 被降级」 |

### 长跑证据（不是"未验证"）

| 来源 | 数据 |
|---|---|
| A 机历史 | 459/462 账号，9,302 条作品，字段零缺失 |
| B 机历史 | 222 人评论层；第 49 个（H289）起连败 61 个，profile 416MB；改每 10 个 `Browser.close` 后不复现 |
| 本次实测 | 12 账号 **12/12 成功**，180s；第 6 个后 restart，profile **219MB → 140MB** |
| 熔断实测 | 6 个假 sec_uid，第 5 个失败后停止，第 6 个未执行 |

## 2.0.0 — 2026-11-11

### 为什么改

原技能只覆盖「视频 + 评价」，缺「达人主页」这一半；
且 4 个脚本各写一套 Chrome 启动/关闭/profile 逻辑，换台电脑就在某个分支崩。
本次按 Agent Skills 规范（name/description 限额、scripts·references·assets 分层、
渐进式披露）重构，并吸收 18 条长跑故障档案的通用部分。

### 结构变更

| 变更 | 说明 |
|---|---|
| 新增 `lib/platform.mjs` | 唯一平台判断：找浏览器 / 杀进程树 / 查端口 / 磁盘 / 窗口坐标 |
| 新增 `lib/paths.mjs` | 路径展开与 profile 推导，配置里不再出现绝对路径 |
| 新增 `lib/cdp.mjs` | CDP 协议 + `sniff()`（在 `loadingFinished` 取 body） |
| 新增 `lib/chrome.mjs` | 浏览器生命周期 + `sweep()` profile 治理 + `stats()` 日志 |
| 6 个脚本改调用 lib | `dy_scrape` / `dy_search` / `dy_find_hot` / `dy_login` / `healthcheck` / `run.mjs` |
| `templates/` → `assets/` | 报告样式归入输出资产 |
| 新增 `scripts/dy_account.mjs` | **补齐达人层**：主页资料 + 作品列表 + 每条指标 |
| 新增 `scripts/smoke.mjs` | 内建验收（原来在包外，且指向不存在的文件） |
| SKILL.md 瘦身 | 313 行 → 约 230 行，阈值/台账/字段外移到 references |

### 问题修复对照

| 档案编号 | 问题 | 状态 |
|---|---|---|
| A02 | headless 被降级 / 窗口挡屏 | 已修：默认有头 + 窗口移出屏幕 |
| A03 | 标签页泄漏 | 已修：统一 `Target` 关闭（原 `/json/close` 保留为兜底） |
| A04 | profile 膨胀导致连片失败 | 已修：`sweep()` + 每 N 个 `restart()`；只清缓存保 Cookie |
| A05 | 图文用 `/video/` 打不开 | 已修：纯数字 ID 按 `/video/` → `/note/` 回退 |
| A07 | 第二次抓同一账号 0 条 | 已修：禁缓存 + `reload{ignoreCache}` 兜底 |
| A09 | 后台标签 JS 不跑 | 已修：`setFocusEmulationEnabled` + `setWebLifecycleState` |
| A10 | 采集时抢焦点 | 已修：后台建标签 + 窗口移出屏幕 |
| A11 | 昵称变更被误判中止 | 已修：降级为 `identityCheck.warning` |
| A12 | 评论/账号层无熔断 | 已修：`account --breaker 5` |
| A13 | 换端口导致反复冷启 | 保持固定 9333；新增「端口占用但 CDP 不通 → 清进程重拉」 |
| A14 | 错误只记版本号 | 已修：完整堆栈写 `_errors/<secUid>.log`，控制台留摘要 |
| A16 | 无预检 | 已修：`health` 扩到 10 项（端口/profile 体积/磁盘/图形界面） |
| A01 / A06 / A08 / A15 / A17 / A18 | 账号层或外部批处理专有 | 不适用（A01 的正确写法已在 `lib/cdp.mjs`） |

### 实测基线（本机 Windows / Node 22.22 / Chrome 156）

| 项 | 结果 |
|---|---|
| 达人单账号 | 20 条作品，粉丝 1726，4.5–9s |
| 视频 + 评论 | 271 条一级评论，6 页，17.3s |
| profile 有效体积 | 519MB → 315MB（清 BrowserMetrics 后），运行中 ~99MB |

### 已知坑（写进代码注释）

- `BrowserMetrics` 是 Chrome 预分配的指标文件（实测 248–256MB），删了会重建；
  体积判断必须排除它，否则每轮都「超阈值」，清了个寂寞
- Chrome 新版 Cookie 在 `Default/Network/Cookies`，老版在 `Default/Cookies`；
  预检两个都要认，否则明明登录了还报「未登录」
- `dy_login.mjs` 原来引用未定义的 `DATA_ROOT`，一跑就 `ReferenceError`（已修）
