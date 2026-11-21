"""Opt-in real Chromium/FFmpeg integration smoke test."""
from contextlib import contextmanager
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
from urllib.request import urlopen



@contextmanager
def studio(directory: str):
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    uri = f"http://127.0.0.1:{port}"
    process = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(port),
         "--no-access-log"],
        env={**os.environ, "SHEESH_DATA_DIR": directory},
    )
    try:
        for _ in range(100):
            try:
                with urlopen(uri + "/api/health", timeout=0.3) as response:
                    if response.status == 200:
                        break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError("Health check timed out")
        yield uri
    finally:
        process.terminate()
        process.wait(timeout=10)


def main():
    from playwright.sync_api import sync_playwright

    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        fixture = root / "test scene.mp4"
        subprocess.run([
            "ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=320x180:r=16",
            "-f", "lavfi", "-i", "sine=frequency=440", "-t", "2", "-c:v", "libx264",
            "-c:a", "aac", str(fixture),
        ], check=True)
        with studio(str(root / "data")) as studio_url, sync_playwright() as pw:
            browser = pw.chromium.launch(
                executable_path=os.environ.get("SHEESH_CHROMIUM"),
            )
            page = browser.new_page(viewport={"width": 1366, "height": 900})
            failures = []
            page.on("pageerror", lambda exc: failures.append(str(exc)))

            page.goto(studio_url, wait_until="networkidle")
            assert page.request.get(studio_url + "/static/studio.js").ok
            assert page.request.get(studio_url + "/static/studio.css").ok
            with page.expect_response(lambda r: r.url.endswith("/api/sources") and r.request.method == "POST") as upload:
                page.locator("#import-file").set_input_files(str(fixture))
            assert upload.value.ok, upload.value.text()
            page.wait_for_function("document.querySelector('#video').readyState >= 2")
            assert page.locator("#draft").is_enabled()
            page.locator("#start").fill("0.25")
            page.locator("#end").fill("1.25")
            page.locator("#aspect").select_option("9:16")
            page.locator("#layout").select_option("split")
            for field, value in {"x":"0.55", "y":"0.1", "w":"0.35", "h":"0.45"}.items():
                page.locator("#face-" + field).fill(value)
            for action, kind in [("draft", "draft"), ("export", "export")]:
                with page.expect_response(lambda r: r.url.endswith("/api/render"), timeout=45_000) as response:
                    page.locator("#" + action).click()
                assert response.value.ok, response.value.text()
                assert response.value.json()["kind"] == kind
            page.reload(wait_until="networkidle")
            assert len(page.request.get(studio_url + "/api/artifacts").json()) == 2
            assert page.get_by_text("test scene", exact=False).count() >= 1
            page.get_by_role("button", name="Restore edit").first.click()
            page.wait_for_function("document.querySelector('#start').value === '0.25'")
            assert page.locator("#layout").input_value() == "split"
            assert not failures, failures
            if os.environ.get("SHEESH_SCREENSHOT"):
                page.screenshot(path=os.environ["SHEESH_SCREENSHOT"], full_page=True)
            browser.close()
    print("Chromium smoke passed: import, video decode, facecam controls, draft, export, persistence")


if __name__ == "__main__":
    main()
