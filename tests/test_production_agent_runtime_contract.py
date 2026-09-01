import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class ProductionAgentRuntimeContractTests(unittest.TestCase):
    def test_mcp_exposes_durable_queue_tools(self):
        text = (ROOT / "mcp_server.py").read_text(encoding="utf-8")
        for name in (
            "start_production_run",
            "get_production_run",
            "claim_production_task",
            "control_production_run",
        ):
            self.assertIn(f'"name": "{name}"', text)
            self.assertIn(f'if name == "{name}"', text)

    def test_desktop_exposes_queue_controls_without_task_completion_write(self):
        preload = (ROOT / "desktop" / "preload.cjs").read_text(encoding="utf-8")
        main = (ROOT / "desktop" / "main.cjs").read_text(encoding="utf-8")
        ui = (ROOT / "desktop" / "index.html").read_text(encoding="utf-8")
        for token in ("startProductionRun", "getProductionRun", "controlProductionRun"):
            self.assertIn(token, preload)
        for channel in (
            '"production-agent:start-run"',
            '"production-agent:get-run"',
            '"production-agent:control-run"',
        ):
            self.assertIn(channel, main)
        self.assertIn("실행 큐 만들기", ui)
        self.assertIn("일시정지", ui)
        self.assertIn("실패 task 재시도", ui)
        self.assertNotIn("mark_production_task_complete", preload + main)

    def test_queue_completion_is_canonical_derived(self):
        text = (ROOT / "core" / "production_agent_jobs.py").read_text(encoding="utf-8")
        self.assertIn("task_resolved_from_canonical_state", text)
        self.assertIn("state='COMPLETE'", text)
        self.assertIn("retry_task", text)
        self.assertIn("E_PRODUCTION_AGENT_TASK_ALREADY_CLAIMED", text)
        self.assertNotIn("mark_task_complete", text)


if __name__ == "__main__":
    unittest.main()
