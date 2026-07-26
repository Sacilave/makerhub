# CloakBrowser-Only Fetch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 CloakBrowser 的持久化 profile 完全替代 MakerWorld 控制面 FlareSolverr 请求，同时保留静态资源直连和全部历史数据。

**Architecture:** 扩展现有 Puppeteer CDP bridge，以短生命周期后台标签页返回结构化 HTTP 响应；Python 侧增加统一 MakerWorld 浏览器客户端，按平台选择已关联 profile，并逐个替换 HTML/JSON 调用点。迁移完成后删除 FlareSolverr 代码、Compose 服务和升级配置，旧内置容器只在新 App/Worker readiness 成功后清理。

**Tech Stack:** Python 3.11、requests、Puppeteer Core、FastAPI、Docker Compose、unittest/pytest、Node.js 20。

## Global Constraints

- 发布版本固定为 `0.14.0`，不推送 GitHub，除非用户另行明确要求。
- 不修改数据库记录、历史任务、历史日志或归档目录。
- 控制面仅允许访问 MakerWorld 与 Bambu API 的 HTTPS 域名。
- 已关联 profile 的浏览器 Cookie 优先，禁止用 MakerHub 旧 Cookie 覆盖。
- 图片、附件和已取得签名直链的 3MF 继续由 MakerHub 普通下载器处理。
- 同一 profile 的控制面请求通过现有跨进程 `resource_slot` 串行化。
- CloakBrowser 瞬时故障只能标记为网络错误，不得触发重新登录。
- 用户正在操作的标签页不得被后台归档导航或关闭。

---

### Task 1: CloakBrowser 结构化抓取 Bridge

**Files:**
- Modify: `app/services/cloakbrowser_bridge.mjs`
- Modify: `app/services/cloakbrowser_session.py`
- Modify: `tests/test_cloakbrowser_session.py`

**Interfaces:**
- Consumes: `ensure_profile(platform, profile_id)`、`launch_profile(profile)`、`resource_slot(name)`、`browser_cookie_items(raw_cookie, platform, structured_items=None)`。
- Produces: `CloakBrowserFetchResult` 和 `browser_fetch(platform, url, *, profile_id="", headers=None, cookie_items=None, timeout_seconds=None)`。

- [ ] **Step 1: 写 URL、防泄漏和临时页面生命周期失败测试**

```python
def test_browser_fetch_rejects_non_makerworld_target(self):
    with self.assertRaisesRegex(cloakbrowser_session.CloakBrowserError, "目标地址"):
        cloakbrowser_session.browser_fetch("cn", "https://example.com/private")

def test_browser_fetch_passes_fetch_action_and_returns_structured_result(self):
    with patch.object(cloakbrowser_session, "ensure_profile", return_value=profile), \
         patch.object(cloakbrowser_session, "launch_profile", return_value=(profile, False)), \
         patch.object(cloakbrowser_session, "_run_bridge", return_value={
             "status_code": 200,
             "url": "https://makerworld.com.cn/zh/models/1",
             "content_type": "text/html; charset=utf-8",
             "text": "<html>ok</html>",
         }) as bridge:
        result = cloakbrowser_session.browser_fetch("cn", "https://makerworld.com.cn/zh/models/1")
    self.assertEqual(result.status_code, 200)
    self.assertEqual(bridge.call_args.args[0]["action"], "fetch")
```

- [ ] **Step 2: 运行测试并确认失败**

Run: `python -m pytest tests/test_cloakbrowser_session.py -q`

Expected: FAIL，提示 `browser_fetch` 或 `CloakBrowserFetchResult` 尚不存在。

- [ ] **Step 3: 实现低层接口与 bridge 动作**

```python
@dataclass(frozen=True)
class CloakBrowserFetchResult:
    profile_id: str
    url: str
    status_code: int
    content_type: str
    text: str

def browser_fetch(
    platform: str,
    url: str,
    *,
    profile_id: str = "",
    headers: dict[str, str] | None = None,
    cookie_items: list[dict[str, Any]] | None = None,
    timeout_seconds: int | None = None,
) -> CloakBrowserFetchResult:
    clean_platform = normalize_platform(platform)
    clean_url = _validate_browser_target(url, clean_platform)
    with resource_slot(_profile_resource_name(clean_platform, profile_id), detail="fetch"):
        profile = ensure_profile(clean_platform, profile_id)
        running, _launched_here = launch_profile(profile)
        payload = _bridge_payload(running.id, action="fetch", target_url=clean_url, platform=clean_platform)
        payload["headers"] = _safe_browser_headers(headers)
        payload["cookies"] = cookie_items or []
        result = _run_bridge(payload, timeout_seconds=timeout_seconds)
    return CloakBrowserFetchResult(
        profile_id=running.id,
        url=_validate_browser_target(str(result.get("url") or clean_url), clean_platform),
        status_code=max(int(result.get("status_code") or 0), 0),
        content_type=str(result.get("content_type") or ""),
        text=str(result.get("text") or ""),
    )
```

JavaScript `fetch` 动作必须：校验输入、`context.newPage()`、过滤危险 header、`page.goto()`、读取响应正文，并在 `finally` 中执行 `page.close()`。最终重定向 URL 再做一次域名校验，响应头只返回 `content-type`、`retry-after` 和 `location`。

- [ ] **Step 4: 验证 Python 测试和 JavaScript 语法**

Run: `python -m pytest tests/test_cloakbrowser_session.py -q`

Expected: PASS。

Run: `node --check app/services/cloakbrowser_bridge.mjs`

Expected: exit code 0。

- [ ] **Step 5: 提交底层 bridge**

```bash
git add app/services/cloakbrowser_bridge.mjs app/services/cloakbrowser_session.py tests/test_cloakbrowser_session.py
git commit -m "feat: 增加指纹浏览器抓取通道"
```

### Task 2: MakerWorld 浏览器客户端

**Files:**
- Create: `app/services/makerworld_browser_client.py`
- Create: `tests/test_makerworld_browser_client.py`
- Delete: `app/services/flaresolverr_client.py`
- Delete: `tests/test_flaresolverr_client.py`

**Interfaces:**
- Consumes: `browser_fetch(platform, url, profile_id="", headers=None, cookie_items=None, timeout_seconds=None)`、`JsonStore.load()`、`CookiePair.browser_profile_id`。
- Produces: `MakerWorldBrowserResponse`、`MakerWorldBrowserError`、`MakerWorldBrowserJsonError`、`makerworld_browser_get()`、`makerworld_browser_get_text()`、`makerworld_browser_get_json()`。

- [ ] **Step 1: 写平台选择、profile 优先和 JSON 分类失败测试**

```python
def test_linked_profile_does_not_seed_stale_cookie():
    config = SimpleNamespace(cookies=[SimpleNamespace(
        platform="cn", browser_profile_id="profile-cn", cookie="token=old"
    )])
    with patch.object(client.JsonStore, "load", return_value=config), \
         patch.object(client, "browser_fetch", return_value=_fetch_result()) as fetch:
        client.makerworld_browser_get("https://makerworld.com.cn/zh/models/1", raw_cookie="token=old")
    self.assertEqual(fetch.call_args.kwargs["profile_id"], "profile-cn")
    self.assertEqual(fetch.call_args.kwargs["cookie_items"], [])

def test_unlinked_profile_can_seed_legacy_cookie():
    config = SimpleNamespace(cookies=[SimpleNamespace(
        platform="cn", browser_profile_id="", cookie="token=legacy"
    )])
    with patch.object(client.JsonStore, "load", return_value=config), \
         patch.object(client, "browser_fetch", return_value=_fetch_result()) as fetch:
        client.makerworld_browser_get("https://makerworld.com.cn/zh/models/1", raw_cookie="token=legacy")
    self.assertEqual(fetch.call_args.kwargs["profile_id"], "")
    self.assertTrue(fetch.call_args.kwargs["cookie_items"])

def test_get_json_rejects_html_unless_allow_non_json():
    response = client.MakerWorldBrowserResponse(
        url="https://api.bambulab.cn/v1/design-service/design/1",
        status_code=200,
        content_type="text/html",
        text="<html>login</html>",
        profile_id="profile-cn",
    )
    with patch.object(client, "makerworld_browser_get", return_value=response):
        with self.assertRaises(client.MakerWorldBrowserJsonError):
            client.makerworld_browser_get_json(response.url)
        self.assertIsNone(client.makerworld_browser_get_json(response.url, allow_non_json=True))
```

- [ ] **Step 2: 运行新客户端测试并确认失败**

Run: `python -m pytest tests/test_makerworld_browser_client.py -q`

Expected: FAIL，提示模块不存在。

- [ ] **Step 3: 实现兼容现有调用形状的浏览器客户端**

```python
def makerworld_browser_get(
    url: str,
    *,
    raw_cookie: str = "",
    headers: dict[str, str] | None = None,
    params: dict[str, Any] | None = None,
    session: requests.Session | None = None,
    platform: str = "",
) -> MakerWorldBrowserResponse:
    clean_platform = normalize_makerworld_platform(platform, url)
    target_url = url_with_params(url, params)
    profile_id, linked = linked_profile(clean_platform)
    cookie_items = [] if linked else browser_cookie_items(raw_cookie, clean_platform)
    result = browser_fetch(
        clean_platform,
        target_url,
        profile_id=profile_id,
        headers=headers,
        cookie_items=cookie_items,
    )
    return MakerWorldBrowserResponse(
        url=result.url,
        status_code=result.status_code,
        content_type=result.content_type,
        text=result.text,
        profile_id=result.profile_id,
    )

def makerworld_browser_get_json(
    url: str,
    *,
    allow_non_json: bool = False,
    **kwargs: Any,
) -> Any:
    response = makerworld_browser_get(url, **kwargs)
    try:
        return json.loads(response.text)
    except (TypeError, json.JSONDecodeError) as exc:
        if allow_non_json:
            return None
        raise MakerWorldBrowserJsonError("CloakBrowser 响应不是有效 JSON。") from exc
```

客户端对 Manager `5xx`、CDP timeout 和连接断开只重试一次 GET；异常信息不得包含 Cookie、Token 或完整查询串。旧 FlareSolverr 模块只在 Task 3 和 Task 4 的所有生产引用迁完后删除；如果此步骤尚有引用，先保留文件到 Task 4 再删除。

- [ ] **Step 4: 运行客户端和 Session 测试**

Run: `python -m pytest tests/test_makerworld_browser_client.py tests/test_cloakbrowser_session.py -q`

Expected: PASS。

- [ ] **Step 5: 提交客户端**

```bash
git add app/services/makerworld_browser_client.py tests/test_makerworld_browser_client.py app/services/cloakbrowser_session.py
git commit -m "feat: 增加 MakerWorld 浏览器客户端"
```

### Task 3: 迁移单模型、评论与 3MF 控制请求

**Files:**
- Modify: `app/services/legacy_archiver.py`
- Modify: `tests/test_legacy_archiver_validation.py`
- Modify: `tests/test_comment_replies.py`
- Modify: `tests/test_missing_3mf.py`

**Interfaces:**
- Consumes: Task 2 的 `makerworld_browser_get_text()` 和 `makerworld_browser_get_json()`。
- Produces: `fetch_html_with_browser(session, url, raw_cookie)`，以及不含 FlareSolverr 的单模型、评论和 3MF 控制链路。

- [ ] **Step 1: 将测试预期改为浏览器客户端并确认失败**

```python
class _ApiSession:
    def get(self, *_args, **_kwargs):
        raise AssertionError("MakerWorld control requests must use CloakBrowser")

with patch.object(legacy_archiver, "makerworld_browser_get_json", side_effect=fake_browser):
    design = legacy_archiver.fetch_design_from_api(
        _ApiSession(),
        "token=access",
        "https://makerworld.com.cn/zh/models/2416065",
    )
```

评论与 3MF 测试分别断言控制 API 使用 `makerworld_browser_get_json`，静态文件保存仍不调用浏览器客户端。

- [ ] **Step 2: 运行目标回归并确认失败**

Run: `python -m pytest tests/test_legacy_archiver_validation.py tests/test_comment_replies.py tests/test_missing_3mf.py -q`

Expected: FAIL，仍引用 FlareSolverr 名称。

- [ ] **Step 3: 替换 legacy archiver 调用与日志文案**

```python
def fetch_html_with_browser(session: requests.Session, url: str, raw_cookie: str) -> str | None:
    headers = _browser_control_headers(session, url, raw_cookie)
    try:
        return makerworld_browser_get_text(url, raw_cookie=raw_cookie, headers=headers, session=session)
    except MakerWorldBrowserError as exc:
        log("CloakBrowser 获取页面失败:", exc)
        return None
```

3MF 真实授权继续走 `browser_authorize_3mf_download()`；不得对点击授权做客户端内部重试。批量瞬时错误识别增加 CloakBrowser timeout、断开和 `HTTP 5xx` 文案。

- [ ] **Step 4: 运行单模型、评论和 3MF 回归**

Run: `python -m pytest tests/test_legacy_archiver_validation.py tests/test_comment_replies.py tests/test_missing_3mf.py tests/test_archive_worker_browser_recovery.py tests/test_archive_worker_batch_retry.py -q`

Expected: PASS。

- [ ] **Step 5: 提交主归档迁移**

```bash
git add app/services/legacy_archiver.py tests/test_legacy_archiver_validation.py tests/test_comment_replies.py tests/test_missing_3mf.py app/services/archive_worker.py tests/test_archive_worker_batch_retry.py
git commit -m "refactor: 迁移归档控制请求到指纹浏览器"
```

### Task 4: 迁移批量来源、来源卡与账号探测

**Files:**
- Modify: `app/services/batch_discovery.py`
- Modify: `app/services/source_library.py`
- Modify: `app/services/source_health.py`
- Modify: `tests/test_batch_discovery.py`
- Modify: `tests/test_source_health.py`
- Modify: `tests/test_source_library.py`
- Modify: `tests/test_subscriptions.py`
- Delete: `app/services/flaresolverr_client.py`
- Delete: `tests/test_flaresolverr_client.py`

**Interfaces:**
- Consumes: Task 2 客户端和 Task 3 的 `fetch_html_with_browser()`。
- Produces: 所有生产控制面调用统一使用 CloakBrowser，调试 `engine` 固定为 `cloakbrowser`。

- [ ] **Step 1: 更新批量与账号探测测试，增加实际状态码传递断言**

```python
with patch.object(batch_discovery, "makerworld_browser_get_json", return_value=payload):
    result = batch_discovery._api_get_json(
        requests.Session(),
        "https://makerworld.com.cn/zh/@maker/upload",
        "token=access",
        "search-service",
        "/designs",
        {"limit": 20, "offset": 0},
    )

with patch.object(source_health, "makerworld_browser_get", return_value=SimpleNamespace(
    status_code=403, text="<html>login</html>", url=probe_url
)):
    result = source_health._probe_platform_web_page("cn", cookie, proxy)
self.assertEqual(result["state"], "auth_required")
```

- [ ] **Step 2: 运行批量与账号测试并确认失败**

Run: `python -m pytest tests/test_batch_discovery.py tests/test_source_health.py -q`

Expected: FAIL，调用点仍依赖 FlareSolverr。

- [ ] **Step 3: 完成剩余调用点迁移并删除旧客户端**

替换导入、函数名、错误类型、日志和调试 `engine`；使用 `rg -n "flaresolverr|FlareSolverr|FLARESOLVERR" app --glob '*.py'` 确认只剩历史迁移兼容文案或自更新清理常量。

- [ ] **Step 4: 运行相关回归和生产引用扫描**

Run: `python -m pytest tests/test_batch_discovery.py tests/test_source_health.py tests/test_legacy_archiver_validation.py tests/test_comment_replies.py tests/test_missing_3mf.py -q`

Expected: PASS。

Run: `rg -n "from app.services.flaresolverr_client|flaresolverr_get" app tests`

Expected: 无结果。

- [ ] **Step 5: 提交剩余业务迁移**

```bash
git add app/services/batch_discovery.py app/services/source_library.py app/services/source_health.py app/services/flaresolverr_client.py tests/test_batch_discovery.py tests/test_source_health.py tests/test_flaresolverr_client.py
git commit -m "refactor: 统一 MakerWorld 浏览器抓取链路"
```

### Task 5: 移除 FlareSolverr 部署依赖与清理旧容器

**Files:**
- Modify: `compose.yaml`
- Delete: `compose.external-flaresolverr.yaml`
- Modify: `.github/workflows/docker.yml`
- Modify: `app/services/self_update.py`
- Modify: `tests/test_self_update.py`
- Modify: `tests/test_release_contract.py`
- Modify: `docs/modules/deployment_update.md`

**Interfaces:**
- Consumes: 现有 `DockerSocketClient.list_containers()`、`remove_container()` 和 release group readiness 事务。
- Produces: 四服务 canonical compose 和 `_cleanup_obsolete_bundled_containers(client, request_id)`。

- [ ] **Step 1: 写四服务 Compose 与成功后清理测试**

```python
def test_canonical_compose_has_no_flaresolverr_service_or_environment(self):
    compose = yaml.safe_load((ROOT_DIR / "compose.yaml").read_text(encoding="utf-8"))
    self.assertEqual(set(compose["services"]), {
        "makerhub-app", "makerhub-worker", "makerhub-postgres", "cloakbrowser"
    })
    self.assertNotIn("MAKERHUB_FLARESOLVERR_URL", compose["services"]["makerhub-app"]["environment"])

def test_update_removes_exact_legacy_flaresolverr_only_after_readiness(self):
    client = Mock()
    client.list_containers.return_value = [
        {"Id": "legacy", "Names": ["/makerhub-flaresolverr"]},
        {"Id": "shared", "Names": ["/shared-flaresolverr"]},
    ]
    removed = self_update._cleanup_obsolete_bundled_containers(client, "request-1")
    self.assertEqual(removed, ["legacy"])
    client.remove_container.assert_called_once_with("legacy", force=True, missing_ok=True)

def test_update_does_not_cleanup_obsolete_container_when_readiness_fails(self):
    with patch.object(self_update, "verify_release_group", side_effect=RuntimeError("not ready")), \
         patch.object(self_update, "_cleanup_obsolete_bundled_containers") as cleanup:
        result = self_update.run_update_helper(
            request_id="request-1",
            container_id="app-old",
            image_ref="ghcr.io/example/makerhub:v0.14.0",
        )
    self.assertEqual(result, 1)
    cleanup.assert_not_called()
```

清理测试必须断言 readiness 失败时不删除，成功时只删除 `Names` 含精确 `/makerhub-flaresolverr` 的容器，不删除外部自定义名称。

- [ ] **Step 2: 运行部署契约并确认失败**

Run: `python -m pytest tests/test_self_update.py tests/test_release_contract.py -q`

Expected: FAIL，canonical compose 仍含 FlareSolverr。

- [ ] **Step 3: 修改 Compose、CI 与成功后 best-effort 清理**

```python
OBSOLETE_BUNDLED_CONTAINER_NAMES = {"makerhub-flaresolverr"}

def _cleanup_obsolete_bundled_containers(client: DockerSocketClient, request_id: str) -> list[str]:
    removed: list[str] = []
    for item in client.list_containers(all_containers=True):
        names = {str(name).lstrip("/") for name in item.get("Names") or []}
        if not names.intersection(OBSOLETE_BUNDLED_CONTAINER_NAMES):
            continue
        container_id = str(item.get("Id") or "")
        if not container_id:
            continue
        client.remove_container(container_id, force=True, missing_ok=True)
        removed.append(container_id)
    return removed
```

在 `verify_release_group()` 和 `commit_release_group()` 成功之后调用清理函数；清理失败写 warning，不把已经健康的新版本回滚。CI 只执行 `docker compose -f compose.yaml config --quiet`。

- [ ] **Step 4: 验证 Compose 和部署测试**

Run: `docker compose -f compose.yaml config --quiet`

Expected: exit code 0。

Run: `python -m pytest tests/test_self_update.py tests/test_release_contract.py -q`

Expected: PASS。

- [ ] **Step 5: 提交部署迁移**

```bash
git add compose.yaml compose.external-flaresolverr.yaml .github/workflows/docker.yml app/services/self_update.py tests/test_self_update.py tests/test_release_contract.py docs/modules/deployment_update.md
git commit -m "refactor: 移除 FlareSolverr 部署依赖"
```

### Task 6: 版本、文档与全量验证

**Files:**
- Modify: `VERSION`
- Modify: `frontend/package.json`
- Modify: `frontend/package-lock.json`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/modules/core.md`
- Modify: `docs/modules/archive.md`
- Modify: any current operational docs found by `rg -n "FlareSolverr|flaresolverr|FLARESOLVERR" README.md CHANGELOG.md docs .github compose.yaml`

**Interfaces:**
- Consumes: Tasks 1-5 的最终行为。
- Produces: 一致的 `0.14.0` 版本元数据、最新三版 README 记录和无现行 FlareSolverr 操作说明的文档。

- [ ] **Step 1: 先更新版本契约测试期望并运行失败检查**

Run: `python scripts/check_release_version.py`

Expected: 在只修改部分版本文件时失败，证明契约能发现不一致。

- [ ] **Step 2: 将版本文件统一到 0.14.0 并更新最新说明**

```text
VERSION=0.14.0
frontend package version=0.14.0
README current version=v0.14.0
CHANGELOG newest heading=2026-07-27 · v0.14.0
```

README 直接展示最新三版，其余记录保持折叠；历史 release 文案中的 FlareSolverr 保留，不改写历史。

- [ ] **Step 3: 运行目标和完整后端测试**

Run: `python -m pytest -q`

Expected: 全部 PASS。

- [ ] **Step 4: 运行前端、语法、版本、Compose 和镜像验证**

Run: `npm test --prefix frontend`

Expected: 全部 PASS。

Run: `npm run build --prefix frontend`

Expected: 构建成功。

Run: `node --check app/services/cloakbrowser_bridge.mjs`

Expected: exit code 0。

Run: `python scripts/check_release_version.py`

Expected: exit code 0。

Run: `docker compose -f compose.yaml config --quiet`

Expected: exit code 0。

Run: `docker build -t makerhub:cloakbrowser-only-verify .`

Expected: 构建成功。

Run: `docker run --rm makerhub:cloakbrowser-only-verify python -c "import app.main; print('ok')"`

Expected: 输出 `ok`。

- [ ] **Step 5: 自我复查和最终提交**

Run: `rg -n "flaresolverr|FlareSolverr|FLARESOLVERR" app compose.yaml .github README.md docs tests`

Expected: 只剩历史 release 记录、旧部署精确容器清理常量和对应迁移测试。

Run: `git diff --check`

Expected: 无输出。

```bash
git add VERSION frontend/package.json frontend/package-lock.json README.md CHANGELOG.md docs/modules/core.md docs/modules/archive.md
git commit -m "chore: 发布 CloakBrowser 单通道版本"
```
