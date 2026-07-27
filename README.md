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

> 当前版本：`v0.15.1`
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

### 1. 下载部署文件

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

### 2026-07-28 · v0.15.1

- 镜像、端口、时区、并发、超时和日志轮转等稳定默认值直接写入公开的 `compose.yaml`。
- `.env.example` 只保留必填密钥和少量实例覆盖项，默认四容器部署无需重复填写常规参数。

### 2026-07-27 · v0.15.0

- Compose 改为可移植路径，默认数据写入项目 `./data/`，DSM、Unraid 和其他 NAS 通过 `.env` 覆盖宿主机目录。
- 新增安全的 `.env.example`、Docker 日志轮转、可配置端口和镜像，并将新部署 Worker 默认并发统一为 `4`。
- 精简 GitHub README，安装、浏览器登录、DSM 迁移和更新流程改为单一入口。

### 2026-07-27 · v0.14.4

- 指纹浏览器验证恢复期间，`3MF` 下载子任务成功后会继续放行下一个暂停任务。
- 恢复链保持单任务探测，再次遇到验证或下载失败时停止，避免批量消耗下载次数。

<details>
<summary>历史版本</summary>

更早版本的完整说明见 [CHANGELOG.md](CHANGELOG.md)。

</details>
