# 抓取链路与数据来源

## 三条入口路径

### 1. 搜索（需登录）

```
访问 douyin.com → 等 7 秒预热 → location.href 跳 /search/<词> → 拦截 search/item 接口
```

⚠ 直接 navigate 到搜索页**必弹验证码**，headless 与有头都一样。预热是绕过关键。

### 2. 视频详情 + 评论（不需要登录）

```
navigate /video/<id> → 页面自身请求 aweme/detail 拿视频指标
→ 注入 hook 截获 comment/list 的签名 URL → 复用该 URL 改 cursor 翻页
```

复用签名 URL 比模拟点击稳定得多。图文作品必须走 `/note/<id>`：用 `/video/` 打开会返回空壳页，
表现为「数据无效（视频不存在/已删除/私密）」——纯数字 ID 无法预判类型，代码按
`/video/` → `/note/` 顺序回退。

### 3. 达人主页（需登录）

```
navigate /user/<sec_uid> → 点「作品」页签 → 滚动
→ CDP 嗅探 /aweme/v1/web/aweme/post/ 拿作品列表（含全部指标）
→ CDP 嗅探 /aweme/v1/web/user/profile/other/ 拿粉丝/总获赞/IP 属地
```

作品接口自带的 `author` 对象**不含** `follower_count`，粉丝数必须走 `profile/other`。

## 嗅探的正确写法

响应体必须在 `Network.loadingFinished` 之后取。在 `responseReceived` 阶段取，
大响应（900KB br）会抛 `-32000`；异常若被吞掉，就会误报成「接口没发请求 / 被风控」，
这是最难定位的一类假故障（见 `lib/cdp.mjs` 的 `sniff()`）。

## 页面降级与缓存

| 现象 | 真因 | 处置 |
|---|---|---|
| 正文只有约 1600 字、接口一个不发 | headless 被降级渲染 | 默认有头，窗口移到屏幕外 |
| 同一视频第二次抓 0 条 | 页面走缓存，XHR 不发 | `Network.setCacheDisabled(true)` + `Page.reload{ignoreCache:true}` 兜底 |
| 后台标签抓 0 条 | 定时器冻结、渲染降级 | `setFocusEmulationEnabled` + `setWebLifecycleState('active')` |

## 技术坑

1. **`DY_CNT` 不是条数上限**：不设时接口每页只给 5 条，80 页也只有 400 条，退出码还是 0
2. **搜索按词限流**：同词 10 分钟内重抓会静默失败（页面正常但接口不发请求）
3. **点赞会漂移**：搜索时 4,189 赞，抓取时可能已涨到 7,850，跨区间
4. **搜索噪音**：女裤结果里混进过「小号加好友教程」和「英雄联盟电竞」
5. **Windows 路径**：`path.relative()` 返回反斜杠，正则匹配 `/` 会全部失效
6. **昵称会改，sec_uid 不会**：身份校验只能报警告，不能中止（否则改个名整号作废）

## 6 档阈值与深度判定

见 [tiers.md](tiers.md)。
