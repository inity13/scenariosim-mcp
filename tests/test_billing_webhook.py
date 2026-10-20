"""Offline CI bridge: run the signed HTTP/authority/retry billing fixtures."""
from pathlib import Path
import subprocess


def test_hosted_billing_webhook_contract():
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        ["node", "--test", "tests/billing-webhook.test.mjs"],
        cwd=root, text=True, capture_output=True, timeout=60, check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
