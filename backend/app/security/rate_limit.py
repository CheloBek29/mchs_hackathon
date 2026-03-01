from __future__ import annotations

import threading
import time
from collections import defaultdict, deque
from collections.abc import Callable

from fastapi import HTTPException, Request, status

_RATE_LIMIT_STORAGE: dict[str, deque[float]] = defaultdict(deque)
_RATE_LIMIT_LOCK = threading.Lock()


def _get_client_identifier(request: Request) -> str:
    forwarded_for = request.headers.get("x-forwarded-for")
    if forwarded_for:
        return forwarded_for.split(",")[0].strip()
    if request.client and request.client.host:
        return request.client.host
    return "unknown"


def enforce_rate_limit(
    request: Request,
    bucket_name: str,
    max_requests: int,
    window_seconds: int,
) -> None:
    now = time.time()
    key = f"{bucket_name}:{_get_client_identifier(request)}"
    cutoff = now - window_seconds

    with _RATE_LIMIT_LOCK:
        timestamps = _RATE_LIMIT_STORAGE[key]
        while timestamps and timestamps[0] <= cutoff:
            timestamps.popleft()

        if len(timestamps) >= max_requests:
            retry_after = max(1, int(window_seconds - (now - timestamps[0])))
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail=f"Too many requests. Retry in {retry_after}s",
                headers={"Retry-After": str(retry_after)},
            )

        timestamps.append(now)


def rate_limit_dependency(
    bucket_name: str,
    max_requests: int,
    window_seconds: int,
) -> Callable[[Request], None]:
    def dependency(request: Request) -> None:
        enforce_rate_limit(request, bucket_name, max_requests, window_seconds)

    return dependency
