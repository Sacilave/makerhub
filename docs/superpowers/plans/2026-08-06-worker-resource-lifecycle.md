# Worker Resource Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound idle worker and CloakBrowser resource use while preserving automatic recovery and all active workflows.

**Architecture:** Add small, testable lifecycle helpers around existing managers. Queue state drives scheduler backpressure, process activity drives safe worker recycling, and shared profile activity markers coordinate CloakBrowser idle shutdown across processes.

**Tech Stack:** Python 3, threading, JSON state files, pytest/unittest, Docker Compose.

## Global Constraints

- Never interrupt active archive, subscription, refresh, index, organizer, preview, login, or browser work.
- Keep the CloakBrowser Manager running; only stop idle profiles.
- Preserve current Compose `restart: unless-stopped` behavior.
- Default worker recycle threshold is 2048 MiB and default profile idle timeout is 1800 seconds; zero disables each feature.

---

### Task 1: Blocked archive queue scheduling

**Files:**
- Modify: `app/worker.py`
- Modify: `app/services/subscriptions.py`
- Test: `tests/test_worker_runtime.py`
- Test: `tests/test_subscriptions.py`

**Interfaces:**
- Consumes: normalized archive queue dictionaries.
- Produces: `archive_queue_has_executable_work(queue: dict) -> bool` and subscription launch gating.

- [ ] Write tests proving paused-only queues use idle polling and block scheduled subscription scans.
- [ ] Run the focused tests and verify they fail for the missing behavior.
- [ ] Implement executable-work detection and subscription backpressure while leaving cookie synchronization enabled.
- [ ] Run the focused tests and verify they pass.

### Task 2: Process cache and RSS lifecycle

**Files:**
- Create: `app/services/process_memory.py`
- Modify: `app/services/catalog.py`
- Modify: `app/services/local_organizer.py`
- Modify: `app/worker.py`
- Test: `tests/test_process_memory.py`
- Test: `tests/test_worker_runtime.py`
- Test: `tests/test_local_organizer.py`

**Interfaces:**
- Produces: `process_rss_mib() -> float`, `release_process_memory() -> dict`, `release_catalog_memory() -> None`, and organizer idle cache release.

- [ ] Write tests for RSS parsing, threshold disabling, complete-idle gating, catalog cache reset, and organizer cache reset.
- [ ] Run the focused tests and verify they fail for the missing behavior.
- [ ] Implement best-effort garbage collection and glibc trimming plus cache reset functions.
- [ ] Integrate idle release and high-RSS worker exit only after all managers report no active work.
- [ ] Run the focused tests and verify they pass.

### Task 3: CloakBrowser idle profile shutdown

**Files:**
- Modify: `app/services/cloakbrowser_session.py`
- Modify: `app/worker.py`
- Test: `tests/test_cloakbrowser_session.py`

**Interfaces:**
- Produces: profile activity markers and `stop_idle_profiles(idle_seconds: int | None = None) -> dict`.

- [ ] Write tests for recent, busy, stopped, missing-marker, and expired profiles.
- [ ] Run the focused tests and verify they fail for the missing behavior.
- [ ] Wrap browser operations with shared activity tracking.
- [ ] Implement the profile janitor with resource-slot recheck and add it to the worker loop.
- [ ] Run the focused tests and verify they pass.

### Task 4: Release metadata and verification

**Files:**
- Modify: version source files identified by the repository release pattern.
- Modify: `.env.example`
- Modify: `compose.yaml`
- Modify: `README.md`

**Interfaces:**
- Documents: `MAKERHUB_WORKER_RECYCLE_RSS_MIB` and `MAKERHUB_CLOAKBROWSER_IDLE_SECONDS`.

- [ ] Bump the patch version from `0.15.22` to `0.15.23`.
- [ ] Add the two environment defaults to Compose and configuration documentation.
- [ ] Run focused tests, the full Python suite, and frontend tests/build.
- [ ] Review the exact diff and commit only task-owned files with a Chinese commit message.
