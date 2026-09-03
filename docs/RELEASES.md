# Release Architecture

MakerHub 的 Windows 与 Linux Release 使用同一份经过验证的 Linux/amd64 容器镜像。

## 为什么不做两套原生后端

MakerHub 依赖 PostgreSQL、Worker、CloakBrowser Browser Profile 和长期任务恢复。将 Windows 改造成独立 PyInstaller + 嵌入式数据库，而 Linux 继续使用 Docker，会产生两套运行语义和两套故障面。

Release 因此采用同一个不可变 MakerHub image digest：Windows 使用 Docker Desktop + WSL2，Linux 使用 Docker Engine + Compose v2。两个平台运行完全相同的 App / Worker / PostgreSQL / CloakBrowser 组合。

## Release Gate

正式发布前必须通过：后端 pytest、前端测试与 build、security invariants、完整 Compose、PostgreSQL、Worker heartbeat、CloakBrowser 网络、bootstrap 管理员登录、authenticated API flow、AES-GCM at-rest 检查、`archive_queue` JSONB 检查、App / Worker 重启恢复、两个平台 bundle 校验和 SHA256。

候选镜像先以本地 tag 完成 E2E，之后才推送 GHCR。取得 digest 后，Release bundle 固定到：

```text
ghcr.io/sacilave/makerhub@sha256:<digest>
```

workflow 随后退出 GHCR 登录并执行匿名 `docker pull`；匿名拉取失败时禁止发布。

Release 使用仓库唯一的 `VERSION` 作为版本来源，Git tag 为 `v<VERSION>`。不维护第二套私有版本号，避免和 Web 自更新、前端包版本与 CHANGELOG 分叉。

## MakerWorld Live Canary

真实 MakerWorld 登录无法在 CI 中伪造。完成 CloakBrowser 登录后，在准备发布的 exact `main` commit 上运行：

```bash
python scripts/live_account_canary.py \
  --password '<MakerHub管理员密码>' \
  --url 'https://makerworld.com/@your-handle/collections/likes'
```

Canary 只做归档预扫描，不主动下载 3MF；若源端提供严格总数，则要求 `discovered_count == expected_total`。

成功后会生成：

```text
live-canary-result.json
```

其中包含 `source_commit`。Tag Gate 必须同时输入这个 40 位 SHA，并且它必须等于当前 `main` 的 `GITHUB_SHA`。只要代码之后又发生任何变化，就必须重新执行 Live Canary，旧证据不能用于放行新提交。

## 必填实例秘密

源码部署和 Release 都会依赖两个实例级秘密：

```text
MAKERHUB_POSTGRES_PASSWORD
MAKERHUB_CLOAKBROWSER_AUTH_TOKEN
```

Release 启动器会自动生成它们；源码部署可运行 `python scripts/bootstrap_secrets.py`。不要把真实值提交进 Git。

如果使用可信反向代理，可按需要配置：

```text
MAKERHUB_TRUSTED_PROXIES
```

## 跨版本数据继承

Release 默认把 `.env`、`secrets/` 与 `data/` 放在当前实例目录。跨版本升级时应保留这三部分，只替换新的 `compose.yaml` 和平台启动器；否则新目录会被视为一套全新实例。

也可以在 `.env` 中为 Config、Archive、PostgreSQL 与 CloakBrowser 设置固定绝对路径，使不同 Release 文件夹始终连接同一份持久化数据。
