# MakerHub CloakBrowser 单通道抓取设计

## 背景

MakerHub 当前使用两套浏览器能力：

- FlareSolverr 负责 MakerWorld 模型页、来源列表、评论、账号 Web 探测和控制面 API。
- CloakBrowser 负责持久化登录 profile、同步 Cookie 和通过真实点击取得 3MF 授权。

两条链路使用不同浏览器会话，可能出现 CloakBrowser 已登录但 FlareSolverr 仍被 Cloudflare 拦截的状态分裂，也增加了一个长期运行容器和一套部署配置。本次迁移把 MakerWorld 控制面请求全部收敛到 CloakBrowser；已解析出的静态文件仍由 MakerHub 直接下载。

本次不迁移或改写数据库、归档目录、任务历史、账号历史和业务日志。

## 目标

1. MakerWorld HTML、JSON 和 3MF 浏览器授权只使用对应 CloakBrowser profile。
2. 国区与国际区请求分别复用 `MakerHub CN` 和 `MakerHub Global` profile。
3. 用户正在操作的浏览器标签页不被后台归档导航或关闭。
4. CloakBrowser 瞬时故障归类为网络错误，不误报账号失效。
5. 完成迁移后从默认部署、自更新、CI 和文档中移除 FlareSolverr。
6. 保持图片、附件和已授权 3MF 直链的普通下载性能。

## 非目标

- 不修改历史归档内容或历史日志中的 FlareSolverr 文案。
- 不把图片、附件或 3MF 大文件流量转发到 CloakBrowser。
- 不在首版引入常驻 Node 网关、额外容器或新的数据库表。
- 不允许 CloakBrowser 抓取任意第三方 URL。

## 方案选择

采用短生命周期 CDP bridge：每次控制面请求启动现有 Node bridge，连接已经运行或按需启动的 CloakBrowser profile，创建临时后台标签页完成请求，关闭临时标签页后断开 CDP。

未采用常驻 Node 网关，因为它需要额外的进程协议、崩溃恢复、App/Worker 多实例协调和升级状态管理。未采用普通 HTTP 优先加浏览器兜底，因为该方案仍会分裂 Cookie、TLS 指纹和 Cloudflare 会话。

## 组件设计

### JavaScript CDP Bridge

`app/services/cloakbrowser_bridge.mjs` 新增 `fetch` 动作：

- 校验目标为允许的 MakerWorld 或 Bambu API HTTPS 域名。
- 在 profile 默认 browser context 中创建一个新页面。
- 设置经过白名单过滤的请求头并导航到带查询参数的目标 URL。
- 返回最终 URL、HTTP 状态码、Content-Type、必要的安全响应头和正文。
- 对 HTML 等待 DOM ready，并识别仍未解除的 Cloudflare challenge。
- 无论成功或失败都关闭本次创建的页面；不复用、导航或关闭用户页面。
- 最终只执行 `browser.disconnect()`，不关闭整个浏览器。

正文通过 bridge 标准输出返回。首版不维护常驻连接；完整测试和线上观测若证明 Node 启动成本成为主要瓶颈，再单独设计长连接协议。

### Python 浏览器抓取客户端

新增统一的 MakerWorld 浏览器客户端，提供：

- `get()`：返回结构化响应。
- `get_text()`：返回 HTML 或文本。
- `get_json()`：解析 JSON，并区分空响应、非 JSON 和浏览器挑战页。

结构化响应至少包含最终 URL、状态码、正文、Content-Type 和 profile ID。异常分为服务不可用、CDP 操作错误、非法目标、HTTP 错误和 JSON 解析错误，调用方不再出现 FlareSolverr 类型或文案。

客户端按 URL 判断 `cn` 或 `global`：

- 已关联 profile 时严格使用账号配置中的 profile ID。
- 旧账号未关联 profile 时，复用或创建固定名称的托管 profile；只有该兼容路径可以把现有 Cookie 注入浏览器。
- 已关联 profile 的当前 Cookie 永远优先，不能被 MakerHub 中较旧的 Cookie 反向覆盖。

同一 profile 的操作继续使用现有跨进程 `resource_slot`。App、Worker 和归档子进程共享配置卷上的全局槽，首版容量固定为 1，避免多个任务同时导航同一个 profile。

### 调用点迁移

以下控制面请求改用统一浏览器客户端：

- 单模型 HTML 和设计 API。
- 作者上传页、收藏夹和合集的 HTML/JSON 列表。
- 评论、回复和相关控制面 API。
- 来源卡片的远端元数据页面。
- 账号 Web 入口探测。
- 3MF 下载地址 API；需要真实交互的路径继续调用现有 CloakBrowser 点击授权。

以下下载保持现状：

- 图片和头像。
- 附件与评论资源。
- 已取得签名直链的 3MF 文件。

旧 `flaresolverr_client.py` 及其专用测试在所有调用点完成迁移后删除。业务调试字段中的运行引擎改为 `cloakbrowser`。

## 错误处理

1. CloakBrowser Manager `5xx`、连接失败、CDP 断开和超时属于瞬时网络故障；批量子任务按现有瞬时错误规则重试，账号 Cookie 与浏览器同步状态保持不变。
2. 浏览器真实返回登录页、明确的 `401/403`、Cloudflare challenge 或 MakerWorld 验证载荷时，沿用现有账号健康与 3MF gate 分类。
3. HTTP `404`、下架、私有和草稿继续作为模型终态处理，不转成账号错误。
4. JSON 接口返回 HTML 时，错误信息说明浏览器仍处于站点页面或风控页面，不暴露 Cookie、Token、响应头中的敏感字段。
5. 每个临时标签页在 `finally` 中关闭；bridge 失败不得遗留后台页面。
6. GET 请求允许对 CDP 瞬时断开执行一次短退避重试；验证点击不在客户端内部重复，避免重复消耗下载授权。

## 部署与升级

发布版本为 `0.14.0`。

默认 `compose.yaml`：

- 删除 App/Worker 的 `MAKERHUB_FLARESOLVERR_*` 环境变量。
- 删除 `flaresolverr` 服务。
- 保留 App、Worker、Postgres 和 CloakBrowser 四个服务。

删除外部 FlareSolverr override 及相关 CI 检查。自更新流程使用新的 canonical compose 判断旧部署；只有新 App/Worker readiness 全部通过后，才删除精确命名为 `makerhub-flaresolverr` 的旧内置容器。用户自行维护或与其他项目共享的外部 FlareSolverr 不主动停止或删除。

手工 Compose 升级文档使用 `--remove-orphans`。旧 override 文件可以留在宿主机历史目录，但不能再参与新版本 Compose 命令。

## 性能与资源约束

- 浏览器控制请求按 profile 串行，静态下载仍由现有资源槽并行。
- 每次抓取只创建一个临时页面并立即关闭，不累积标签页。
- 不导航设置页为用户打开的现有页面。
- 日志记录 bridge 总耗时、导航耗时、平台、状态码和响应类型，不记录 Cookie、Token 或完整授权 URL 查询参数。
- 完整测试记录典型 HTML 与 JSON 请求耗时；没有证据前不增加常驻进程。

## 测试计划

### 单元测试

- URL 域名与协议白名单，包括子域名、混淆域名和非 HTTPS 拒绝。
- 查询参数、请求头过滤、平台与 profile 选择。
- HTML、JSON、空响应、非 JSON、挑战页、`401/403/404/5xx` 和超时分类。
- 已关联 profile 不被旧 Cookie 覆盖；未关联账号兼容注入 Cookie。
- bridge 临时页面成功和异常路径均关闭。

### 业务回归

- 单模型归档和 API fallback。
- 作者、收藏夹、合集批量发现与分页。
- 评论和回复采集。
- 账号 Cookie 探测。
- 3MF 点击授权、直链保存、验证、每日上限和瞬时故障重试。
- CloakBrowser `502` 不触发重新登录。

### 发布验证

- 后端完整测试、前端测试和生产构建。
- JavaScript 语法检查。
- Compose schema、release contract 和自更新测试。
- Docker build 与 App/Worker smoke test。
- `git diff --check` 和版本一致性检查。

## 验收标准

1. 生产代码和默认 Compose 不再包含 FlareSolverr 调用或服务依赖。
2. 未运行 FlareSolverr 时，单模型、批量来源、评论、账号探测和 3MF 控制请求均可完成。
3. 国区和国际区请求使用各自 profile，不串 Cookie。
4. 用户页面不被后台任务改变，任务完成后没有新增残留标签页。
5. CloakBrowser 瞬时 `5xx` 不把账号改成需要重新登录。
6. 历史数据、历史日志和归档目录不发生批量改写。
7. 旧内置 FlareSolverr 只在新版本 readiness 成功后删除。
8. 完整测试、构建、Compose 和镜像 smoke test 全部通过。
