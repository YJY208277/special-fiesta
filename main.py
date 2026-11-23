"""RadarScope 第一阶段后端。

运行：
    pip install -r requirements.txt
    uvicorn main:app --host 127.0.0.1 --port 8000 --reload

接口：
    GET  /api/health     健康检查
    GET  /api/config     雷达与仿真配置
    GET  /api/scenario   当前目标场景
    GET  /api/snapshot   最近一帧快照
    WS   /ws             实时目标帧

静态前端默认从同级的 frontend/ 目录挂载。项目完成前端后，将 index.html
及 assets 放入该目录即可通过 http://127.0.0.1:8000/ 访问。
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import math
import os
import random
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Any

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
)
logger = logging.getLogger("radarscope")

BASE_DIR = Path(__file__).resolve().parent
FRONTEND_DIR = Path(
    os.getenv("RADARSCOPE_FRONTEND_DIR", str(BASE_DIR / "frontend"))
).resolve()

UPDATE_INTERVAL_SECONDS = 0.5
SEND_TIMEOUT_SECONDS = 0.2
MIN_TARGETS = 5
MAX_TARGETS = 8
MIN_DISTANCE_M = 10_000.0
MAX_DISTANCE_M = 100_000.0
RADAR_CONFIG = {
    "name": "CNRAD/SA-B.001",
    "band": "S",
    "freq_ghz": 3.0,
    "pt_mw": 1.5,
    "gain_db": 35.0,
    "beamwidth_deg": 3.0,
    "prf_hz": 1000,
    "pulse_us": 40.0,
    "bw_mhz": 2.0,
    "rpm": 30.0,
    "range_km": 150,
    "pfa": 1e-6,
    "pd": 0.9,
    "sigma_r_m": 30.0,
    "sigma_az_deg": 0.3,
    "rmax_km": 189.0,
}

DISPLAY_CONFIG = {
    "range_options": [25, 50, 75, 100, 150],
    "trail_len": 12,
}

SIMULATION_CONFIG = {
    "update_interval_ms": int(UPDATE_INTERVAL_SECONDS * 1000),
    "tick_hz": 1.0 / UPDATE_INTERVAL_SECONDS,
    "target_count_range": [MIN_TARGETS, MAX_TARGETS],
    "distance_km_range": [
        int(MIN_DISTANCE_M / 1000),
        int(MAX_DISTANCE_M / 1000),
    ],
}


def norm_deg(angle: float) -> float:
    """将角度归一化到 [0, 360)。0° 为正北，顺时针为正。"""
    return angle % 360.0


class TargetStatus(StrEnum):
    ACTIVE = "ACTIVE"


@dataclass(slots=True)
class Target:
    """带极坐标运动的二维模拟目标。

    distance_m 与 azimuth_deg 是目标真值。速度沿径向与切向分解，
    因此 speed_mps 始终保持不变。目标到达 10 km 或 100 km 边界时，
    径向速度反向，避免第一阶段演示时目标跑出显示范围。
    """

    id: str
    distance_m: float
    azimuth_deg: float
    speed_mps: float
    status: TargetStatus = TargetStatus.ACTIVE
    radial_speed_mps: float = 0.0
    tangential_speed_mps: float = 0.0

    def __post_init__(self) -> None:
        if not MIN_DISTANCE_M <= self.distance_m <= MAX_DISTANCE_M:
            raise ValueError("distance_m must be between 10 km and 100 km")
        self.azimuth_deg = norm_deg(self.azimuth_deg)

    @classmethod
    def generate_targets(
        cls,
        count: int | None = None,
        rng: random.Random | None = None,
    ) -> list["Target"]:
        """生成 5-8 个目标；可传入 count 便于测试固定数量。"""
        rng = rng or random.Random()
        if count is None:
            count = rng.randint(MIN_TARGETS, MAX_TARGETS)
        if not MIN_TARGETS <= count <= MAX_TARGETS:
            raise ValueError(f"count must be between {MIN_TARGETS} and {MAX_TARGETS}")

        targets: list[Target] = []
        for index in range(count):
            speed = rng.uniform(80.0, 650.0)
            radial_fraction = rng.uniform(-0.30, 0.30)
            radial_speed = speed * radial_fraction
            tangential_speed = math.sqrt(speed**2 - radial_speed**2)
            if rng.random() < 0.5:
                tangential_speed *= -1.0

            targets.append(
                cls(
                    id=f"TGT-{index + 1:03d}",
                    distance_m=rng.uniform(MIN_DISTANCE_M, MAX_DISTANCE_M),
                    azimuth_deg=rng.uniform(0.0, 360.0),
                    speed_mps=speed,
                    radial_speed_mps=radial_speed,
                    tangential_speed_mps=tangential_speed,
                )
            )
        return targets

    @property
    def distance_km(self) -> float:
        return self.distance_m / 1000.0

    @property
    def x_m(self) -> float:
        return self.distance_m * math.sin(math.radians(self.azimuth_deg))

    @property
    def y_m(self) -> float:
        return self.distance_m * math.cos(math.radians(self.azimuth_deg))

    @property
    def heading_deg(self) -> float:
        azimuth = math.radians(self.azimuth_deg)
        vx = (
            self.radial_speed_mps * math.sin(azimuth)
            + self.tangential_speed_mps * math.cos(azimuth)
        )
        vy = (
            self.radial_speed_mps * math.cos(azimuth)
            - self.tangential_speed_mps * math.sin(azimuth)
        )
        return norm_deg(math.degrees(math.atan2(vx, vy)))

    def update(self, dt_seconds: float) -> None:
        """按真实经过时间推进目标。"""
        if dt_seconds <= 0:
            return

        next_distance = (
            self.distance_m + self.radial_speed_mps * dt_seconds
        )
        if next_distance <= MIN_DISTANCE_M:
            next_distance = MIN_DISTANCE_M
            self.radial_speed_mps = abs(self.radial_speed_mps)
        elif next_distance >= MAX_DISTANCE_M:
            next_distance = MAX_DISTANCE_M
            self.radial_speed_mps = -abs(self.radial_speed_mps)

        # 切向速度决定方位角变化；r·dθ/dt = v_t。
        angular_rate_deg_s = math.degrees(
            self.tangential_speed_mps / max(next_distance, 1.0)
        )
        self.distance_m = next_distance
        self.azimuth_deg = norm_deg(
            self.azimuth_deg + angular_rate_deg_s * dt_seconds
        )

    def to_dict(self) -> dict[str, Any]:
        """转换为前端可直接消费的 JSON 数据。

        distance 使用 km，方便按需求直接展示 10-100 的数值；
        range_m 为架构契约规定的标准米制字段。
        """
        return {
            "id": self.id,
            "distance": round(self.distance_km, 3),
            "distance_unit": "km",
            "azimuth": round(self.azimuth_deg, 3),
            "speed": round(self.speed_mps, 2),
            "speed_unit": "m/s",
            "status": self.status.value,
            "range_m": round(self.distance_m, 2),
            "az": round(self.azimuth_deg, 3),
            "x": round(self.x_m, 2),
            "y": round(self.y_m, 2),
            "hdg": round(self.heading_deg, 3),
        }


class RadarSimulator:
    """维护唯一仿真时钟、目标集合和帧序号。"""

    def __init__(self) -> None:
        self.targets = Target.generate_targets()
        self.started_at = time.perf_counter()
        self.sim_time = 0.0
        self.seq = 0
        self.scan_azimuth = 0.0
        self.scan_revolution = 0
        self._scan_total_deg = 0.0
        self._last_frame = self._build_frame(tick_ms=0.0)

    @property
    def uptime_seconds(self) -> float:
        return time.perf_counter() - self.started_at

    def step(self, dt_seconds: float) -> dict[str, Any]:
        started = time.perf_counter()
        dt_seconds = max(0.0, dt_seconds)

        for target in self.targets:
            target.update(dt_seconds)

        self.sim_time += dt_seconds
        self._scan_total_deg += RADAR_CONFIG["rpm"] * 6.0 * dt_seconds
        self.scan_azimuth = norm_deg(self._scan_total_deg)
        self.scan_revolution = int(self._scan_total_deg // 360.0)
        self.seq += 1

        tick_ms = (time.perf_counter() - started) * 1000.0
        self._last_frame = self._build_frame(tick_ms=tick_ms)
        return self._last_frame

    def config_payload(self) -> dict[str, Any]:
        return {
            "protocol": "radarscope/1.0",
            "radar": RADAR_CONFIG,
            "display": DISPLAY_CONFIG,
            "simulation": SIMULATION_CONFIG,
        }

    def scenario_payload(self) -> dict[str, Any]:
        return {
            "name": "第一阶段目标巡检场景",
            "targets": [target.to_dict() for target in self.targets],
        }

    def hello_payload(self) -> dict[str, Any]:
        return {
            "type": "hello",
            "server": "radarscope/1.0",
            "ts": time.time(),
            "config": self.config_payload(),
            "scenario": self.scenario_payload(),
        }

    def snapshot_payload(self) -> dict[str, Any]:
        return self._last_frame

    def _build_frame(self, tick_ms: float) -> dict[str, Any]:
        target_payloads = [target.to_dict() for target in self.targets]
        return {
            "type": "frame",
            "seq": self.seq,
            "ts": time.time(),
            "sim_t": round(self.sim_time, 3),
            "scan": {
                "az": round(self.scan_azimuth, 3),
                "rev": self.scan_revolution,
                "rpm": RADAR_CONFIG["rpm"],
                "speed": 1.0,
                "paused": False,
            },
            "stats": {
                "targets": len(target_payloads),
                "tracks": 0,
                "plots": 0,
                "pfa_events": 0,
                "tick_ms": round(tick_ms, 3),
            },
            "targets": target_payloads,
            # 第一阶段尚未加入关联与卡尔曼滤波，保留架构契约字段。
            "tracks": [],
            "plots": [],
        }


class ConnectionHub:
    """管理 WebSocket 连接并广播最新全量快照。"""

    def __init__(self) -> None:
        self._connections: set[WebSocket] = set()
        self._send_locks: dict[WebSocket, asyncio.Lock] = {}

    @property
    def client_count(self) -> int:
        return len(self._connections)

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self._connections.add(websocket)
        self._send_locks[websocket] = asyncio.Lock()
        logger.info("WebSocket connected; clients=%d", self.client_count)

    def disconnect(self, websocket: WebSocket) -> None:
        self._connections.discard(websocket)
        self._send_locks.pop(websocket, None)
        logger.info("WebSocket disconnected; clients=%d", self.client_count)

    async def send(self, websocket: WebSocket, payload: dict[str, Any]) -> None:
        send_lock = self._send_locks.get(websocket)
        if send_lock is None:
            raise RuntimeError("WebSocket is not connected")

        try:
            async with send_lock:
                await asyncio.wait_for(
                    websocket.send_json(payload),
                    timeout=SEND_TIMEOUT_SECONDS,
                )
        except Exception:
            self.disconnect(websocket)
            with contextlib.suppress(Exception):
                await websocket.close()
            raise

    async def broadcast(self, payload: dict[str, Any]) -> None:
        if not self._connections:
            return

        connections = tuple(self._connections)
        results = await asyncio.gather(
            *(self.send(websocket, payload) for websocket in connections),
            return_exceptions=True,
        )
        failed = sum(isinstance(result, BaseException) for result in results)
        if failed:
            logger.debug("Broadcast removed %d failed connection(s)", failed)

    async def close_all(self) -> None:
        connections = tuple(self._connections)
        self._connections.clear()
        self._send_locks.clear()
        for websocket in connections:
            with contextlib.suppress(Exception):
                await websocket.close()


simulator = RadarSimulator()
hub = ConnectionHub()


async def simulation_loop() -> None:
    """每 0.5 秒推进目标并广播一帧，使用单调时钟避免累计漂移。"""
    loop = asyncio.get_running_loop()
    last_tick = loop.time()
    next_deadline = last_tick + UPDATE_INTERVAL_SECONDS

    while True:
        try:
            await asyncio.sleep(max(0.0, next_deadline - loop.time()))
            now = loop.time()
            dt_seconds = min(now - last_tick, 2.0)
            last_tick = now
            next_deadline += UPDATE_INTERVAL_SECONDS

            # 机器短暂卡顿时直接跳到当前时刻，避免补发过期帧。
            if next_deadline < now:
                next_deadline = now + UPDATE_INTERVAL_SECONDS

            frame = simulator.step(dt_seconds)
            await hub.broadcast(frame)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Simulation tick failed; the loop will continue")
            await asyncio.sleep(UPDATE_INTERVAL_SECONDS)
            last_tick = asyncio.get_running_loop().time()
            next_deadline = last_tick + UPDATE_INTERVAL_SECONDS


@asynccontextmanager
async def lifespan(_: FastAPI):
    if not FRONTEND_DIR.is_dir():
        logger.warning(
            "Frontend directory does not exist yet: %s "
            "(mount remains available for the next phase)",
            FRONTEND_DIR,
        )

    simulation_task = asyncio.create_task(
        simulation_loop(),
        name="radar-simulation-loop",
    )
    logger.info(
        "RadarScope started: %d targets, update every %.1f s",
        len(simulator.targets),
        UPDATE_INTERVAL_SECONDS,
    )
    try:
        yield
    finally:
        simulation_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await simulation_task
        await hub.close_all()
        logger.info("RadarScope simulation loop stopped")


app = FastAPI(
    title="RadarScope Backend",
    version="1.0.0",
    lifespan=lifespan,
)


@app.get("/api/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "uptime_s": round(simulator.uptime_seconds, 3),
        "seq": simulator.seq,
        "clients": hub.client_count,
    }


@app.get("/api/config")
async def get_config() -> dict[str, Any]:
    return simulator.config_payload()


@app.get("/api/scenario")
async def get_scenario() -> dict[str, Any]:
    return simulator.scenario_payload()


@app.get("/api/snapshot")
async def get_snapshot() -> dict[str, Any]:
    return simulator.snapshot_payload()


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await hub.connect(websocket)
    try:
        await hub.send(websocket, simulator.hello_payload())

        while True:
            text = await websocket.receive_text()
            try:
                message = json.loads(text)
            except json.JSONDecodeError:
                await hub.send(
                    websocket,
                    {
                        "type": "ack",
                        "ok": False,
                        "msg": "message must be valid JSON",
                    },
                )
                continue

            if not isinstance(message, dict):
                await hub.send(
                    websocket,
                    {
                        "type": "ack",
                        "ok": False,
                        "msg": "message must be a JSON object",
                    },
                )
                continue

            message_type = message.get("type")
            if message_type == "ping":
                await hub.send(
                    websocket,
                    {
                        "type": "pong",
                        "client_ts": message.get("ts"),
                        "server_ts": time.time(),
                    },
                )
            elif message_type == "cmd" and message.get("action") == "get_snapshot":
                await hub.send(websocket, simulator.snapshot_payload())
            else:
                await hub.send(
                    websocket,
                    {
                        "type": "ack",
                        "ok": False,
                        "msg": f"unsupported message type/action: {message_type}",
                    },
                )
    except WebSocketDisconnect:
        pass
    except Exception:
        logger.debug("WebSocket session closed unexpectedly", exc_info=True)
    finally:
        hub.disconnect(websocket)


# 必须放在 API 与 WebSocket 路由之后，"/" 才不会遮住它们。
app.mount(
    "/",
    StaticFiles(directory=str(FRONTEND_DIR), html=True, check_dir=False),
    name="frontend",
)


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)
