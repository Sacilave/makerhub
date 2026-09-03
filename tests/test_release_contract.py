from __future__ import annotations

import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import yaml

ROOT_DIR = Path(__file__).resolve().parents[1]
VERIFY_WORKFLOW_PATH = ROOT_DIR / ".github" / "workflows" / "docker.yml"
TAG_GATE_WORKFLOW_PATH = ROOT_DIR / ".github" / "workflows" / "release.yml"
VERSION_SCRIPT = ROOT_DIR / "scripts" / "check_release_version.py"


def _load(path: Path) -> dict:
    payload = yaml.load(path.read_text(encoding="utf-8"), Loader=yaml.BaseLoader)
    if not isinstance(payload, dict):
        raise AssertionError(f"{path} must be a mapping")
    return payload


def _step(job: dict, name: str) -> dict:
    for item in job.get("steps", []):
        if item.get("name") == name:
            return item
    raise AssertionError(f"workflow step not found: {name}")


class ReleaseWorkflowContractTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workflow = _load(VERIFY_WORKFLOW_PATH)
        cls.jobs = cls.workflow["jobs"]

    def test_pull_requests_main_and_version_tags_run_verification(self):
        triggers = self.workflow["on"]
        self.assertIn("pull_request", triggers)
        self.assertIn("main", triggers["push"]["branches"])
        self.assertIn("v*", triggers["push"]["tags"])
        self.assertIn("verify", self.jobs)
        self.assertNotIn("if", self.jobs["verify"])

    def test_same_ref_workflow_runs_are_serialized_without_cancellation(self):
        concurrency = self.workflow["concurrency"]
        self.assertEqual(concurrency["group"], "docker-${{ github.ref }}")
        self.assertEqual(concurrency["cancel-in-progress"], "false")

    def test_verify_job_preserves_quality_gate_shape_and_adds_e2e(self):
        verify = self.jobs["verify"]
        names = [item.get("name") for item in verify["steps"]]
        expected = [
            "Checkout", "Set up Python", "Install backend dependencies", "Run backend tests",
            "Set up Node.js", "Install frontend dependencies", "Run frontend tests", "Build frontend",
            "Validate Compose files", "Check release version", "Set up Docker Buildx", "Build image",
            "Smoke test image",
        ]
        self.assertEqual(names, expected)
        self.assertIn("python -m pytest", _step(verify, "Run backend tests")["run"])
        self.assertIn("scripts/check_security_invariants.py", _step(verify, "Check release version")["run"])
        build = _step(verify, "Build image")
        self.assertEqual(build["with"]["load"], "true")
        self.assertEqual(build["with"]["push"], "false")
        smoke = _step(verify, "Smoke test image")["run"]
        self.assertIn("docker run --rm makerhub:verify", smoke)
        self.assertIn("solve_click_challenge", smoke)
        self.assertIn("scripts/release_gate.sh", smoke)
        self.assertIn("scripts/build_release_bundles.py", smoke)
        self.assertIn("makerhub-windows-amd64.zip", smoke)
        self.assertIn("makerhub-linux-amd64.tar.gz", smoke)

    def test_release_only_runs_for_version_tags_after_verification(self):
        release = self.jobs["release"]
        self.assertEqual(release["needs"], "verify")
        self.assertIn("refs/tags/v", release["if"])
        self.assertEqual(release["permissions"]["contents"], "write")
        self.assertEqual(release["permissions"]["packages"], "write")
        self.assertEqual(_step(release, "Build and push image")["with"]["push"], "true")

    def test_release_uses_digest_bundles_and_anonymous_pull_gate(self):
        release = self.jobs["release"]
        names = [item.get("name") for item in release["steps"]]
        build = _step(release, "Build and push image")
        self.assertEqual(build["id"], "build")
        anonymous = _step(release, "Verify anonymous GHCR pull")["run"]
        self.assertIn("docker logout ghcr.io", anonymous)
        self.assertIn("docker pull", anonymous)
        bundles = _step(release, "Build portable release bundles")["run"]
        self.assertIn("steps.build.outputs.digest", bundles)
        self.assertIn("scripts/build_release_bundles.py", bundles)
        publish = _step(release, "Publish GitHub Release")["with"]
        files = publish.get("files", "")
        self.assertIn("makerhub-windows-amd64.zip", files)
        self.assertIn("makerhub-linux-amd64.tar.gz", files)
        self.assertIn("SHA256SUMS", files)
        self.assertLess(names.index("Build and push image"), names.index("Verify anonymous GHCR pull"))
        self.assertLess(names.index("Verify anonymous GHCR pull"), names.index("Publish GitHub Release"))
        self.assertLess(names.index("Publish GitHub Release"), names.index("Promote verified release as latest"))

    def test_release_keeps_immutable_version_tags_before_latest(self):
        release = self.jobs["release"]
        metadata_tags = _step(release, "Extract image metadata")["with"]["tags"]
        self.assertIn("type=raw,value=${{ github.ref_name }}", metadata_tags)
        self.assertIn("type=sha", metadata_tags)
        self.assertNotIn("type=raw,value=latest", metadata_tags)
        self.assertEqual(release["concurrency"]["group"], "makerhub-release-promotion")
        promote = _step(release, "Promote verified release as latest")["run"]
        self.assertIn('"${IMAGE}:${GITHUB_REF_NAME}"', promote)

    def test_release_refuses_existing_version_image(self):
        release = self.jobs["release"]
        guard = _step(release, "Check version tag availability")
        run = guard["run"]
        self.assertNotIn("env", guard)
        self.assertIn("docker buildx imagetools inspect", run)
        self.assertIn("Version tag ${GITHUB_REF_NAME} already exists and is immutable.", run)
        self.assertEqual(run.count("exit 1"), 1)


class LiveCanaryTagGateContractTest(unittest.TestCase):
    def test_manual_tag_gate_is_bound_to_exact_main_commit(self):
        workflow = _load(TAG_GATE_WORKFLOW_PATH)
        inputs = workflow["on"]["workflow_dispatch"]["inputs"]
        self.assertIn("live_canary_confirmed", inputs)
        self.assertIn("live_canary_commit", inputs)
        job = workflow["jobs"]["tag"]
        validate = _step(job, "Validate live canary evidence")["run"]
        self.assertIn("GITHUB_SHA", validate)
        self.assertIn("live_canary_commit", validate)
        tag = _step(job, "Create annotated release tag")["run"]
        self.assertIn('git config user.name "Sacilave"', tag)
        self.assertIn('git config user.email "sacilave@gmail.com"', tag)
        self.assertIn("git tag -a", tag)


class DeploymentComposeContractTest(unittest.TestCase):
    def test_canonical_compose_keeps_security_readiness_and_portability(self):
        text = (ROOT_DIR / "compose.yaml").read_text(encoding="utf-8")
        compose = yaml.safe_load(text)
        services = compose["services"]
        self.assertEqual(set(services), {"makerhub-app", "makerhub-worker", "makerhub-postgres", "cloakbrowser"})
        self.assertEqual(services["makerhub-app"]["ports"], ["${MAKERHUB_BIND_ADDRESS:-127.0.0.1}:9042:8000"])
        self.assertEqual(services["cloakbrowser"]["ports"], ["${MAKERHUB_CLOAKBROWSER_BIND_ADDRESS:-127.0.0.1}:9050:8080"])
        token = "${MAKERHUB_CLOAKBROWSER_AUTH_TOKEN:?set MAKERHUB_CLOAKBROWSER_AUTH_TOKEN in .env}"
        for name in ("makerhub-app", "makerhub-worker"):
            self.assertEqual(services[name]["environment"]["MAKERHUB_CLOAKBROWSER_AUTH_TOKEN"], token)
            self.assertEqual(services[name]["depends_on"]["makerhub-postgres"]["condition"], "service_healthy")
            self.assertIn("no-new-privileges:true", services[name]["security_opt"])
        self.assertEqual(services["makerhub-postgres"]["networks"], ["backend"])
        self.assertTrue(compose["networks"]["backend"]["internal"])
        self.assertIn("# - /var/run/docker.sock:/var/run/docker.sock", text)
        active = [line for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")]
        self.assertFalse(any("/var/run/docker.sock" in line for line in active))

    def test_environment_template_is_safe_to_copy(self):
        env = (ROOT_DIR / ".env.example").read_text(encoding="utf-8")
        self.assertIn("MAKERHUB_POSTGRES_PASSWORD=\n", env)
        self.assertIn("MAKERHUB_CLOAKBROWSER_AUTH_TOKEN=\n", env)
        self.assertNotIn("MAKERHUB_CONFIG_PATH=./data/config", env)
        self.assertNotIn("MAKERHUB_ARCHIVE_PATH=./data/archive", env)
        self.assertIn("其余默认配置已直接写入 compose.yaml", env)

    def test_release_template_uses_immutable_placeholder_and_same_security_defaults(self):
        text = (ROOT_DIR / "packaging" / "compose.release.yaml").read_text(encoding="utf-8")
        image = "example.invalid/makerhub@sha256:" + "a" * 64
        compose = yaml.safe_load(text.replace("__MAKERHUB_IMAGE__", image))
        self.assertEqual(compose["services"]["makerhub-app"]["image"], image)
        self.assertTrue(compose["networks"]["backend"]["internal"])
        self.assertEqual(compose["services"]["makerhub-postgres"]["networks"], ["backend"])


class ReleaseDocumentationContractTest(unittest.TestCase):
    def test_docs_describe_portable_releases_security_and_upgrade_persistence(self):
        docs = "\n".join(
            (ROOT_DIR / path).read_text(encoding="utf-8")
            for path in ("README.md", "docs/RELEASES.md", "SECURITY.md", "docs/modules/deployment_update.md", "docs/modules/core.md")
        )
        for expected in (
            "makerhub-windows-amd64.zip", "makerhub-linux-amd64.tar.gz", "Windows x86-64", "Linux x86-64",
            "MAKERHUB_CLOAKBROWSER_AUTH_TOKEN", "MAKERHUB_POSTGRES_PASSWORD", "AES-256", "live-canary-result.json",
            "source_commit", ".env", "secrets/", "data/",
        ):
            with self.subTest(expected=expected):
                self.assertIn(expected, docs)

    def test_readme_is_product_documentation_not_patch_notes(self):
        readme = (ROOT_DIR / "README.md").read_text(encoding="utf-8")
        self.assertIn("MakerHub 是什么", readme)
        self.assertIn("主要能力", readme)
        self.assertIn("快速安装", readme)
        self.assertIn("数据与安全", readme)
        self.assertNotIn("本 fork 新增", readme)


class AutomaticVerificationContractTest(unittest.TestCase):
    def test_auto_verification_remains_opt_in_and_image_smoke_exercises_solver(self):
        env = (ROOT_DIR / ".env.example").read_text(encoding="utf-8")
        compose = yaml.safe_load((ROOT_DIR / "compose.yaml").read_text(encoding="utf-8"))
        smoke = _step(_load(VERIFY_WORKFLOW_PATH)["jobs"]["verify"], "Smoke test image")["run"]
        self.assertIn("MAKERHUB_AUTO_VERIFY_3MF=false", env)
        for name in ("makerhub-app", "makerhub-worker"):
            self.assertEqual(compose["services"][name]["environment"]["MAKERHUB_AUTO_VERIFY_3MF"], "${MAKERHUB_AUTO_VERIFY_3MF:-false}")
        self.assertIn("import cv2", smoke)
        self.assertIn("version('opencv-python-headless')", smoke)
        self.assertIn("solve_click_challenge", smoke)


class FrontendTestContractTest(unittest.TestCase):
    def test_npm_test_runs_all_node_test_modules(self):
        package = json.loads((ROOT_DIR / "frontend" / "package.json").read_text(encoding="utf-8"))
        self.assertEqual(package["scripts"]["test"], "node --test src/lib/*.test.mjs")


class DockerIgnoreContractTest(unittest.TestCase):
    def test_dockerignore_excludes_non_build_content_and_keeps_inputs(self):
        patterns = {
            line.strip().rstrip("/") for line in (ROOT_DIR / ".dockerignore").read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        }
        expected = {".env", ".env.*", ".git", ".venv", "venv", "**/node_modules", "frontend/dist", ".workflow", ".superpowers", ".worktrees", "worktrees", "config", "data", "logs", "state", "archive", "local", "docs", "tests", "videos/**/output"}
        self.assertTrue(expected.issubset(patterns), expected - patterns)
        required = {"Dockerfile", "requirements.txt", "VERSION", "app", "docker", "frontend", "frontend/package.json", "frontend/package-lock.json", "frontend/src"}
        self.assertTrue(required.isdisjoint(patterns), required & patterns)


class ReleaseVersionContractTest(unittest.TestCase):
    def _write_version_fixture(self, root: Path, *, version: str, package_version: str | None = None) -> None:
        frontend = root / "frontend"; frontend.mkdir(parents=True); package_version = package_version or version
        (root / "VERSION").write_text(f"{version}\n", encoding="utf-8")
        (frontend / "package.json").write_text(json.dumps({"version": package_version}), encoding="utf-8")
        (frontend / "package-lock.json").write_text(json.dumps({"version": version, "packages": {"": {"version": version}}}), encoding="utf-8")

    def _run_checker(self, root: Path, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run([sys.executable, VERSION_SCRIPT.as_posix(), "--root", root.as_posix(), *args], capture_output=True, text=True, check=False)

    def test_repository_versions_and_release_tag_are_consistent(self):
        version = (ROOT_DIR / "VERSION").read_text(encoding="utf-8").strip()
        result = self._run_checker(ROOT_DIR, "--tag", f"v{version}")
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_version_checker_rejects_file_mismatch(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); self._write_version_fixture(root, version="1.2.3", package_version="1.2.4"); result = self._run_checker(root)
        self.assertNotEqual(result.returncode, 0); self.assertIn("frontend/package.json", result.stderr)

    def test_version_checker_rejects_non_matching_release_tag(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); self._write_version_fixture(root, version="1.2.3"); result = self._run_checker(root, "--tag", "v1.2.4")
        self.assertNotEqual(result.returncode, 0); self.assertIn("v1.2.3", result.stderr)


if __name__ == "__main__":
    unittest.main()
