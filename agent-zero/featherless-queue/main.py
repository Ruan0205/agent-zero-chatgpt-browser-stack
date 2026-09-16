from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import AsyncIterator

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("agent-zero-featherless-queue")

UPSTREAM = os.getenv("FEATHERLESS_UPSTREAM_URL", "https://api.featherless.ai/v1").rstrip("/")
MAX_ATTEMPTS = int(os.getenv("MAX_ATTEMPTS", "20"))
READ_TIMEOUT = float(os.getenv("UPSTREAM_READ_TIMEOUT", "660"))
RETRYABLE = {408, 409, 425, 429, 500, 502, 503, 504, 520, 522, 524}
TEMPORARY_MODEL_CODES = {"model_not_deployed", "model_pending_deploy"}
TEMPORARY_STREAM_MESSAGES = (
    "temporarily at capacity",
    "temporarily unavailable",
    "please try again shortly",
    "rate limit",
    "rate_limit",
    "too many requests",
    "overloaded",
)
SLOT = asyncio.Semaphore(1)
ACTIVE = 0
WAITING = 0

app = FastAPI(title="Agent Zero Featherless queue")


def retry_delay(attempt: int, response: httpx.Response | None = None) -> int:
    if response is not None:
        header = response.headers.get("retry-after", "")
        if header.isdigit():
            return min(max(int(header), 10), 180)
        try:
            payload = response.json()
            value = int(payload.get("retry_after", 0)) if isinstance(payload, dict) else 0
            if value:
                return min(max(value, 10), 180)
        except Exception:
            pass
    return min(10 * (2**attempt), 120)


def response_headers(source: httpx.Headers) -> dict[str, str]:
    allowed = {
        "cache-control",
        "content-encoding",
        "content-language",
        "content-type",
        "retry-after",
        "x-request-id",
    }
    return {key: value for key, value in source.items() if key.lower() in allowed}


def temporary_model_error(payload: bytes) -> bool:
    try:
        parsed = json.loads(payload)
        error = parsed.get("error", {}) if isinstance(parsed, dict) else {}
        return error.get("code") in TEMPORARY_MODEL_CODES
    except Exception:
        return False


def temporary_stream_error(payload: bytes) -> bool:
    """Detect retryable provider errors delivered inside an HTTP-200 SSE body.

    Featherless can accept a streaming request with status 200 and emit an
    OpenAI error event before the first token.  Once response headers have been
    forwarded, LiteLLM sees that as a MidStreamFallbackError and the proxy can
    no longer retry.  Buffering the bounded SSE response lets us retry before
    exposing any bytes to Agent Zero.
    """
    lowered = payload.decode("utf-8", errors="replace").lower()
    return any(message in lowered for message in TEMPORARY_STREAM_MESSAGES)


@app.get("/health")
async def health() -> dict[str, object]:
    return {
        "status": "ok",
        "partition": "agent-zero",
        "upstream": UPSTREAM,
        "max_upstream_concurrency": 1,
        "active": ACTIVE,
        "waiting": WAITING,
        "max_attempts": MAX_ATTEMPTS,
    }


@app.api_route("/v1/{path:path}", methods=["GET", "POST"])
async def proxy(path: str, request: Request):
    global ACTIVE, WAITING
    WAITING += 1
    try:
        await SLOT.acquire()
    finally:
        WAITING -= 1
    ACTIVE = 1
    handed_to_stream = False
    client = httpx.AsyncClient(
        timeout=httpx.Timeout(connect=30, read=READ_TIMEOUT, write=60, pool=30),
        follow_redirects=True,
    )
    try:
        body = await request.body()
        try:
            request_payload = json.loads(body) if body else {}
        except Exception:
            request_payload = {}
        wants_stream = bool(request_payload.get("stream")) if isinstance(request_payload, dict) else False
        headers = {
            key: value
            for key, value in request.headers.items()
            if key.lower() in {"authorization", "content-type", "accept"}
        }
        headers["User-Agent"] = "Agent-Zero/partitioned-featherless-queue"
        headers["HTTP-Referer"] = os.getenv("PUBLIC_BASE_URL", "http://localhost:50080/")
        headers["X-Title"] = os.getenv("FEATHERLESS_APP_TITLE", "Agent Zero Browser Stack")

        last_status = 502
        last_message = "upstream unavailable"
        for attempt in range(MAX_ATTEMPTS):
            try:
                upstream_request = client.build_request(
                    request.method,
                    f"{UPSTREAM}/{path}",
                    params=request.query_params,
                    headers=headers,
                    content=body,
                )
                response = await client.send(upstream_request, stream=True)
                last_status = response.status_code
                if response.status_code == 400:
                    payload = await response.aread()
                    if temporary_model_error(payload) and attempt + 1 < MAX_ATTEMPTS:
                        last_message = payload.decode("utf-8", errors="replace")[-1000:]
                        delay = retry_delay(attempt, response)
                        await response.aclose()
                        log.warning(
                            "model is not ready; keeping partition slot and retrying %s/%s in %ss",
                            attempt + 1,
                            MAX_ATTEMPTS,
                            delay,
                        )
                        await asyncio.sleep(delay)
                        continue

                    await response.aclose()
                    await client.aclose()
                    ACTIVE = 0
                    SLOT.release()
                    handed_to_stream = True
                    return Response(
                        content=payload,
                        status_code=response.status_code,
                        headers=response_headers(response.headers),
                    )

                if response.status_code in RETRYABLE and attempt + 1 < MAX_ATTEMPTS:
                    payload = await response.aread()
                    last_message = payload.decode("utf-8", errors="replace")[-1000:]
                    delay = retry_delay(attempt, response)
                    await response.aclose()
                    log.warning(
                        "upstream HTTP %s; keeping partition slot and retrying %s/%s in %ss",
                        last_status,
                        attempt + 1,
                        MAX_ATTEMPTS,
                        delay,
                    )
                    await asyncio.sleep(delay)
                    continue

                # Do not forward streaming headers until the provider has
                # completed successfully.  This is intentionally buffered:
                # correctness and transparent retry are more important here
                # than displaying partial tokens a few seconds earlier.
                if response.status_code < 400 and wants_stream:
                    payload = await response.aread()
                    if temporary_stream_error(payload) and attempt + 1 < MAX_ATTEMPTS:
                        last_message = payload.decode("utf-8", errors="replace")[-1000:]
                        delay = retry_delay(attempt, response)
                        await response.aclose()
                        log.warning(
                            "retryable error inside HTTP-200 stream; keeping partition slot and retrying %s/%s in %ss",
                            attempt + 1,
                            MAX_ATTEMPTS,
                            delay,
                        )
                        await asyncio.sleep(delay)
                        continue
                    await response.aclose()
                    await client.aclose()
                    ACTIVE = 0
                    SLOT.release()
                    handed_to_stream = True
                    return Response(
                        content=payload,
                        status_code=response.status_code,
                        headers=response_headers(response.headers),
                    )

                async def stream_body() -> AsyncIterator[bytes]:
                    global ACTIVE
                    try:
                        async for chunk in response.aiter_raw():
                            yield chunk
                    finally:
                        await response.aclose()
                        await client.aclose()
                        ACTIVE = 0
                        SLOT.release()

                handed_to_stream = True
                return StreamingResponse(
                    stream_body(),
                    status_code=response.status_code,
                    headers=response_headers(response.headers),
                )
            except (httpx.TimeoutException, httpx.NetworkError) as exc:
                last_message = f"{type(exc).__name__}: {exc}"
                if attempt + 1 < MAX_ATTEMPTS:
                    delay = retry_delay(attempt)
                    log.warning(
                        "transport failure; keeping partition slot and retrying %s/%s in %ss",
                        attempt + 1,
                        MAX_ATTEMPTS,
                        delay,
                    )
                    await asyncio.sleep(delay)
                    continue
                break

        return JSONResponse(
            status_code=last_status if last_status >= 400 else 502,
            content={
                "error": {
                    "message": f"Featherless request exhausted inside Agent Zero partition: {last_message}",
                    "type": "upstream_exhausted",
                }
            },
        )
    finally:
        if not handed_to_stream:
            await client.aclose()
            ACTIVE = 0
            SLOT.release()
