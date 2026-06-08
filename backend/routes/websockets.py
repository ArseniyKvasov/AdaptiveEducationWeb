from __future__ import annotations

import json
import logging
from typing import Any
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

logger = logging.getLogger(__name__)

router = APIRouter()

# Global mapping of user_id -> set of active WebSocket connections
WS_CONNECTIONS: dict[str, set[WebSocket]] = {}


async def broadcast_to_user(user_id: str, payload: dict[str, Any]) -> None:
    """Broadcasts a JSON message payload to all active WebSockets of a user."""
    clients = WS_CONNECTIONS.get(user_id, set()).copy()
    if not clients:
        return
    message = json.dumps(payload, ensure_ascii=False)
    for ws in clients:
        try:
            await ws.send_text(message)
        except Exception:
            WS_CONNECTIONS.get(user_id, set()).discard(ws)


@router.websocket("/ws/generations")
async def websocket_generations(websocket: WebSocket):
    """WebSocket endpoint to monitor task processing and progress changes."""
    user_id = websocket.query_params.get("user_id")
    if not user_id:
        await websocket.close(code=1008)
        return
    await websocket.accept()
    WS_CONNECTIONS.setdefault(user_id, set()).add(websocket)
    try:
        await websocket.send_text(json.dumps({"type": "connected"}, ensure_ascii=False))
        while True:
            # Keep-alive loop
            _ = await websocket.receive_text()
            await websocket.send_text(json.dumps({"type": "pong"}, ensure_ascii=False))
    except WebSocketDisconnect:
        pass
    finally:
        WS_CONNECTIONS.get(user_id, set()).discard(websocket)
