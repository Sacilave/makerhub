<p align="center">
  <img src="app/static/img/makerhub-logo.png" width="140" alt="MakerHub logo">
</p>

<h1 align="center">MakerHub</h1>

<p align="center">
  面向 NAS 的 MakerWorld 私有归档与订阅系统
</p>

<p align="center">
  <a href="https://github.com/s450586793/makerhub/actions/workflows/docker.yml"><img alt="Docker workflow" src="https://github.com/s450586793/makerhub/actions/workflows/docker.yml/badge.svg"></a>
  <a href="https://github.com/s450586793/makerhub/releases/latest"><img alt="GitHub release" src="https://img.shields.io/github/v/release/s450586793/makerhub"></a>
  <a href="https://github.com/s450586793/makerhub/pkgs/container/makerhub"><img alt="GHCR" src="https://img.shields.io/badge/GHCR-makerhub-2496ED?logo=docker&logoColor=white"></a>
</p>

> 当前版本：`v0.15.14`
>
> MakerHub 基于 [mw_archive_py](https://github.com/sonicmingit/mw_archive_py) 的抓取思路二次重构而来，感谢原作者 [sonicmingit](https://github.com/sonicmingit) 的开源分享。

MakerHub 把 MakerWorld 模型、图片、附件、评论、打印配置和 `3MF` 保存到自己的 NAS。它支持单模型和批量归档、作者与收藏夹订阅、本地文件导入、来源刷新、缺失 `3MF` 修复，并通过 CloakBrowser 复用真实浏览器登录态。

## 主要能力

- **MakerWorld 归档**：归档模型、作者页、收藏夹和合集，保存模型信息及关联资源。
- **订阅同步**：定时发现关注来源的新模型，并进入统一归档队列。
- **私有模型库**：分页搜索、筛选、收藏、打印标记、软删除和文件管理。
- **本地导入**：接收 `3MF`、`STL`、`STEP`、`OBJ`、压缩包和附件，自动整理与去重。
- **浏览器会话复用**：国内站和国际站使用独立 CloakBrowser profile，人工登录后由后台持续复用。
- **任务与诊断**：显示归档、刷新、整理和缺失 `3MF` 状态，并保留脱敏业务日志。
- **自托管更新**：支持 GHCR 镜像手动更新；可信内网可显式启用网页一键更新。

## 架构

默认部署包含 4 个容器：

| 服务 | 职责 |
| --- | --- |
| `makerhub-app` | FastAPI API、Vue 页面、鉴权和轻量请求 |
| `makerhub-worker` | 归档队列、订阅、来源刷新、本地整理和索引重建 |
| `makerhub-postgres` | 配置、任务状态、业务日志和模型卡片索引 |
| `makerhub-cloakbrowser` | MakerWorld 浏览器 profile、Cookie 和控制面抓取 |

Postgres 保存结构化状态；文件系统保存模型本体、图片、附件、导入文件和历史 `meta.json`。MakerHub 页面、列表、评论及 `3MF` 授权请求统一复用 CloakBrowser profile，已经取得签名地址的静态文件仍由普通下载器保存。

## 快速安装

### 1. 完整 Compose

GitHub 首页直接展示当前完整的 `compose.yaml`，包含 App、Worker、PostgreSQL 和 CloakBrowser 四个服务：

<!-- compose:start -->
```yaml
x-logging: &default-logging
  driver: local
  options:
    max-size: 10m
    max-file: "3"

services:
  makerhub-app:
    image: ghcr.io/s450586793/makerhub:latest
    container_name: makerhub-app
    init: true
    ports:
      - "9042:8000"
    environment:
      TZ: Asia/Shanghai
      MAKERHUB_ENTRYPOINT: app
      MAKERHUB_PROCESS_ROLE: app
      MAKERHUB_BACKGROUND_TASKS: "false"
      MAKERHUB_WORKER_CONTAINER_NAME: makerhub-worker
      MAKERHUB_WEB_WORKERS: "1"
      MAKERHUB_WORKER_CONCURRENCY: "4"
      MAKERHUB_DATABASE_URL: postgresql://makerhub:${MAKERHUB_POSTGRES_PASSWORD:?set MAKERHUB_POSTGRES_PASSWORD in .env}@makerhub-postgres:5432/makerhub
      MAKERHUB_CLOAKBROWSER_URL: http://cloakbrowser:8080
      MAKERHUB_CLOAKBROWSER_AUTH_TOKEN: ${MAKERHUB_CLOAKBROWSER_AUTH_TOKEN:?set MAKERHUB_CLOAKBROWSER_AUTH_TOKEN in .env}
      MAKERHUB_CLOAKBROWSER_PUBLIC_URL: ${MAKERHUB_CLOAKBROWSER_PUBLIC_URL:-}
      MAKERHUB_CLOAKBROWSER_TIMEOUT: "30"
      MAKERHUB_TRUSTED_PROXIES: ${MAKERHUB_TRUSTED_PROXIES:-}
    volumes:
      - ${MAKERHUB_CONFIG_PATH:-./data/config}:/app/config
      - ${MAKERHUB_ARCHIVE_PATH:-./data/archive}:/app/data
      # 高风险可选：只有明确需要网页一键更新时再挂载 Docker socket。
      # - /var/run/docker.sock:/var/run/docker.sock
    depends_on:
      makerhub-postgres:
        condition: service_healthy
      cloakbrowser:
        condition: service_started
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request; response = urllib.request.urlopen('http://127.0.0.1:8000/api/public/health/ready', timeout=3); raise SystemExit(0 if response.status == 200 else 1)"]
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 20s
    stop_grace_period: 30s
    logging: *default-logging
    restart: unless-stopped

  makerhub-worker:
    image: ghcr.io/s450586793/makerhub:latest
    container_name: makerhub-worker
    init: true
    environment:
      TZ: Asia/Shanghai
      MAKERHUB_ENTRYPOINT: worker
      MAKERHUB_PROCESS_ROLE: worker
      MAKERHUB_BACKGROUND_TASKS: "true"
      MAKERHUB_WORKER_CONCURRENCY: "4"
      MAKERHUB_HEAVY_JOB_NICE: "10"
      MAKERHUB_DATABASE_URL: postgresql://makerhub:${MAKERHUB_POSTGRES_PASSWORD:?set MAKERHUB_POSTGRES_PASSWORD in .env}@makerhub-postgres:5432/makerhub
      MAKERHUB_CLOAKBROWSER_URL: http://cloakbrowser:8080
      MAKERHUB_CLOAKBROWSER_AUTH_TOKEN: ${MAKERHUB_CLOAKBROWSER_AUTH_TOKEN:?set MAKERHUB_CLOAKBROWSER_AUTH_TOKEN in .env}
      MAKERHUB_CLOAKBROWSER_PUBLIC_URL: ${MAKERHUB_CLOAKBROWSER_PUBLIC_URL:-}
      MAKERHUB_CLOAKBROWSER_TIMEOUT: "30"
    volumes:
      - ${MAKERHUB_CONFIG_PATH:-./data/config}:/app/config
      - ${MAKERHUB_ARCHIVE_PATH:-./data/archive}:/app/data
    depends_on:
      makerhub-postgres:
        condition: service_healthy
      cloakbrowser:
        condition: service_started
    healthcheck:
      test: ["CMD", "python", "-m", "app.worker", "--healthcheck"]
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 20s
    stop_grace_period: 2m
    logging: *default-logging
    restart: unless-stopped

  makerhub-postgres:
    image: postgres:16-alpine
    container_name: makerhub-postgres
    environment:
      TZ: Asia/Shanghai
      POSTGRES_DB: makerhub
      POSTGRES_USER: makerhub
      POSTGRES_PASSWORD: ${MAKERHUB_POSTGRES_PASSWORD:?set MAKERHUB_POSTGRES_PASSWORD in .env}
    volumes:
      - ${MAKERHUB_POSTGRES_DATA_PATH:-./data/postgres}:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}"]
      interval: 10s
      timeout: 5s
      retries: 10
    stop_grace_period: 30s
    logging: *default-logging
    restart: unless-stopped

  cloakbrowser:
    image: cloakhq/cloakbrowser-manager@sha256:44836e982192e8fedb28617f2d39192bdef91f8dd62cf36c522c96d7d8e15914
    container_name: makerhub-cloakbrowser
    ports:
      - "${MAKERHUB_CLOAKBROWSER_BIND_ADDRESS:-127.0.0.1}:9050:8080"
    environment:
      TZ: Asia/Shanghai
      AUTH_TOKEN: ${MAKERHUB_CLOAKBROWSER_AUTH_TOKEN:?set MAKERHUB_CLOAKBROWSER_AUTH_TOKEN in .env}
    volumes:
      - ${MAKERHUB_CLOAKBROWSER_DATA_PATH:-./data/cloakbrowser}:/data
    stop_grace_period: 30s
    logging: *default-logging
    restart: unless-stopped
```
<!-- compose:end -->

可以直接下载同一份部署文件和环境变量模板：

```bash
mkdir makerhub
cd makerhub
curl -LO https://raw.githubusercontent.com/s450586793/makerhub/main/compose.yaml
curl -o .env https://raw.githubusercontent.com/s450586793/makerhub/main/.env.example
```

也可以克隆仓库后执行：

```bash
cp .env.example .env
```

### 2. 配置必填密钥

打开 `.env`，至少填写下面两个空值：

```env
MAKERHUB_POSTGRES_PASSWORD=
MAKERHUB_CLOAKBROWSER_AUTH_TOKEN=
```

可以分别使用 `openssl rand -hex 32` 生成。`MAKERHUB_POSTGRES_PASSWORD` 建议只使用英文和数字，避免数据库 URL 转义问题。`MAKERHUB_CLOAKBROWSER_AUTH_TOKEN` 是必填的强随机访问令牌，App、Worker 和 CloakBrowser Manager 使用同一个值。

镜像、端口、时区、并发、超时和日志轮转等运行默认值已经直接写在仓库根目录的 `compose.yaml` 中，不需要在 `.env` 里重复配置。默认文件可直接用于完整四容器部署；`.env` 只保存密钥和少量实例差异。

默认数据保存在 `compose.yaml` 同目录的 `./data/` 下：

```text
data/
├── archive/        # 模型、图片、附件和本地导入入口
├── cloakbrowser/   # 浏览器 profile 与会话
├── config/         # 兼容配置、暂存和备份
└── postgres/       # PostgreSQL 数据
```

### 3. 启动

```bash
docker compose up -d
```

默认访问地址：

```text
http://服务器 IP:9042
```

默认账号为 `admin`。新实例会生成一次性随机密码，可以通过下面的命令读取：

```bash
docker compose exec makerhub-app cat /app/config/state/admin-bootstrap-password
```

首次登录后立即修改密码。改密成功后，一次性密码文件会自动删除。Canonical Compose 不通过环境变量传递管理员明文密码。

### 4. 登录 MakerWorld

在 MakerHub 的“设置 → 线上账号”中打开国内站或国际站浏览器，在 CloakBrowser 内完成登录。关联成功后，MakerHub 直接复用该 profile，不再维护一份与浏览器竞争的旧 Cookie。

CloakBrowser Manager 默认只绑定 `127.0.0.1:9050`。如果 MakerHub 位于远端 NAS，需要从其他设备访问 Manager，请在 `.env` 中显式设置可信 LAN 地址：

```env
MAKERHUB_CLOAKBROWSER_BIND_ADDRESS=192.168.1.20
MAKERHUB_CLOAKBROWSER_PUBLIC_URL=http://192.168.1.20:9050
```

也可以把 `MAKERHUB_CLOAKBROWSER_PUBLIC_URL` 设置为受控反向代理地址。开放 Manager 会扩大攻击面，必须限制防火墙来源，禁止直接暴露到公网。配置项的通用写法是 `MAKERHUB_CLOAKBROWSER_BIND_ADDRESS=<LAN IP>`。

## DSM 路径示例

现有 DSM 实例不需要移动数据，只需在 `.env` 中覆盖宿主机路径：

```env
MAKERHUB_CONFIG_PATH=/volume4/docker/docker/makerhub
MAKERHUB_ARCHIVE_PATH=/volume2/entertainment/3D打印/makerhub
MAKERHUB_POSTGRES_DATA_PATH=/volume4/docker/docker/makerhub/postgres
MAKERHUB_CLOAKBROWSER_DATA_PATH=/volume4/docker/docker/makerhub/cloakbrowser
```

App 和 Worker 始终共享 `MAKERHUB_CONFIG_PATH` 与 `MAKERHUB_ARCHIVE_PATH`。不要让两个容器指向不同目录。

## 常用配置

大多数运行参数直接使用 `compose.yaml` 中的默认值。通常只有下面这些实例参数需要通过 `.env` 覆盖：

| 变量 | Compose 默认值 | 说明 |
| --- | --- | --- |
| `MAKERHUB_CONFIG_PATH` | `./data/config` | 配置、状态与备份目录 |
| `MAKERHUB_ARCHIVE_PATH` | `./data/archive` | 模型、图片、附件和导入目录 |
| `MAKERHUB_POSTGRES_DATA_PATH` | `./data/postgres` | PostgreSQL 数据目录 |
| `MAKERHUB_CLOAKBROWSER_DATA_PATH` | `./data/cloakbrowser` | 浏览器 profile 与会话目录 |
| `MAKERHUB_CLOAKBROWSER_BIND_ADDRESS` | `127.0.0.1` | Manager 宿主机监听地址 |
| `MAKERHUB_CLOAKBROWSER_PUBLIC_URL` | 空 | 用户浏览器能够访问的 Manager 地址 |
| `MAKERHUB_TRUSTED_PROXIES` | 空 | 允许提供转发头的受控代理地址 |

不要把 `MAKERHUB_TRUSTED_PROXIES` 设置为 `*`、`0.0.0.0/0` 或公网网段。默认不信任 `X-Forwarded-*` 请求头。

## 更新

### 手动更新

```bash
docker compose pull
docker compose up -d --remove-orphans
```

App 和 Worker 在 `compose.yaml` 中使用同一个 MakerHub 镜像，应始终作为同一发布组更新。更新后可以检查：

```bash
docker compose ps
curl -fsS http://127.0.0.1:9042/api/public/health/ready
```

### 网页一键更新

默认 Compose 不挂载 Docker socket，因此 MakerHub 默认不能控制宿主机 Docker。只有在可信内网明确需要网页更新时，才取消 `makerhub-app` 下这行注释：

```yaml
# - /var/run/docker.sock:/var/run/docker.sock
```

网页更新会把 App 和 Worker 作为同一发布组处理，完成 HTTP readiness 与 Worker 心跳校验后再提交；失败时整组回滚。Docker socket 等同于宿主机高权限，不应在不可信环境中开放。

## 从旧版迁移

旧单容器或旧 App / Web 双容器需要先停止，释放 `9042` 端口：

```bash
docker rm -f makerhub
docker rm -f makerhub-api makerhub-web
docker compose up -d --remove-orphans
```

如果设置页提示“需改 Compose”，说明当前部署缺少 Postgres、数据库连接或仍使用旧的分散挂载。首次迁移必须手动替换 `compose.yaml`；旧镜像不能依靠网页更新自动补齐新服务。

历史模型目录可以直接配置为 `MAKERHUB_ARCHIVE_PATH`，无需移动。首次接入 Postgres 后，Worker 会在后台建立模型卡片索引。

## 本地开发

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
npm --prefix frontend install
npm --prefix frontend run build
uvicorn app.main:app --reload
```

后端测试：

```bash
.venv/bin/python -m pytest -q
```

前端测试与构建：

```bash
npm --prefix frontend test
npm --prefix frontend run build
```

## iOS 快捷指令

- [下载“推送到 MakerHub”快捷指令](https://raw.githubusercontent.com/s450586793/makerhub/main/docs/%E6%8E%A8%E9%80%81%E5%88%B0%20MakerHub.shortcut)
- 使用前配置 `MakerHubToken` 和 `MakerHubBaseUrl`。
- 详细说明见 [iOS 快捷指令文档](docs/ios-makerhub-shortcut.md)。

## 文档

- [架构说明](docs/ARCHITECTURE.md)
- [模块索引](docs/MODULES.md)
- [部署与更新](docs/modules/deployment_update.md)
- [任务与 Worker](docs/modules/tasks_worker.md)
- [账号、配置与安全](docs/modules/core.md)
- [完整更新记录](CHANGELOG.md)

## 更新记录

### 2026-07-31 · v0.15.14

- 设置页账号卡与首页统一使用账号健康状态和 3MF gate 作为归档结论，不再让过期的浏览器过程状态覆盖“可归档”等真实状态。
- 指纹浏览器恢复后，即使有效登录 Cookie 没有变化，也会清理旧的“等待登录 / 需要确认”提示并写回“浏览器已同步”；缺少登录 token 时不会误报同步成功。

### 2026-07-31 · v0.15.13

- Global 指纹浏览器 profile 会复用 MakerHub 的 HTTP/HTTPS 代理；新建 profile 和每次启动前都会校验该配置。
- 代理变更时，系统会先停止 Global profile、写入新代理并重新启动，避免浏览器继续使用旧的直连网络；国内 profile 保持用户原有设置并直连。

### 2026-07-31 · v0.15.12

- 修复首页轻量归档队列查询在 Postgres 下将 MakerWorld URL 的 `%` 误判为 SQL 参数，导致接口返回 `500` 并让卡片错误显示为全零的问题。
- 原有订阅、归档任务、本地库与源端刷新数据未被修改；修复后首页会重新读取原持久化数据。

<details>
<summary>历史版本</summary>

### 2026-07-31 · v0.15.11

- 首页账号状态会识别仍在归档队列中等待浏览器验证的 3MF 任务，不再在这类任务存在时笼统显示“可归档”。
- 完成浏览器验证后可直接点击“已验证，继续归档”；系统只恢复一个受阻 3MF 探测任务，确认成功后再按既有流程继续，避免定时 Cookie 检测造成无谓下载。

### 2026-07-30 · v0.15.10

- 指纹浏览器启动、Xvnc 或 CDP 发生瞬时故障后，同一 profile 会进入跨 App/Worker 的冷却期；自动归档、同步和抓取请求直接短路，不再持续重复启动。
- Worker 会复用 2 分钟内已同步的浏览器登录态，不再为每个归档子任务重复读取一次 profile。
- 用户打开浏览器后的自动同步首次遇到浏览器服务不可用即停止轮询，并明确保留“服务暂时不可用”状态，不会误提示重新登录。

### 2026-07-30 · v0.15.9

- MakerWorld 返回“今日下载次数已达到上限”、`daily quota` 等限额文案时，会优先识别为平台每日上限，即使上游状态码或字段同时表现为浏览器验证。
- 每日上限会立即写入对应站点的 3MF 限额守卫，暂停当天后续 3MF 重试，并让首页账号卡显示“今日下载受限”。
- 从指纹浏览器同步 Cookie 不再覆盖当天已经确认的每日上限状态，避免卡片退回“检测中”。

### 2026-07-30 · v0.15.8

- 首页已关联指纹浏览器的账号卡现在会启动对应 profile 并自动进入 MakerWorld 登录页，与设置页“打开浏览器”使用同一流程；未关联账号继续打开官网。
- 点击时预开浏览器窗口，等待后端启动 profile 后再跳转，避免异步操作被浏览器拦截。

### 2026-07-29 · v0.15.7

- 关注收藏夹同步改为读取 MakerWorld 当前的 `collections/likes` 页面，并以页面实际可访问总数为准，不再因旧接口与过期统计显示“0 已同步”。
- 订阅来源卡在新快照生成前继续显示上一张有效图片；每个订阅归档批次完成后立即重建对应四宫格，不再等到下次同步或 App 重启。

### 2026-07-28 · v0.15.6

- 兼容 CloakBrowser 将隐藏 target 暴露为 `other` 类型的行为：API 抓取直接通过原始 CDP 完成，不再要求 Puppeteer 将隐藏 target 转换为 `Page`。
- `3MF` 真实点击使用后台 page target，并继续按 `targetId` 强制回收；DSM 实测国内站 API 返回 `200`，请求结束后没有残留 API target。

更早版本的完整说明见 [CHANGELOG.md](CHANGELOG.md)。

</details>
