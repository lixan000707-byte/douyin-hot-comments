# douyin-hot-comments

抖音三类数据采集技能：**视频指标 / 高赞评价 / 达人主页**。

零第三方依赖（Node 内置 `fetch` + `WebSocket`），通过 CDP 驱动本机 Chrome，
不截图、不模拟点击、不做 OCR。

## 能力

| 数据 | 命令 | 产出 |
|---|---|---|
| 视频 | `keyword` / `hot` / `search` / `tier` | 视频指标（赞/评/藏/转、发布时间、话题） |
| 评价 | `top` / `keyword` / `hot` / `tier` | 点赞降序一级评论 + 6 档门槛判定 + 二次复检 |
| 达人 | `account` | 主页资料（粉丝/总获赞/IP 属地）+ 作品列表全指标 |

## 安装

```bash
# 解压到技能目录
#   Windows:     C:\Users\<你>\.workbuddy\skills\douyin-hot-comments
#   macOS/Linux: ~/.workbuddy/skills/douyin-hot-comments

node run.mjs health      # 体检：OS / Node / Chrome / profile / 端口 / 磁盘
node run.mjs login       # 扫码（仅搜索类与达人主页需要）
```

要求：Node ≥ 22、Chrome 或 Edge、图形界面；`xlsx` / `ledger` 另需 Python 3 + openpyxl。

## 快速开始

```bash
node run.mjs keyword "牛仔裤" --top 6
node run.mjs top <videoId> --verify
node run.mjs account <secUid> -o dy_output/h001_posts.json
```

产物统一落在当前工作目录的 `dy_output/`，可用 `DY_DATA_DIR` 覆盖。

## 验证（改完代码先跑）

```bash
node scripts/ci_check.mjs        # 静态：frontmatter / 文件 / 语法 / 平台收口（无需浏览器）
node lib/test_depth_judge.mjs    # 14 例判定单测
node scripts/audit_scheme.mjs    # 方案自检：调用链 / 参数一致性
node run.mjs health --strict     # 环境自检
node run.mjs smoke               # 真实抓取验收（视频 / 评价 / 达人 + 基线对比）
node scripts/validate.mjs dy_output/*.json   # 字段规范校验
```

CI 只跑前三项（见 `.github/workflows/validate.yml`）：
真实抓取需要图形界面、登录态和稳定网络，抖音还会拦数据中心 IP。

## 结构

```
├── SKILL.md           门面：能力 / 命令 / 纪律
├── run.mjs            唯一 CLI 入口
├── lib/               共享层（platform / paths / cdp / chrome / 判定纯函数）
├── scripts/           命令实现 + 自检
├── references/        按需加载的细节（schema / tiers / ledger / portability）
└── assets/            报告样式模板
```

**规矩**：`process.platform` 只允许出现在 `lib/platform.mjs`；`scripts/` 只做编排，
不写 CDP 细节；方案自检会在 CI 里强制这条。

## 限制

- **仅 Windows 10/11 实机验证**。macOS/Linux 代码路径已收口，但未实机验证，不承诺可用。
- 无头 Linux 服务器不可用：抖音对 headless 降级渲染，抓 0 条。
- 播放量不公开，接口无该字段。
- 只抓点赞最高的前 N 条评论，不是全量（实测覆盖率约 1.2%）。

## 许可

MIT，见 [LICENSE](LICENSE)。
