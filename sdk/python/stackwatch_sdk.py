"""
StackWatch SDK — Python.

Tiny client that pushes bot/scraper progress to local StackWatch panel.
Fail-silent if daemon offline (your bot keeps running).

Usage:
    from stackwatch_sdk import bot

    b = bot("amazon-scrape", target=15000)
    for url in urls:
        try:
            item = scrape(url)
            b.tick(item=url, data=item.title)
        except Exception as e:
            b.error(str(e), meta={"url": url})
    b.done()
"""

import atexit
import json
import os
import sys
import threading
import urllib.request
import urllib.error

HOST    = os.environ.get("STACKWATCH_HOST", "127.0.0.1")
PORT    = int(os.environ.get("STACKWATCH_PORT", "27315"))
ENABLED = os.environ.get("STACKWATCH_DISABLE") != "1"
TIMEOUT = 1.5


def _request(method: str, path: str, body: dict | None = None) -> dict | None:
    if not ENABLED:
        return None
    url = f"http://{HOST}:{PORT}{path}"
    data = json.dumps(body or {}).encode("utf-8") if body is not None or method == "POST" else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return json.loads(r.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, json.JSONDecodeError, TimeoutError):
        return None


def _post(path: str, body: dict | None = None) -> dict | None:
    return _request("POST", path, body)


def _get(path: str) -> dict | None:
    return _request("GET", path, None)


def _post_async(path: str, body: dict | None = None) -> None:
    """Fire-and-forget — never blocks the bot loop."""
    threading.Thread(target=_post, args=(path, body), daemon=True).start()


class Bot:
    def __init__(self, bot_id: str, name: str, target: int | None = None):
        self.id     = bot_id
        self.name   = name
        self.target = target
        self._tick_buffer = 0
        self._flush_timer: threading.Timer | None = None
        self._lock        = threading.Lock()
        self._paused      = False
        self._poll_stop   = threading.Event()
        if not bot_id.startswith("offline-"):
            t = threading.Thread(target=self._poll_loop, daemon=True)
            t.start()

    def _poll_loop(self) -> None:
        while not self._poll_stop.wait(4.0):
            r = _get(f"/bot/{self.id}/control")
            if r and isinstance(r.get("paused"), bool):
                self._paused = r["paused"]

    def is_paused(self) -> bool:
        return self._paused

    def wait_if_paused(self, poll_interval: float = 0.5) -> None:
        """Block until unpaused — call inside scrape loop."""
        while self._paused:
            import time
            time.sleep(poll_interval)

    def tick(self, item: str | None = None, data=None, flush: bool = False) -> None:
        important = item is not None or data is not None or flush
        with self._lock:
            self._tick_buffer += 1
            if important:
                self._flush_locked({"item": item, "data": data})
                return
            if self._flush_timer is None:
                self._flush_timer = threading.Timer(0.25, self._flush)
                self._flush_timer.daemon = True
                self._flush_timer.start()

    def _flush(self) -> None:
        with self._lock:
            self._flush_locked({})

    def _flush_locked(self, extra: dict) -> None:
        if self._flush_timer is not None:
            self._flush_timer.cancel()
            self._flush_timer = None
        count = self._tick_buffer
        self._tick_buffer = 0
        if count == 0 and not extra.get("item") and extra.get("data") is None:
            return
        payload = {"count": count or 1, **{k: v for k, v in extra.items() if v is not None}}
        _post_async(f"/bot/{self.id}/tick", payload)

    def error(self, msg: str, meta=None) -> None:
        self._flush()
        _post_async(f"/bot/{self.id}/error", {"msg": str(msg)[:300], "meta": meta})

    def done(self) -> None:
        self._flush()
        self._poll_stop.set()
        _post_async(f"/bot/{self.id}/done", {})

    def crashed(self, msg: str = "crashed") -> None:
        self._flush()
        self._poll_stop.set()
        _post_async(f"/bot/{self.id}/crashed", {"msg": str(msg)[:300]})


class _OfflineBot(Bot):
    """Daemon offline — accept all calls, do nothing."""
    def tick(self, *a, **kw): pass
    def error(self, *a, **kw): pass
    def done(self): pass
    def crashed(self, *a, **kw): pass
    def is_paused(self): return False
    def wait_if_paused(self, *a, **kw): pass


def bot(name: str, target: int | None = None, project: str | None = None,
        meta: dict | None = None) -> Bot:
    """Register a bot with StackWatch panel. Returns Bot handle."""
    reg = _post("/bot/register", {
        "name":    name,
        "target":  target,
        "project": project,
        "meta":    meta or {},
        "pid":     os.getpid(),
    })
    if reg is None or not reg.get("id"):
        return _OfflineBot("offline-" + name, name, target)

    b = Bot(reg["id"], name, target)

    def _on_exit():
        # If process exits without calling done(), mark crashed unless clean
        if sys.exc_info()[0] is not None:
            b.crashed(str(sys.exc_info()[1]))
    atexit.register(_on_exit)

    return b
