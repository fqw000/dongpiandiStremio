# 懂片帝 · Stremio Addon

> 对接懂片帝（dongpian17.com）的 Stremio 影视插件。支持目录浏览、关键词搜索、元数据获取、官方高清线路解析。基于 Vercel Edge Functions + Upstash Redis，零第三方运行时依赖。

---

## 目录

- [核心特性](#核心特性)
- [项目结构](#项目结构)
- [快速开始](#快速开始)
- [配置说明](#配置说明)
- [接口文档](#接口文档)
- [缓存策略](#缓存策略)
- [ID 格式](#id-格式)
- [线路黑名单维护](#线路黑名单维护)
- [调试与健康检测](#调试与健康检测)
- [常见问题](#常见问题)
- [技术栈](#技术栈)
- [免责声明](#免责声明)

---

## 核心特性

- **完整 Stremio 协议** — catalog / meta / stream / search 四大接口
- **双 ID 体系** — 站内 ID（`dpd_xxx`）+ IMDb ID（`tt0109830`），与其他 Addon 互通
- **多语言 IMDb 匹配** — 通过 TMDB 别名搜索，解决英文原名匹配不到中文资源的问题
- **官方高清线路** — 配置登录 Cookie 后可解析 `resolve://` 票据，返回字节 CDN 的 mp4 直链
- **智能回退** — 官方线路不可用时自动回退到 m3u8 采集线路
- **三级缓存** — 内存 → Upstash Redis → Vercel CDN，显著降低源站压力
- **线路黑名单** — 剔除长期失效的线路，改善用户体验
- **零依赖部署** — 仅原生 `fetch` + WebCrypto，一键部署到 Vercel

---

## 项目结构

```
dongpiandiStremio/
├── api/
│   └── index.js              # Vercel Edge Function 入口
├── public/                   # 配置页面（静态资源）
│   ├── configure.html
│   ├── configure.css
│   └── configure.js
├── src/
│   ├── handler.js            # 路由分发 + 业务处理
│   ├── adapter.js            # 懂片帝站点适配器
│   ├── manifest.js           # Stremio Manifest 生成
│   ├── config.js             # 全局配置 + 默认值
│   ├── cache.js              # 三级缓存 + Redis 冷却降级
│   ├── sign.js               # HMAC-SHA256 签名
│   ├── http.js               # HTTP 客户端（自动签名 + 重试）
│   ├── imdb-resolver.js      # IMDb → 懂片帝 vodId
│   ├── tmdb.js               # TMDB / Cinemeta 元数据
│   ├── logger.js             # 分级日志
│   └── helper.js             # 工具函数
├── health.js                 # 健康检测脚本
├── test-*.mjs                # 探针脚本（签名、接口、域名）
├── vercel.json               # Vercel 路由配置
├── package.json
└── README.md
```

---

## 快速开始

### 前置条件

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 18 | 本地开发 |
| Vercel 账号 | — | 部署平台 |
| Upstash 账号 | — | Redis 缓存（可选但推荐） |

### 第一步：克隆并安装

```bash
git clone <your-repo-url>
cd dongpiandiStremio
npm install
```

### 第二步：配置 Upstash Redis（推荐）

1. 访问 https://console.upstash.com/ 并登录
2. 创建 Redis 数据库：
   - **Name**：`dongpiandi-cache`
   - **Type**：Regional
   - **Region**：`ap-southeast-1`（新加坡，与 Vercel 边缘节点接近）
   - **Plan**：Free
3. 复制 **REST URL** 与 **REST TOKEN**

### 第三步：配置环境变量

#### 本地开发

在项目根目录创建 `.env.local`：

```bash
LOG_LEVEL=info
APP_PREFIX=dongpiandi:prod
UPSTASH_REDIS_REST_URL=https://xxx.upstash.io
UPSTASH_REDIS_REST_TOKEN=AXxx...

# 可选：自用场景提供默认 Cookie，无需每次带 cfg
DEFAULT_SESSION_COOKIE=ums2_2026-08.eyJ2Ijox...
```

#### 生产环境（Vercel CLI）

**添加变量**（逐个交互式）：

```bash
npx vercel env add UPSTASH_REDIS_REST_URL
# 提示：选择环境（Production / Preview / Development）→ 输入值

npx vercel env add UPSTASH_REDIS_REST_TOKEN
npx vercel env add APP_PREFIX     # 值：dongpiandi:prod
npx vercel env add LOG_LEVEL      # 值：info
```

**添加变量**（非交互，脚本化）：

```bash
echo "https://xxx.upstash.io" | npx vercel env add UPSTASH_REDIS_REST_URL production
echo "AXxx..."                | npx vercel env add UPSTASH_REDIS_REST_TOKEN production
echo "dongpiandi:prod"        | npx vercel env add APP_PREFIX production
echo "info"                   | npx vercel env add LOG_LEVEL production
```

> 建议 `Production` / `Preview` / `Development` 三个环境都添加，避免预览部署缺变量。

**查看已有变量**：

```bash
npx vercel env ls
```

**删除变量**：

```bash
npx vercel env rm LOG_LEVEL production
# 交互式确认；跳过确认加 --yes：
npx vercel env rm LOG_LEVEL production --yes
```

**从 Vercel 拉取到本地**：

```bash
# 默认拉取 Development 环境到 .env.local
# ⚠️ 会覆盖已有文件，先备份
cp .env.local .env.local.bak 2>/dev/null
npx vercel env pull

# 或拉取到自定义文件（不覆盖 .env.local）
npx vercel env pull .env.vercel.local
```

> `vercel env pull` 会拉取**所有**已配置的变量（含敏感令牌），拉下来的文件**务必加入 `.gitignore`**。

#### 更新变量后重新部署

Vercel 环境变量**不会**自动应用到已部署的版本，修改后需要重新部署：

```bash
npx vercel --prod
```

本地 `npx vercel dev` 则需 **Ctrl+C 重启** 才能读取新的 `.env.local`。

#### 备选：Vercel Dashboard

不习惯 CLI 时，也可在 Vercel Dashboard → 项目 → **Settings → Environment Variables** 手动添加。与 CLI 方式等效。

### 第四步：本地调试

```bash
npx vercel dev
```

服务运行在 `http://localhost:3000`。

验证：

```bash
curl -s http://localhost:3000/manifest.json | jq '.catalogs | length'
# 预期：6

curl -s "http://localhost:3000/catalog/movie/dpd-movie.json" | jq '.metas | length'
# 预期：20
```

### 第五步：部署到 Vercel

```bash
npx vercel --prod
```

部署成功后输出：

```
✅ Production: https://dongpiandi-xxx.vercel.app
```

### 第六步：绑定自定义域名（推荐）

1. Vercel Dashboard → 项目 → **Settings → Domains**
2. 添加域名（如 `stremio.yourdomain.com`）
3. DNS 服务商处添加 CNAME：
   - **Type**：CNAME
   - **Name**：`stremio`
   - **Value**：`cname.vercel-dns.com`
   - **Proxy status**：**DNS only**（灰色云）

### 第七步：在 Stremio 中安装

1. 打开配置页面 `https://your-domain/configure`
2. 按需填写配置（域名 / Cookie / 黑名单 / Build Version）
3. 点击"生成安装链接"
4. 复制 manifest URL，在 Stremio 中 **Addons → Install from URL** 安装
5. 或用手机扫描二维码安装

---

## 配置说明

### 配置来源与优先级

配置来源共三处，优先级从高到低：

| 来源 | 存放位置 | 适用范围 | 可配项 |
|---|---|---|---|
| **用户配置** | URL 的 `?cfg=` 参数 | 单个用户 | `bd` / `bv` / `tk` / `cats` / `blockedLines` / `cookie` / `imdb` / `stream` / `debug` |
| **环境变量** | `.env.local` / Vercel Dashboard | 部署全局 | `UPSTASH_*` / `APP_PREFIX` / `LOG_LEVEL` / `DEFAULT_SESSION_COOKIE` |
| **代码默认值** | `src/config.js` | 全体用户 | `BASE_DOMAIN` / `BUILD_VERSION` / `DEFAULT_BLOCKED_LINES` 等 |

### 用户配置项（配置页面）

| 键 | 类型 | 说明 | 默认 |
|---|---|---|---|
| `bd` | text | 懂片帝域名 | `dongpian17.com` |
| `bv` | text | Build Version（站点前端发版时会变） | 代码内置 |
| `tk` | text | TMDB API Key | 内置公共 Key |
| `cats` | array | 启用的类型 | 全部 6 类 |
| `blockedLines` | array | 线路黑名单（追加到代码默认） | `[]` |
| `cookie` | text | 登录 Cookie（`ai_movie_session` 的值） | 空 |
| `imdb` | bool | 启用 IMDb 解析 | `true` |
| `stream` | bool | 启用 Stream 资源 | `true` |
| `debug` | bool | 打开 debug 日志 | `false` |

### 环境变量

| 变量 | 必需 | 说明 |
|---|---|---|
| `UPSTASH_REDIS_REST_URL` | 推荐 | Upstash Redis REST 地址 |
| `UPSTASH_REDIS_REST_TOKEN` | 推荐 | Upstash Redis 认证令牌 |
| `APP_PREFIX` | 可选 | Redis Key 前缀，多项目共用同一数据库时隔离（默认 `dongpiandi:prod`） |
| `LOG_LEVEL` | 可选 | 日志级别：`debug` / `info` / `warn` / `error`（默认 `info`） |
| `DEFAULT_SESSION_COOKIE` | 可选 | 默认 Cookie，自用场景方便（多用户场景不建议配置） |

### Cookie 获取方式

1. 浏览器登录 `dongpian17.com`
2. F12 → Application → Cookies
3. 找到 `ai_movie_session`，复制**完整值**（以 `ums_` 或 `ums2_` 开头，约 280 字符）
4. 填入配置页面的"懂片帝登录 Cookie"

**注意**：
- Cookie 值**不含** `ai_movie_session=` 前缀
- Cookie 有效期约 1 年（JWT exp），但站点可能提前失效
- 失效后重新抓取即可

---

## 接口文档

所有接口遵循 [Stremio Addon SDK 规范](https://github.com/Stremio/stremio-addon-sdk/blob/master/docs/api.md)。

### Manifest

```http
GET /manifest.json
```

返回 6 个 catalog：

| Catalog ID | 类型 | 名称 |
|---|---|---|
| `dpd-movie` | movie | 懂片帝 · 电影 |
| `dpd-series` | series | 懂片帝 · 电视剧 |
| `dpd-short` | series | 懂片帝 · 短剧 |
| `dpd-anime` | series | 懂片帝 · 动漫 |
| `dpd-variety` | series | 懂片帝 · 综艺 |
| `dpd-documentary` | series | 懂片帝 · 纪录片 |

`idPrefixes`：`['dpd_', 'tt']`

### Catalog · 浏览

```http
GET /catalog/:type/:id.json?skip=0
GET /catalog/:type/:id/skip=20.json
```

### Catalog · 搜索

```http
GET /catalog/:type/:id/search=流浪地球.json
```

搜索使用站点 `query_mode=fast_v3`，一次请求返回完整结果。

### Meta

```http
GET /meta/:type/:id.json
```

| ID 格式 | 来源 | 示例 |
|---|---|---|
| `dpd_av_xxx` | 站内电影 | `dpd_av_5LAgCLxw0DNBkB3ue...` |
| `dpd_av_xxx:1:1` | 站内剧集 | `dpd_av_5LAgCLxw...:1:1` |
| `tt0109830` | IMDb 电影 | `tt0109830` |
| `tt13016388:1:2` | IMDb 剧集 | `tt13016388:1:2` |

### Stream

```http
GET /stream/:type/:id.json
```

返回的 `streams[]` 两种形态：

| 类型 | URL 特征 | `type` 字段 | 说明 |
|---|---|---|---|
| 官方高清 | `https://v9-...toutiaovod.com/...mp4` | 无（默认视频） | 需 Cookie，画质最高 |
| 采集 m3u8 | `https://xxx.m3u8` | `hls` | 匿名可用 |

### 调试接口

| 端点 | 说明 |
|---|---|
| `/debug/cache` | 缓存状态（L1 大小、L2 是否启用、Redis 冷却剩余） |
| `/debug/version` | 版本号 + 当前日志级别 |
| `/debug/config` | 脱敏后的当前生效配置 |

---

## 缓存策略

三级缓存，逐级降低源站压力。

| 层级 | 存储 | 命中耗时 | 生命周期 |
|---|---|---|---|
| **L1** | 内存 Map | < 1ms | 实例级（60 秒） |
| **L2** | Upstash Redis | < 10ms | 跨实例（见下表） |
| **L3** | Vercel CDN | < 100ms | 全局（按 TTL） |

### 各接口 TTL

| 数据 | L1 | Redis | CDN |
|---|---|---|---|
| Catalog | 60s | 5 分钟 | 5 分钟 |
| Detail | 60s | 30 分钟 | — |
| Episodes | 60s | 30 分钟 | — |
| Search | 60s | 10 分钟 | 5 分钟 |
| Stream（官方） | 60s | 3 分钟 | 1 分钟 |
| Stream（直连） | 60s | 3 分钟 | 1 分钟 |
| Stream negative | — | **5 分钟** | — |
| IMDb 映射 | — | 7 天 | — |
| TMDB 元数据 | — | 7 天 | — |

### Redis 冷却降级

Redis 连续 3 次响应超过 1500ms 或失败 → 进入 **60 秒冷却期**，期间跳过 Redis 只用 L1。冷却结束后自动恢复。

---

## ID 格式

### 站内 ID

```
dpd_av_5LAgCLxw0DNBkB3ueLwIRbVGFuF2TZH0...    → 电影（影片级）
dpd_av_5LAgCLxw0DNBkB3ueLwIRbVGFuF2TZH0...:1:1 → 剧集（集级）
```

**前缀 `dpd_` 不含冒号**。Stremio 客户端用 `:` 识别 `season:episode` 分隔符，若前缀带冒号会错乱。

### IMDb ID

```
tt0109830         → 电影
tt13016388:1:2    → 剧集：第 1 季第 2 集
```

**IMDb 解析流程**：

1. 通过 IMDb ID 查 TMDB 元数据（标题、年份、季数）
2. 拉取 TMDB 别名（多语言）
3. 用候选标题在懂片帝搜索（合并结果）
4. 按相似度 + 年份匹配
5. 缓存 7 天

---

## 线路黑名单维护

黑名单用于剔除长期失效的线路，改善用户体验。

### 数据结构

黑名单是 **代码默认 + 用户增量**：

```javascript
// 最终黑名单 = DEFAULT_BLOCKED_LINES ∪ user.blockedLines
```

- **代码维护**（`src/config.js` 顶部的 `DEFAULT_BLOCKED_LINES`）：跨片稳定失效的线路，全用户生效
- **用户追加**（配置页面"线路黑名单"）：用户个性化需求，仅自己的 cfg 生效

### 添加黑名单的原则

- 只加**跨片稳定失效**的线路（避免误伤偶尔抽风的优质线路）
- 依据 `node health.js --limit=10` 统计报告
- 常见案例：第三方联动线路（腾讯 / 优酷 / 爱奇艺 / 芒果TV）长期 404

### 维护流程

1. 跑健康检测：`node health.js --limit=10`
2. 查看"建议加入黑名单的线路"章节
3. 复制建议到 `src/config.js` 的 `DEFAULT_BLOCKED_LINES`，或填到配置页面

### 生效位置

- **官方票据线路**：请求前过滤（**省 HTTP**）
- **直连 m3u8 线路**：响应前过滤（**响应瘦身**）

---

## 调试与健康检测

### 本地开发

```bash
npx vercel dev
```

日志输出在终端，格式：

```
[HH:MM:SS.mmm] ℹ️ [Handler] GET /stream/movie/dpd_xxx.json ?debug=1
[HH:MM:SS.mmm] 🐛 [Adapter] 解析 11 条票据线路（已配置 Cookie）
[HH:MM:SS.mmm] ℹ️ [HTTP] 201 (284ms) https://dongpian17.com/v1/playback/resolve-line
```

请求级日志控制：URL 加 `?debug=1` 打开 debug 级别。

### 健康检测脚本

```bash
# 默认检测 5 部片
node health.js

# 检测 10 部片
node health.js --limit=10

# 跳过官方线路解析（只测直连）
node health.js --no-cookie

# 带 Cookie 测官方线路
COOKIE=ums2_2026-08.eyJ2Ijox... node health.js --limit=5
```

**输出示例**：

```
═══════════════════════════════════════════════════
  阶段 3：线路质量报告
═══════════════════════════════════════════════════

  线路名                          总  成  402 404 429 超时 其他
  ──────────────────────────────────────────────────────────────
  腾讯视频 · 普通话                10  0   0   10  0   0    0
  优酷                             8   0   0   8   0   0    0
  1080P-官方Z                      6   3   3   0   0   0    0
  ...

═══════════════════════════════════════════════════
  建议加入黑名单的线路
═══════════════════════════════════════════════════
  以下线路长期失败，可加入黑名单提升用户体验：

    腾讯视频 · 普通话
      出现 10 次，成功 0 次（0%），402=0 404=10 超时=0
```

报告同时保存到 `samples/health-{timestamp}.json`。

### 探针脚本（开发用）

| 脚本 | 用途 |
|---|---|
| `test-threads.mjs` | 验证 `/v1/threads` 搜索协议 |
| `test-resolve-line.mjs` | 验证 Cookie 解析官方线路 |
| `test-resolve-domain.mjs` | 验证 Cookie 跨域名通用性 |
| `probe.mjs` | 遍历所有接口，输出字段结构 |

### 检查 CDN 缓存

```bash
curl -I "https://your-domain/catalog/movie/dpd-movie.json" | grep -i "x-vercel-cache\|age"
```

**预期**（生产环境）：

```
age: 112
x-vercel-cache: HIT
```

---

## 常见问题

### Q1：Stremio 中搜索无结果？

确认 `manifest.js` 的 catalogs 声明了 `extra: [{ name: 'search', isRequired: false }]`。

### Q2：剧集详情页只显示 S1E1？

**确保 `meta.videos` 在 `behaviorHints.defaultVideoId` 之前赋值**：

```javascript
// ✅ 正确顺序
meta.videos = ...;
if (meta.videos.length > 0) {
  meta.behaviorHints = { defaultVideoId: meta.videos[0].id };
}
```

### Q3：有 Cookie 时官方线路全部 401？

**可能原因**：
- Cookie 缺 `ai_movie_session=` 前缀（代码会自动补）
- Cookie 格式错误（必须以 `ums_` 或 `ums2_` 开头）
- Build Version 过期（站点前端发版后需更新）

**排查**：

```bash
curl -s "http://localhost:3000/debug/config" | jq '.SESSION_COOKIE'
# 预期："ums2_202***（len=280）"
```

### Q4：官方线路 402/404？

| HTTP | 含义 | 处理 |
|---|---|---|
| 402 | 需付费会员 | 该线路对免费账户不可用 |
| 404 | 线路不可用 | 该线路已下架或无权限 |
| 429 | 站点限流 | 已串行 + 250ms 间隔，仍限流时等 1 分钟 |

**402/404 不是 Addon 问题**，是站点侧权限。Addon 会自动回退到 m3u8 直连线路。

### Q5：CDN 缓存不生效？

- `*.vercel.app` 默认不缓存，**必须绑定自定义域名**
- 检查响应头 `x-vercel-cache: MISS` 是否持续出现
- 确认 `jsonResponse` 设置了 `Cache-Control`

### Q6：IMDb 解析失败？

**排查**：

```bash
curl -s "http://localhost:3000/meta/movie/tt0109830.json?debug=1" \
  | jq '{ id: .meta.id, name: .meta.name, type: .meta.type }'
```

- 若 `meta: null` → TMDB 无该片，或 Addon 未匹配到懂片帝的对应资源
- 检查日志 `[IMDbResolve]` 前缀

### Q7：Vercel 返回 403 / Security Checkpoint？

短时间内大量请求触发 Vercel 安全防护。

**解决**：
- 等待 10~30 分钟
- 用浏览器访问验证
- Stremio 客户端通常不会被拦（有正常 UA）

### Q8：如何临时关闭 Stream 功能？

配置页面取消勾选"启用 Stream"，或 URL 加 `?cfg=` 编码 `{"stream":false}`。

**用途**：站点限流或 Cookie 失效时，仅提供目录和元数据，不返回播放地址。

---

## 技术栈

| 层 | 技术 |
|---|---|
| 运行时 | Vercel Edge Functions (V8 Isolate) |
| 语言 | JavaScript (ES Module) |
| 缓存 | Upstash Redis + Vercel CDN |
| 元数据 | TMDB API + Cinemeta |
| 签名 | WebCrypto HMAC-SHA256 |
| 协议 | Stremio Addon SDK |
| 依赖 | 零第三方运行时依赖（仅原生 `fetch` + WebCrypto） |

---

## 免责声明

本项目仅供**学习与技术研究**使用。所有内容均来自第三方资源站，请勿用于商业用途。使用者需自行承担相应责任。

站点内容版权归原作者所有，本项目不存储、不转码、不分发任何视频内容，仅作为 API 客户端存在。