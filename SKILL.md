---
name: douyin-hot-comments
description: '抖音三类数据采集：视频指标、高赞评价、达人主页。支持关键词搜索、首页推荐流、点赞区间分层抽样、指定视频或账号直抓，按视频点赞量分 6 档设定评价门槛，并产出 HTML 报告、Excel 与追加式台账。适用于爆款内容调研、评论区分析、VOC 采集、达人盘点、选品参考。触发词：抖音评论、抖音高赞评价、抖音热门视频、抖音达人数据、抖音账号作品、抖音 VOC、douyin comments、douyin scrape。'
license: MIT
compatibility: '仅 Windows 10/11 实机验证（Node.js 22+、Chrome 或 Edge、需图形界面）。macOS/Linux 代码已做平台适配（lib/platform.mjs），但未实机验证，不承诺可用；无头 Linux 服务器不可用（抖音对 headless 降级渲染）。xlsx 与 ledger 子命令另需 Python 3 + openpyxl。'
metadata:
  version: "2.0.3"
  platforms: "windows (verified)"
agent_created: true
---

# 抖音数据采集：视频 / 评价 / 达人

## 能力边界

| 数据 | 命令 | 拿到什么 |
|---|---|---|
| **视频** | `keyword` / `hot` / `search` / `tier` | 视频 ID、文案、作者、点赞/评论/收藏/转发、发布时间、话题、BGM |
| **评价** | `top` / `keyword` / `hot` / `tier` | 点赞降序一级评论：cid、正文、点赞、地区、子回复数、时间；按 6 档门槛判达标 |
| **达人** | `account` | 昵称、抖音号、粉丝、总获赞、IP 属地、作品数 + 每条作品全指标 |

**不做**

- ❌ 播放量（网页端不公开，接口无 `play_count`）
- ❌ 子回复正文（只统计 `replyTotal`）
- ❌ 全量评论（只取点赞最高的前 N 条，覆盖率约 1.2%）
- ❌ 批量跑几十个关键词（搜索接口有词级限流，冷却 45 秒起）

## 三步上手

```bash
# ① 体检（缺什么它会直接说）
node run.mjs health

# ② 登录（只有搜索类与达人主页需要；profile 持久化，一次即可）
node run.mjs login

# ③ 开抓（产物落「当前工作目录/dy_output/」）
node run.mjs keyword "牛仔裤" --top 6
node run.mjs account MS4wLjABAAAA...
```

## 命令表

```bash
node run.mjs keyword "牛仔裤" --top 6        # 关键词 → TOP 视频 → 评价 → 报告
node run.mjs hot --top 6                     # 首页推荐流 → 评价 → 报告
node run.mjs top <videoId|url...> --verify   # 指定视频抓评价（两遍复检）
node run.mjs account <secUid|主页URL...>     # 达人主页：资料 + 作品列表
node run.mjs tier --keywords 女裤 裤子 --tier "0,5000,5" --merge --random
node run.mjs library --keywords A B --top 10 # 批量建库（断点续抓）
node run.mjs search <词>                     # 只搜索，不抓评价
node run.mjs batch <词...>                   # 多关键词批量搜索
node run.mjs login                           # 扫码登录

node run.mjs report && node run.mjs xlsx     # 报告 / Excel（xlsx 缺索引会自动补建）
node run.mjs ledger dy_output/xxx.json       # 追加台账
node run.mjs index && node run.mjs stats     # 总索引 / 区间统计
node run.mjs health && node run.mjs audit    # 自检
```

## 三类产物的字段

### 达人：`<secUid>_posts.json`

严格遵循跨机数据规范（`references/schema.md`）：

```json
{"at":"...","results":[{"ok":true,"secUid":"...","url":"...","author":"...",
  "err":null,"pages":3,"hasMore":true,"apiHits":1,"total":21,"source":"api",
  "profile":{"nickname":"...","douyinId":"...","fans":29034,
             "totalFavorited":3824403,"ipLocation":"湖南","awemeCount":296},
  "identityCheck":{"api":"...","page":"...","ok":true,"warning":null},
  "posts":[{"id":"...","desc":"...","createTime":1793797383,"isTop":0,
            "type":0,"digg":73,"comment":13,"collect":11,"share":5}],"sec":5.4}]}
```

- `createTime` 是 **epoch 秒**，不是字符串、不是毫秒
- 缺值写 `null`，**绝不写 0**（0 会参与统计，把中位数拉低）
- `hasMore` / `pages` / 首末 `createTime` 用于算覆盖窗口，不能删

### 视频 + 评价：`*_comments_<日期>.json`

`results[]` 一条视频，含 `stat.{digg,comment,collect,share}`、
`scraped.{rows,pages,hasMore,sec}`、`tierRule.{tier,minLike}`、
`qualifiedCount`、`top[]`（`rank/cid/like/text/name/ip/replyTotal/createTime/qualified`）。

`cid` 是全局唯一评论 ID，入库按它去重。

## 评价门槛（6 档）

| 视频点赞 | 评价最低赞 | 抓取条数 |
|---|---|---|
| < 5 千 | ≥ 5 | 10 |
| 5 千 – 1 万 | ≥ 10 | 15 |
| 1 万 – 5 万 | ≥ 20 | 20 |
| 5 万 – 10 万 | ≥ 50 | 20 |
| 10 万 – 50 万 | ≥ 100 | 20 |
| ≥ 50 万 | ≥ 500 | 20 |

**严格执行不降门槛**：达标几条取几条，没有就显示「该视频评论区没有 ≥X 赞的评价」。
完整判定逻辑见 [references/tiers.md](references/tiers.md)。

## 抓取深度

单次最多 20 页；`hasMore=1` 时重新加载视频页再抓一次；单视频最多 2 次
（`--verify` 时第二次用于复检）。详见 [references/tiers.md](references/tiers.md)。

## 验证与复检（改完代码按顺序跑）

| 层 | 命令 | 验什么 | 需要浏览器 |
|---|---|---|---|
| 静态门禁 | `node run.mjs check` | frontmatter / 文件齐全 / 语法 / 平台收口 | 否 |
| 判定单测 | `node lib/test_depth_judge.mjs` | 深度判定 14 例 | 否 |
| 方案自检 | `node run.mjs audit` | 脚本完整性 / 参数一致 / 调用链 / 产出路径 | 否 |
| 环境自检 | `node run.mjs health --strict` | 浏览器 / 登录态 / 端口 / profile / 磁盘 | 否 |
| 数据复检 | `node run.mjs top <id> --verify` | 同一视频两遍，达标 cid 重合 ≥70% | 是 |
| 端到端验收 | `node run.mjs smoke` | 三类数据 + 内置复检 + **基线对比** | 是 |
| 字段校验 | `node run.mjs validate <json...>` | 是否符合 `schema.md`（类型/毫秒/null 规则） | 否 |

**基线对比**（`smoke` 内建）：首跑在 `dy_output/_smoke/baseline.json` 建基线，
后续比对评论条数（掉 >20% 红）与 cid 集合（重合 <70% 红）。
确认新结果正常后执行 `node run.mjs smoke --update-baseline` 刷新。

**CI 只跑前三项**：真实抓取需要图形界面、登录态与稳定网络，抖音还会拦数据中心 IP。
工作流见 `.github/workflows/validate.yml`。

## 风控纪律

| 接口 | 约束 |
|---|---|
| 评论 + 视频详情 | 累计 2000+ 请求零拦截；批量勿超 3 并行 |
| 搜索 | 词间冷却 ≥45 秒；同词 10 分钟内不重抓；验证码后 ≥120 秒 |
| 静默限流 | 页面正常但接口一个请求都不发 → 结果 <30 条判 `EXIT_3` |

**登录边界**：`keyword` / `search` / `batch` / `tier` / `library` / `account` 必须登录；
`top` 与 `hot` 不需要。评论抓取走独立 work profile（`dy-scrape-profile-work`），
实测空 profile 抓到 271 条 / 6 页 / `hasMore=0`，与登录态结果一致。

## 长跑纪律（抓几百个账号时看这段）

| 项 | 默认 | 说明 |
|---|---|---|
| profile 分工 | 评论 = work / 达人 = 登录 | 评论不需要登录态，别拿登录 profile 存评论页缓存 |
| profile 体积阈值 | 300MB | 只算有效体积（排除 BrowserMetrics 预分配文件） |
| 启动前清理 | 自动 | work profile 超阈值整目录重建；登录 profile 只清缓存，不重新扫码 |
| 每 N 个重启 | `account --sweep-every 10` | 关浏览器 → 清缓存 → 重拉 |
| 连续失败熔断 | `--breaker 5` | 连挂 5 个立即停，不白跑 |
| 错误原文 | `dy_output/_errors/<secUid>.log` | 台账只留一行摘要 |

**不要**用 `taskkill` / `Stop-Process` 清 profile：子进程持有句柄，`rm` 会静默失败，
看着清完其实没清。清理一律走 `Browser.close` → 等 2 秒 → 删 → 复测体积。

## 换机部署

```bash
# ① 解压到技能目录
#    macOS/Linux: ~/.workbuddy/skills/douyin-hot-comments
#    Windows:     C:\Users\<你>\.workbuddy\skills\douyin-hot-comments

# ② 体检（OS / Node / Chrome / profile / 端口 / 磁盘一次说清）
node run.mjs health

# ③ 扫码（只有这一步必须人工）
node run.mjs login
```

依赖：Node ≥22、Chrome/Edge（自动探测，可用 `DY_CHROME` 指定）、
Python + openpyxl（仅 xlsx / ledger）。平台差异清单见
[references/portability.md](references/portability.md)。

## 目录结构

```
douyin-hot-comments/
├── SKILL.md              本文件（门面：能力、命令、纪律）
├── config.json           默认参数（阈值/页数/并发，不含路径）
├── run.mjs               唯一 CLI 入口
├── lib/                  共享层
│   ├── platform.mjs      唯一平台判断（找浏览器/杀进程/查端口/磁盘）
│   ├── paths.mjs         路径解析（~ / %VAR% / profile）
│   ├── cdp.mjs           CDP 协议封装 + 响应嗅探
│   └── chrome.mjs        浏览器生命周期 + profile 治理
├── scripts/              命令实现（只做编排）
├── references/           按需加载的细节
└── assets/               报告样式模板（不进上下文）
```

## 详细文档

- [references/scheme.md](references/scheme.md) —— 抓取链路、接口来源、技术坑
- [references/tiers.md](references/tiers.md) —— 6 档阈值与深度判定
- [references/schema.md](references/schema.md) —— 跨机数据规范（字段不许改）
- [references/ledger.md](references/ledger.md) —— 台账结构与批次规则
- [references/troubleshooting.md](references/troubleshooting.md) —— 按现象索引
- [references/portability.md](references/portability.md) —— 换机与平台差异
- [references/upgrade-log.md](references/upgrade-log.md) —— 版本与问题修复记录
