# 换机部署与平台差异

> **验证范围：仅 Windows 10/11 实机验证过。**
> macOS / Linux 的代码路径已收口到 `lib/platform.mjs`，但**没有实机跑过**，
> 不承诺开箱可用。无头 Linux 服务器不可用（抖音对 headless 降级渲染，抓 0 条）。
> 换到非 Windows 机器，先跑 `node run.mjs health`，它会把缺什么直接列出来。

## 换机三步

```bash
# ① 解压到技能目录
#    macOS/Linux: ~/.workbuddy/skills/douyin-hot-comments
#    Windows:     C:\Users\<你>\.workbuddy\skills\douyin-hot-comments

# ② 体检（OS / Node / 浏览器 / profile / 端口 / 磁盘一次说清）
node run.mjs health

# ③ 扫码（唯一需要人工的一步）
node run.mjs login
```

**profile 不能拷贝**：cookie 与设备绑定，换机必须重新扫码。

## 依赖

| 依赖 | 要求 | 缺失后果 |
|---|---|---|
| Node | ≥ 22 | 启动即报版本过低（需要内置 WebSocket） |
| Chrome / Edge | 任意较新版本 | 自动探测常见路径；可用 `DY_CHROME` 指定 |
| Python + openpyxl | 仅 `xlsx` / `ledger` | 这两个子命令报错，其余不受影响 |
| 图形界面 | 必需 | 见下方 Linux 限制 |

## 平台差异（全部收口在 `lib/platform.mjs`）

| 能力 | 统一接口 | Windows | macOS | Linux |
|---|---|---|---|---|
| 找浏览器 | `findBrowser()` | Program Files 候选 + `where` | `/Applications` + `which` | `which google-chrome/chromium` |
| 杀进程树 | `killTree(pid)` | `taskkill /T /F` | `process.kill(-pid)` | 同 macOS |
| 端口占用 | `pidOnPort(port)` | `netstat -ano` | `lsof -ti` | `lsof -ti` |
| 磁盘剩余 | `freeDiskGB(p)` | `fs.statfsSync` | 同 | 同 |
| 路径展开 | `expand(p)` | `%VAR%` + `~` | `~` / `$VAR` | 同 |
| 窗口移屏 | `offscreenPos()` | `-2400,-2400` | `-3000,-3000` | 同 |
| 打开目录 | `openPath(p)` | `explorer` | `open` | `xdg-open` |

**规矩**：除 `lib/platform.mjs` 外，任何文件出现 `process.platform` 都是 bug。

## Linux 的硬限制

抖音对无头浏览器做降级渲染（正文只剩备案信息，接口一个不发）。
因此**无 X server 的服务器不能跑**，`health` 会直接报「图形界面 FAIL」。
`Xvfb` 方案未验证，不要承诺。

## 环境变量

| 变量 | 默认 | 用途 |
|---|---|---|
| `DY_CHROME` | 自动探测 | 指定浏览器可执行文件 |
| `DY_PORT` | 9333 | 搜索/首页的调试端口（固定，别按账号轮换） |
| `DY_PORT_COMMENT` | 9335 | 评论抓取的调试端口（work profile 专用） |
| `DY_PORT_ACCOUNT` | 9334 | 达人层的调试端口（登录 profile 专用） |
| `DY_PROFILE` | `~/.workbuddy/cache/dy-scrape-profile` | 登录 profile |
| `DY_WORK_PROFILE` | 登录 profile + `-work` | 可整删的抓取 profile |
| `DY_DATA_DIR` | `./dy_output` | 产物目录 |
| `DY_PROFILE_MAX_MB` | 300 | 有效体积阈值 |
| `DY_PROFILE_RESET` | 关 | `1` = 整目录重建（会丢登录态） |
| `DY_KEEP_CHROME` | 关 | `1` = 进程退出不关浏览器（批处理复用） |
| `DY_HEADLESS` | 关 | 仅搜索/首页脚本认；开了大概率抓 0 条 |

## 端口被占怎么办

```bash
node run.mjs health          # 会打印占用端口的 pid
```

`lib/chrome.mjs` 的 `ensure()` 已处理：探不到 CDP 但端口被监听 → 杀该 pid → 重拉。
所以正常情况无需手工干预。
