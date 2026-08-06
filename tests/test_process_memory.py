from pathlib import Path
from unittest.mock import patch

from app.services import process_memory


def test_process_rss_mib_reads_linux_vm_rss(tmp_path: Path):
    status_path = tmp_path / "status"
    status_path.write_text("Name:\tmakerhub\nVmRSS:\t3145728 kB\n", encoding="utf-8")

    assert process_memory.process_rss_mib(status_path=status_path) == 3072.0


def test_process_rss_mib_returns_zero_when_status_is_unavailable(tmp_path: Path):
    assert process_memory.process_rss_mib(status_path=tmp_path / "missing") == 0.0


def test_release_process_memory_runs_gc_and_best_effort_malloc_trim():
    with patch("app.services.process_memory.ctypes.CDLL") as cdll, \
            patch("app.services.process_memory.gc.collect", return_value=7) as collect:
        cdll.return_value.malloc_trim.return_value = 1
        result = process_memory.release_process_memory()

    collect.assert_called_once_with()
    assert result == {"collected": 7, "trimmed": True}
