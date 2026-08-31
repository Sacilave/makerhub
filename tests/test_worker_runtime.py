from unittest.mock import Mock, patch

from app import worker


def test_idle_worker_uses_backoff_after_archive_and_index_work_are_quiet():
    resolver = getattr(worker, "worker_poll_seconds", None)
    assert callable(resolver), "worker must expose worker_poll_seconds()"

    assert resolver({"queued_count": 0, "running_count": 0}, rebuild_running=False) == worker.WORKER_IDLE_POLL_SECONDS
    assert resolver({"queued_count": 1, "running_count": 0}, rebuild_running=False) == worker.WORKER_POLL_SECONDS
    assert resolver({"queued_count": 0, "running_count": 1}, rebuild_running=False) == worker.WORKER_POLL_SECONDS
    assert resolver({"queued_count": 0, "running_count": 0}, rebuild_running=True) == worker.WORKER_POLL_SECONDS


def test_worker_uses_idle_backoff_when_archive_queue_only_contains_paused_tasks():
    queue = {
        "queued_count": 2,
        "running_count": 0,
        "queued": [
            {"id": "paused-1", "status": "paused"},
            {"id": "paused-2", "status": "paused"},
        ],
    }

    assert worker.worker_poll_seconds(queue, rebuild_running=False) == worker.WORKER_IDLE_POLL_SECONDS


def test_worker_heartbeat_interval_stays_within_readiness_window():
    assert worker.WORKER_HEARTBEAT_INTERVAL_SECONDS < worker.WORKER_HEARTBEAT_MAX_AGE_SECONDS


def test_worker_recycles_only_when_high_rss_and_all_work_is_idle():
    idle = {
        "archive": False,
        "subscription": False,
        "source_library": False,
        "source_refresh": False,
        "organizer": False,
        "index_rebuild": False,
        "preview": False,
    }

    assert worker.worker_should_recycle(
        rss_mib=2500,
        threshold_mib=2048,
        hard_threshold_mib=4096,
        activity=idle,
    )
    assert not worker.worker_should_recycle(
        rss_mib=2500,
        threshold_mib=2048,
        hard_threshold_mib=4096,
        activity={**idle, "subscription": True},
    )
    assert not worker.worker_should_recycle(
        rss_mib=1900,
        threshold_mib=2048,
        hard_threshold_mib=4096,
        activity=idle,
    )
    assert worker.worker_should_recycle(
        rss_mib=4500,
        threshold_mib=2048,
        hard_threshold_mib=4096,
        activity={**idle, "archive": True},
    )
    assert not worker.worker_should_recycle(
        rss_mib=9000,
        threshold_mib=0,
        hard_threshold_mib=0,
        activity=idle,
    )


def test_worker_memory_maintenance_degrades_gracefully_when_activity_read_fails():
    def load_activity():
        raise OSError("state unavailable")

    with patch.object(worker, "release_catalog_memory") as release_catalog, \
            patch.object(worker, "release_source_library_memory") as release_source_library, \
            patch.object(worker, "release_process_memory") as release_process:
        result = worker.run_worker_memory_maintenance(load_activity)

    assert result["recycle"] is False
    assert result["error"] == "state unavailable"
    release_catalog.assert_not_called()
    release_source_library.assert_not_called()
    release_process.assert_not_called()


def test_worker_memory_maintenance_recycles_after_idle_cache_release():
    with patch.object(worker, "release_catalog_memory") as release_catalog, \
            patch.object(worker, "release_source_library_memory") as release_source_library, \
            patch.object(worker, "release_process_memory") as release_process, \
            patch.object(worker, "process_rss_mib", return_value=2500):
        result = worker.run_worker_memory_maintenance(
            lambda: {"archive": False, "subscription": False},
            threshold_mib=2048,
            hard_threshold_mib=4096,
        )

    assert result == {
        "recycle": True,
        "reason": "idle_limit",
        "rss_mib": 2500,
        "threshold_mib": 2048,
        "hard_threshold_mib": 4096,
        "error": "",
    }
    release_catalog.assert_called_once_with()
    release_source_library.assert_called_once_with()
    release_process.assert_called_once_with()


def test_worker_memory_maintenance_releases_caches_while_busy_without_soft_recycle():
    with patch.object(worker, "release_catalog_memory") as release_catalog, \
            patch.object(worker, "release_source_library_memory") as release_source_library, \
            patch.object(worker, "release_process_memory") as release_process, \
            patch.object(worker, "process_rss_mib", return_value=2500):
        result = worker.run_worker_memory_maintenance(
            lambda: {"archive": True, "subscription": False},
            threshold_mib=2048,
            hard_threshold_mib=4096,
        )

    assert result["recycle"] is False
    assert result["reason"] == ""
    release_catalog.assert_called_once_with()
    release_source_library.assert_called_once_with()
    release_process.assert_called_once_with()


def test_worker_memory_maintenance_recycles_at_hard_limit_while_busy():
    with patch.object(worker, "release_catalog_memory"), \
            patch.object(worker, "release_source_library_memory"), \
            patch.object(worker, "release_process_memory"), \
            patch.object(worker, "process_rss_mib", return_value=4500):
        result = worker.run_worker_memory_maintenance(
            lambda: {"archive": True},
            threshold_mib=2048,
            hard_threshold_mib=4096,
        )

    assert result["recycle"] is True
    assert result["reason"] == "hard_limit"


def test_worker_schedules_missing_3mf_retry_only_when_archive_queue_is_idle():
    manager = Mock()
    manager.retry_idle_missing_3mf.return_value = {
        "accepted": True,
        "accepted_count": 2,
        "queued_count": 0,
    }

    busy_result = worker.run_worker_idle_missing_3mf_retry(
        manager,
        {"queued_count": 1, "running_count": 0, "queued": [{"status": "queued"}]},
        limit=4,
    )
    idle_result = worker.run_worker_idle_missing_3mf_retry(
        manager,
        {"queued_count": 0, "running_count": 0, "queued": []},
        limit=4,
    )

    assert busy_result == {"accepted": False, "reason": "archive_queue_busy"}
    assert idle_result["accepted_count"] == 2
    manager.retry_idle_missing_3mf.assert_called_once_with(limit=4)
