# Worker Resource Lifecycle Design

## Goal

Reduce idle MakerHub worker memory and CloakBrowser CPU/memory without interrupting active archive, subscription, refresh, index, organizer, preview, login, or browser work.

## Design

1. Treat an archive queue containing only `paused` or otherwise non-executable tasks as blocked work. The worker main loop uses the idle polling interval for this queue, and scheduled subscription scans wait until the archive backlog has executable capacity. Cookie-source synchronization remains allowed because it can restore account state.
2. Add explicit process-memory helpers. Idle passes release catalog and organizer in-memory indexes, run Python garbage collection, and ask glibc to return free heap pages when supported.
3. Add a high-RSS worker recycle guard, defaulting to 2048 MiB. Recycling is allowed only when archive, subscription, source refresh, model-index rebuild, local organizer, and preview work are all inactive. Exiting the worker process relies on Compose `restart: unless-stopped` to start a clean process.
4. Track CloakBrowser profile activity in shared state files. Every browser operation marks its profile active before entering its cross-process resource slot and touches the marker again when it finishes. A worker janitor stops a running profile after 30 minutes of inactivity, rechecking activity after acquiring the same profile slot. The CloakBrowser Manager container remains running, and the existing launch path restarts a stopped profile on demand.

## Failure Handling

- Memory inspection, `malloc_trim`, activity-marker I/O, profile listing, and profile stopping are best effort and cannot fail the worker loop.
- A missing or unreadable activity marker is initialized from the current time before an idle stop is considered, preventing immediate shutdown after an upgrade.
- A profile is never stopped without taking its platform/profile resource slot and rechecking its activity timestamp.
- Setting `MAKERHUB_WORKER_RECYCLE_RSS_MIB=0` disables worker recycling. Setting `MAKERHUB_CLOAKBROWSER_IDLE_SECONDS=0` disables profile idle shutdown.

## Test Strategy

- Unit-test blocked queue polling and subscription launch backpressure.
- Unit-test memory thresholds, complete-idle gating, cache release, and unsupported-platform behavior.
- Unit-test recent, busy, stopped, missing-marker, and expired CloakBrowser profiles.
- Run focused tests, the full Python suite, and the frontend test/build pipeline.

