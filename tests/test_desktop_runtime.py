import shutil
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
NODE = shutil.which("node")


@unittest.skipUnless(NODE, "Node.js is required for desktop runtime tests")
class DesktopRuntimeTests(unittest.TestCase):
    def test_node_runtime_modules(self):
        result = subprocess.run(
            [
                NODE,
                "--test",
                "desktop/project-paths.test.cjs",
                "desktop/python-bridge.test.cjs",
            ],
            cwd=ROOT,
            text=True,
            capture_output=True,
        )
        self.assertEqual(result.returncode, 0, result.stdout + "\n" + result.stderr)


if __name__ == "__main__":
    unittest.main()
