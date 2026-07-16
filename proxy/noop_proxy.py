"""Bare minimum passthrough proxy. Zero modification. Pure forward."""
import asyncio
import httpx
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse, JSONResponse, Response

app = FastAPI()
client = httpx.AsyncClient(base_url="https://api.anthropic.com", timeout=300.0)

STRIP = {"host", "content-length", "transfer-encoding", "content-encoding", "connection"}

@app.head("/")
@app.get("/")
async def root():
    return JSONResponse({"status": "ok"})

@app.api_route("/{path:path}", methods=["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH"])
async def proxy(request: Request, path: str):
    query = request.url.query
    url = f"/{path}?{query}" if query else f"/{path}"
    headers = {k: v for k, v in request.headers.items() if k not in STRIP}
    body = await request.body()

    print(f"[NOOP] {request.method} {url} ({len(body)} bytes)", flush=True)

    is_stream = False
    if body:
        try:
            import json
            is_stream = json.loads(body).get("stream", False)
        except Exception:
            pass

    if is_stream:
        req = client.build_request(method=request.method, url=url, headers=headers, content=body)
        resp = await client.send(req, stream=True)
        async def stream():
            async for chunk in resp.aiter_bytes():
                yield chunk
            await resp.aclose()
        resp_headers = {k: v for k, v in resp.headers.items() if k not in STRIP}
        return StreamingResponse(stream(), status_code=resp.status_code, headers=resp_headers)
    else:
        resp = await client.request(method=request.method, url=url, headers=headers, content=body)
        resp_headers = {k: v for k, v in resp.headers.items() if k not in STRIP}
        return Response(content=resp.content, status_code=resp.status_code, headers=resp_headers)

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8780, log_level="info")
