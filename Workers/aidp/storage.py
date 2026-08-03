"""Object storage, reached through the app.

Two backends:

  local  development. A directory shared with the Next.js app through a mounted
         volume, so no cloud account is needed to run the pipeline.
  app    deployment. Blobs live in UploadThing, and the workers reach them
         through an internal endpoint on the app rather than holding the
         UploadThing token themselves.

That indirection is deliberate. Storage credentials exist in exactly one place,
rotating the token does not mean redeploying two runtimes, and every blob access
passes an audit point. Security Standards §5.2 asks for keys to be restricted to
authorised processes; two runtimes each holding a copy is the arrangement that
makes rotation something nobody ever does.

Keys, never URLs. Files are private and the signing scheme may change.
"""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Protocol

import httpx

from .config import get_config

TIMEOUT = httpx.Timeout(120.0, connect=15.0)


class Storage(Protocol):
    def get(self, key: str) -> bytes: ...
    def put(
        self, key: str, data: bytes, content_type: str = "application/octet-stream"
    ) -> str: ...


class LocalStorage:
    """Development backend. What docker-compose mounts as a shared volume."""

    def __init__(self, root: str) -> None:
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, key: str) -> Path:
        # Keys arrive from the database; refuse anything that escapes root.
        target = (self.root / key).resolve()
        if not target.is_relative_to(self.root):
            raise ValueError(f"storage key escapes root: {key!r}")
        return target

    def get(self, key: str) -> bytes:
        return self._path(key).read_bytes()

    def put(self, key: str, data: bytes, content_type: str = "application/octet-stream") -> str:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return key

    def delete_prefix(self, prefix: str) -> int:
        path = self._path(prefix)
        if not path.exists():
            return 0
        count = sum(1 for p in path.rglob("*") if p.is_file())
        shutil.rmtree(path)
        return count


class AppStorage:
    """Blobs via the app's internal endpoint — see
    AIDP/src/app/api/internal/files/route.ts."""

    def __init__(self, base_url: str, secret: str) -> None:
        self.endpoint = base_url.rstrip("/") + "/api/internal/files"
        self.headers = {"x-worker-secret": secret}

    def get(self, key: str) -> bytes:
        with httpx.Client(timeout=TIMEOUT, follow_redirects=True) as client:
            res = client.get(self.endpoint, params={"key": key}, headers=self.headers)
            res.raise_for_status()

            # The endpoint answers with a signed URL under UploadThing and with
            # the bytes under local, so the worker does not have to know which
            # backend the app is running.
            if res.headers.get("content-type", "").startswith("application/json"):
                url = res.json().get("url")
                if not url:
                    raise RuntimeError(f"no url returned for {key}")
                blob = client.get(url)
                blob.raise_for_status()
                return blob.content
            return res.content

    def put(self, key: str, data: bytes, content_type: str = "application/octet-stream") -> str:
        with httpx.Client(timeout=TIMEOUT) as client:
            res = client.post(
                self.endpoint,
                params={"key": key, "contentType": content_type},
                headers={**self.headers, "content-type": "application/octet-stream"},
                content=data,
            )
            res.raise_for_status()
        # The stored key is whatever the backend issued, not the one suggested.
        return res.json()["key"]


_storage: Storage | None = None


def storage() -> Storage:
    global _storage
    if _storage is None:
        cfg = get_config()
        if cfg.storage_backend in ("app", "uploadthing"):
            if not cfg.app_base_url or not cfg.worker_shared_secret:
                raise SystemExit(
                    "APP_BASE_URL and WORKER_SHARED_SECRET are required when "
                    f"STORAGE_BACKEND={cfg.storage_backend}"
                )
            _storage = AppStorage(cfg.app_base_url, cfg.worker_shared_secret)
        else:
            _storage = LocalStorage(cfg.storage_local_path)
    return _storage


def figure_key(document_id: str, page: int, ordinal: int) -> str:
    return f"figures/{document_id}/p{page:04d}-{ordinal:02d}.png"
