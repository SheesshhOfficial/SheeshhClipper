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
            nav = page.get_by_role("navigation", name="Studio views")
            assert nav.get_by_role("link", name="Sources").get_attribute("aria-current") == "page"
            assert page.locator("#editor-workspace").is_hidden()
            assert page.evaluate("getComputedStyle(document.documentElement).colorScheme") == "dark"
            assert page.request.get(studio_url + "/static/workspace.js").ok
            assert page.request.get(studio_url + "/static/studio.js").ok
            assert page.request.get(studio_url + "/static/studio.css").ok
            with page.expect_response(lambda r: r.url.endswith("/api/sources") and r.request.method == "POST") as upload:
                page.locator("#import-file").set_input_files(str(fixture))
            assert upload.value.ok, upload.value.text()
            page.wait_for_function("document.querySelector('#video').readyState >= 2")
            nav.get_by_role("link", name="Editor").click()
            assert nav.get_by_role("link", name="Editor").get_attribute("aria-current") == "page"
            assert page.locator("#draft").is_enabled()
            page.locator("#start").fill("0.25")
            page.locator("#end").fill("1.25")
            page.locator("#aspect").select_option("9:16")
            page.locator("#layout").select_option("split")
            for field, value in {"x":"0.55", "y":"0.1", "w":"0.35", "h":"0.45"}.items():
                page.locator("#face-" + field).fill(value)
            nav.get_by_role("link", name="Highlights").click()
            assert page.locator("#editor-workspace").is_hidden()
            page.go_back()
            assert page.locator("#start").input_value() == "0.25"
            assert page.locator("#layout").input_value() == "split"
            for action, kind in [("draft", "draft"), ("export", "export")]:
                with page.expect_response(lambda r: r.url.endswith("/api/render"), timeout=45_000) as response:
                    page.locator("#" + action).click()
                assert response.value.ok, response.value.text()
                assert response.value.json()["kind"] == kind
            nav.get_by_role("link", name="Saved clips").click()
            page.reload(wait_until="networkidle")
            assert len(page.request.get(studio_url + "/api/artifacts").json()) == 2
            group = page.locator("#artifacts .artifact-group")
            assert group.count() == 1
            assert "test scene" in group.locator("h3").inner_text()
            assert nav.get_by_role("link", name="Saved clips").get_attribute("aria-current") == "page"
            page.locator("#artifact-filter").select_option("draft")
            assert page.locator("#artifacts .artifact").count() == 1
            assert "1 of 2 saved" in page.locator("#artifact-count").inner_text()
            assert "1080 × 1920" in page.locator("#artifacts .artifact-meta").inner_text()
            page.locator("#artifact-filter").select_option("export")
            assert page.locator("#artifacts .artifact").count() == 1
            page.locator("#artifact-filter").select_option("all")
            assert page.locator("#artifacts .artifact").count() == 2
            page.get_by_role("button", name="Restore edit").first.click()
            page.wait_for_function("document.querySelector('#start').value === '0.25'")
            assert page.locator("#layout").input_value() == "split"
            assert nav.get_by_role("link", name="Editor").get_attribute("aria-current") == "page"
            page.set_viewport_size({"width": 390, "height": 844})
            for name in ("Sources", "Highlights", "Editor", "Saved clips"):
                nav.get_by_role("link", name=name).click()
                assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), name
            assert not failures, failures
            if os.environ.get("SHEESH_SCREENSHOT"):
                page.screenshot(path=os.environ["SHEESH_SCREENSHOT"], full_page=True)
            browser.close()
    print("Chromium smoke passed: import, video decode, facecam controls, draft, export, persistence")


if __name__ == "__main__":
    main()
