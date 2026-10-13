import importlib.util
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

spec = importlib.util.spec_from_file_location("package_release", Path(__file__).resolve().parents[1] / "scripts/package_release.py")
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.write("README.md", b"public source")
        self.write("infra/.env.example", b"ONEMOTION_DATA_DIR=data")
        self.write(".env", b"PRIVATE_VALUE=not-for-export")
        self.write("data/analyses/personal.json", b'{"personal":"record"}')
        self.write("data/.locks/4.lock", b"live lock must not be packaged")
        self.write("data/raw_videos/curry/source.mp4", b"local video")
        self.write("apps/web/tests/fixtures/demo.webm", b"generated test video")
        self.write(".run/private.log", b"temporary")
        catalog = {"candidates": [{"id": "reference", "url": "https://www.youtube.com/watch?v=public",
                                   "title": "Public source", "publisher": "Publisher", "source_family": "one",
                                   "review_status": "metadata_only", "timing": {"mode": "unknown"}}], "related_sources": []}
        self.write("docs/research/curry-reference-candidates.json", json.dumps(catalog).encode())
        artifacts = []
        for name in sorted(package.PINNED):
            path = self.write(name, b"pinned local artifact")
            artifacts.append({"path": name, "size": path.stat().st_size, "sha256": package.digest_file(path)})
        self.write("infra/artifacts.json", json.dumps({"active_template": "curry_v3", "artifacts": artifacts}).encode())
        self.sources = ["README.md", "infra/.env.example", ".env", "data/analyses/personal.json",
                        "apps/web/tests/fixtures/demo.webm", "models/yolo11n-pose.pt", ".run/private.log",
                        "docs/research/curry-reference-candidates.json"]

    def write(self, name, data):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def build(self, kind):
        path = self.root / f"{kind}.zip"
        return path, package.build_bundle(self.root, kind, self.sources, path, "test-local-revision")

    def test_github_export_contains_links_but_no_media_private_data_or_environment(self):
        path, result = self.build("github")
        self.assertEqual(result["video_files"], 0)
        with zipfile.ZipFile(path) as archive:
            files = {p for p in archive.namelist() if not p.endswith("/")}
            self.assertIn("OneMotion-github/VIDEO_SOURCES.json", files)
            self.assertIn("OneMotion-github/infra/.env.example", files)
            for name in files:
                self.assertTrue(package.public_file(Path(name).relative_to("OneMotion-github").as_posix()))
            links = json.loads(archive.read("OneMotion-github/VIDEO_SOURCES.json"))
            self.assertEqual(links["candidates"][0]["url"], "https://www.youtube.com/watch?v=public")

    def test_local_export_preserves_media_records_and_pins_but_not_locks(self):
        path, result = self.build("local")
        self.assertEqual(result["video_files"], 3)
        with zipfile.ZipFile(path) as archive:
            self.assertEqual(archive.read("OneMotion-local/data/analyses/personal.json"), b'{"personal":"record"}')
            self.assertIn("OneMotion-local/infra/artifacts.json", archive.namelist())
            self.assertNotIn("OneMotion-local/data/.locks/4.lock", archive.namelist())
            self.assertNotIn("OneMotion-local/.env", archive.namelist())

    def test_changed_pin_prevents_local_export(self):
        self.write("models/yolo11n-pose.pt", b"changed")
        with self.assertRaisesRegex(ValueError, "integrity"):
            self.build("local")
        self.assertFalse((self.root / "local.zip").exists())

    def test_existing_archive_is_never_replaced(self):
        self.write("github.zip", b"user-owned archive")
        with self.assertRaises(FileExistsError):
            self.build("github")
        self.assertEqual((self.root / "github.zip").read_bytes(), b"user-owned archive")

    def test_external_symlink_is_rejected(self):
        (self.root / "external.txt").symlink_to(Path(__file__).resolve())
        with self.assertRaisesRegex(ValueError, "symlink"):
            package.select_files(self.root, "github", ["external.txt"])

    def test_renamed_video_payload_cannot_enter_the_submission_package(self):
        self.write("video-disguised.txt", b"\x00\x00\x00\x18ftypisom\x00\x00\x00\x00")
        with self.assertRaisesRegex(ValueError, "disguised"):
            package.build_bundle(self.root, "github", [*self.sources, "video-disguised.txt"], self.root / "github.zip", "test")
        self.assertFalse((self.root / "github.zip").exists())

    def test_path_traversal_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "unsafe"):
            package.safe_file(self.root, "../outside.txt")


if __name__ == "__main__":
    unittest.main()
