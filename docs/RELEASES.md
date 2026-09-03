# Release Architecture

MakerHub 的 Windows 与 Linux Release 使用同一份经过验证的 Linux/amd64 容器镜像。

## 为什么不做两套原生后端

MakerHub 依赖 PostgreSQL、Worker、CloakBrowser Browser Profile 和长期任务恢复。将 Windows 改造成独立 PyInstaller + 嵌入式数据库，而 Linux 继续使用 Docker，会产生两套运行语义和两套故障面。

Release 因此采用同一个不可变 MakerHub image digest，Windows 使用 Docker Desktop + WSL2，Linux 使用 Docker Engine + Compose v2。

## Release Gate

正式发布前必须通过：后端 pytest、前端测试与 build、security invariants、完整 Compose、PostgreSQL、Worker heartbeat、CloakBrowser 网络、bootstrap 管理员登录、authenticated API flow、AES-GCM at-rest 检查、archive_queue JSONB 检查、重启恢复、两个平台 bundle 校验和 SHA256。

## MakerWorld Live Canary

真实 MakerWorld 登录无法在 CI 中伪造。完成 CloakBrowser 登录后运行：

```bash
python scripts/live_account_canary.py --password '<MakerHub管理员密码>' --url 'https://makerworld.com/@your-handle/collections/likes'
```

Canary 只做归档预扫描，不主动下载 3MF；若源端提供严格总数，则要求 `discovered_count == expected_total`。正式 Release workflow 还要求人工确认该 exact main commit 的 live canary 已通过。
