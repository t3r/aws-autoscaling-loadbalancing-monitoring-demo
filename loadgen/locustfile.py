"""
Locust load generator for the autoscaling-demo ALB (runs locally).

Setup:
  cd loadgen
  python3 -m venv .venv
  source .venv/bin/activate   # Windows: .venv\\Scripts\\activate
  pip install -r requirements.txt

Run (Web UI — set host in the UI if you omit --host):
  locust -f locustfile.py --host http://YOUR-ALB-DNS-NAME

Run (CLI only, example: 50 users, spawn 10/s, 5 minutes):
  locust -f locustfile.py --host http://YOUR-ALB-DNS-NAME \\
    --headless -u 50 -r 10 -t 5m

Optional env (seconds between tasks, per simulated user):
  LOCUST_MIN_WAIT=0 LOCUST_MAX_WAIT=0   # max RPS per worker (busy-loop; use many users for more load)
  LOCUST_MIN_WAIT=0.1 LOCUST_MAX_WAIT=0.5   # default pacing
"""

from __future__ import annotations

import os

from locust import HttpUser, between, task


def _float_env(name: str, default: str) -> float:
    raw = os.environ.get(name, default).strip()
    return float(raw)


_MIN_WAIT = _float_env("LOCUST_MIN_WAIT", "0.1")
_MAX_WAIT = _float_env("LOCUST_MAX_WAIT", "0.5")
if _MAX_WAIT < _MIN_WAIT:
    _MIN_WAIT, _MAX_WAIT = _MAX_WAIT, _MIN_WAIT


class AlbDemoUser(HttpUser):
    """Hits the ALB root path (Apache index.html)."""

    wait_time = between(_MIN_WAIT, _MAX_WAIT)

    @task
    def get_index(self) -> None:
        self.client.get("/", name="GET /")
