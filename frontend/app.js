(() => {
  "use strict";

  const WS_URL = "ws://127.0.0.1:8000/ws";
  const MAX_TRACK_POINTS = 5;
  const TARGET_RANGE_KM = 100;
  const TAU = Math.PI * 2;

  const state = {
    targets: new Map(),
    hoveredId: null,
    selectedId: null,
    connected: false,
    reconnectDelay: 1000,
    socket: null,
    sweepAngle: 0,
    serverAzimuth: 0,
    rpm: 30,
    revolution: 0,
    sequence: 0,
    simTime: 0,
    tickMs: 0,
    frameEvents: 0,
    lastFrameAt: 0,
    fps: 60,
    lastRenderAt: performance.now(),
    configured: false,
  };

  const elements = {
    bootOverlay: document.getElementById("bootOverlay"),
    linkState: document.getElementById("linkState"),
    systemClock: document.getElementById("systemClock"),
    targetTableBody: document.getElementById("targetTableBody"),
    targetCount: document.getElementById("targetCount"),
    targetMeta: document.getElementById("targetMeta"),
    radarName: document.getElementById("radarName"),
    miniSweep: document.getElementById("miniSweep"),
    azimuthReadout: document.getElementById("azimuthReadout"),
    revisionReadout: document.getElementById("revisionReadout"),
    dialNeedle: document.getElementById("dialNeedle"),
    dialAzimuth: document.getElementById("dialAzimuth"),
    simTimeReadout: document.getElementById("simTimeReadout"),
    sequenceReadout: document.getElementById("sequenceReadout"),
    tickReadout: document.getElementById("tickReadout"),
    fpsReadout: document.getElementById("fpsReadout"),
    waveStatus: document.getElementById("waveStatus"),
    signalBars: [...document.querySelectorAll("#signalBars i")],
    scopeStage: document.getElementById("scopeStage"),
    radarCanvas: document.getElementById("radarCanvas"),
    signalCanvas: document.getElementById("signalCanvas"),
    eventLog: document.getElementById("eventLog"),
    barInner: document.getElementById("barInner"),
    barMid: document.getElementById("barMid"),
    barOuter: document.getElementById("barOuter"),
    countInner: document.getElementById("countInner"),
    countMid: document.getElementById("countMid"),
    countOuter: document.getElementById("countOuter"),
  };

  const radarCtx = elements.radarCanvas.getContext("2d");
  const signalCtx = elements.signalCanvas.getContext("2d");
  const staticCanvas = document.createElement("canvas");
  const staticCtx = staticCanvas.getContext("2d");

  const geometry = {
    cssSize: 0,
    dpr: 1,
    cx: 0,
    cy: 0,
    radius: 0,
  };

  function normalizeDegrees(value) {
    return ((value % 360) + 360) % 360;
  }

  function shortestAngleDelta(from, to) {
    return ((to - from + 540) % 360) - 180;
  }

  function polarToCanvas(angleDeg, distanceKm) {
    const angle = (angleDeg * Math.PI) / 180;
    const px = (distanceKm / TARGET_RANGE_KM) * geometry.radius;
    return {
      x: geometry.cx + Math.sin(angle) * px,
      y: geometry.cy - Math.cos(angle) * px,
    };
  }

  function setupCanvas(canvas, context) {
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { width, height, dpr };
  }

  function resizeRadar() {
    const size = setupCanvas(elements.radarCanvas, radarCtx);
    geometry.cssSize = Math.min(size.width, size.height);
    geometry.dpr = size.dpr;
    geometry.cx = size.width / 2;
    geometry.cy = size.height / 2;
    geometry.radius = Math.min(size.width, size.height) * 0.41;
    buildStaticRadar();
  }

  function buildStaticRadar() {
    const rect = elements.radarCanvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    staticCanvas.width = Math.round(width * geometry.dpr);
    staticCanvas.height = Math.round(height * geometry.dpr);
    staticCtx.setTransform(geometry.dpr, 0, 0, geometry.dpr, 0, 0);
    const cx = width / 2;
    const cy = height / 2;
    const radius = Math.min(width, height) * 0.41;
    const ctx = staticCtx;

    ctx.clearRect(0, 0, width, height);

    const background = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * 1.06);
    background.addColorStop(0, "rgba(0, 255, 156, 0.055)");
    background.addColorStop(0.48, "rgba(0, 72, 46, 0.12)");
    background.addColorStop(0.79, "rgba(0, 31, 20, 0.19)");
    background.addColorStop(1, "rgba(0, 0, 0, 0.62)");
    ctx.beginPath();
    ctx.arc(cx, cy, radius + 8, 0, TAU);
    ctx.fillStyle = background;
    ctx.fill();

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, TAU);
    ctx.clip();

    ctx.strokeStyle = "rgba(0, 255, 156, 0.035)";
    ctx.lineWidth = 1;
    const gridStep = (radius * 2) / 20;
    for (let index = -10; index <= 10; index += 1) {
      const offset = index * gridStep;
      if (index % 5 === 0) {
        ctx.strokeStyle = "rgba(0, 255, 156, 0.075)";
      } else {
        ctx.strokeStyle = "rgba(0, 255, 156, 0.026)";
      }
      ctx.beginPath();
      ctx.moveTo(cx + offset, cy - radius);
      ctx.lineTo(cx + offset, cy + radius);
      ctx.moveTo(cx - radius, cy + offset);
      ctx.lineTo(cx + radius, cy + offset);
      ctx.stroke();
    }
    ctx.restore();

    for (let index = 1; index <= 4; index += 1) {
      const ringRadius = (radius * index) / 4;
      ctx.beginPath();
      ctx.arc(cx, cy, ringRadius, 0, TAU);
      ctx.strokeStyle =
        index === 4
          ? "rgba(61, 255, 184, 0.56)"
          : "rgba(0, 255, 156, 0.2)";
      ctx.lineWidth = index === 4 ? 1.4 : 1;
      ctx.stroke();

      if (index < 4) {
        ctx.save();
        ctx.setLineDash([2, 7]);
        ctx.beginPath();
        ctx.arc(cx, cy, ringRadius, 0, TAU);
        ctx.strokeStyle = "rgba(0, 255, 156, 0.085)";
        ctx.stroke();
        ctx.restore();
      }

      const labelAngle = Math.PI / 4;
      const labelX = cx + Math.sin(labelAngle) * ringRadius + 6;
      const labelY = cy - Math.cos(labelAngle) * ringRadius - 5;
      ctx.fillStyle = "rgba(104, 190, 156, 0.58)";
      ctx.font = "8px Consolas, monospace";
      ctx.fillText(`${index * 25}`, labelX, labelY);
      ctx.fillStyle = "rgba(97, 161, 138, 0.42)";
      ctx.font = "6px Consolas, monospace";
      ctx.fillText("KM", labelX + 14, labelY);
    }

    ctx.strokeStyle = "rgba(0, 255, 156, 0.74)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, radius + 10, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = "rgba(0, 255, 156, 0.16)";
    ctx.beginPath();
    ctx.arc(cx, cy, radius + 16, 0, TAU);
    ctx.stroke();

    ctx.save();
    ctx.translate(cx, cy);
    ctx.lineWidth = 1;
    for (let degree = 0; degree < 360; degree += 2) {
      const major = degree % 30 === 0;
      const medium = degree % 10 === 0;
      const length = major ? 12 : medium ? 7 : 4;
      const angle = ((degree - 90) * Math.PI) / 180;
      const start = radius + 1;
      const end = radius + 1 + length;
      ctx.beginPath();
      ctx.moveTo(Math.cos(angle) * start, Math.sin(angle) * start);
      ctx.lineTo(Math.cos(angle) * end, Math.sin(angle) * end);
      ctx.strokeStyle = major
        ? "rgba(103, 255, 195, 0.72)"
        : medium
          ? "rgba(0, 255, 156, 0.4)"
          : "rgba(0, 255, 156, 0.2)";
      ctx.stroke();
    }

    ctx.font = "7px Consolas, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let degree = 0; degree < 360; degree += 30) {
      const angle = ((degree - 90) * Math.PI) / 180;
      const labelRadius = radius + 27;
      ctx.fillStyle = "rgba(149, 221, 194, 0.66)";
      ctx.fillText(
        String(degree).padStart(3, "0"),
        Math.cos(angle) * labelRadius,
        Math.sin(angle) * labelRadius,
      );
    }
    ctx.restore();

    ctx.strokeStyle = "rgba(0, 255, 156, 0.2)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, cy - radius);
    ctx.lineTo(cx, cy + radius);
    ctx.moveTo(cx - radius, cy);
    ctx.lineTo(cx + radius, cy);
    ctx.stroke();

    ctx.strokeStyle = "rgba(0, 255, 156, 0.12)";
    ctx.setLineDash([4, 8]);
    ctx.beginPath();
    ctx.moveTo(cx - radius * 0.707, cy - radius * 0.707);
    ctx.lineTo(cx + radius * 0.707, cy + radius * 0.707);
    ctx.moveTo(cx + radius * 0.707, cy - radius * 0.707);
    ctx.lineTo(cx - radius * 0.707, cy + radius * 0.707);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.font = "700 9px Consolas, monospace";
    ctx.textAlign = "center";
    ctx.fillStyle = "rgba(107, 255, 198, 0.95)";
    ctx.fillText("N", cx, cy - radius - 31);
    ctx.fillStyle = "rgba(0, 255, 156, 0.55)";
    ctx.fillText("E", cx + radius + 29, cy + 1);
    ctx.fillText("S", cx, cy + radius + 34);
    ctx.fillText("W", cx - radius - 29, cy + 1);

    ctx.beginPath();
    ctx.moveTo(cx, cy - radius - 21);
    ctx.lineTo(cx - 4, cy - radius - 27);
    ctx.lineTo(cx + 4, cy - radius - 27);
    ctx.closePath();
    ctx.fillStyle = "rgba(0, 255, 156, 0.75)";
    ctx.fill();

    const vignette = ctx.createRadialGradient(
      cx,
      cy,
      radius * 0.62,
      cx,
      cy,
      radius * 1.1,
    );
    vignette.addColorStop(0, "rgba(0, 0, 0, 0)");
    vignette.addColorStop(1, "rgba(0, 0, 0, 0.34)");
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, width, height);
  }

  function drawRadar(time) {
    const { cx, cy, radius } = geometry;
    const { width, height } = elements.radarCanvas.getBoundingClientRect();
    radarCtx.clearRect(0, 0, width, height);
    radarCtx.drawImage(
      staticCanvas,
      0,
      0,
      staticCanvas.width,
      staticCanvas.height,
      0,
      0,
      width,
      height,
    );

    drawSweep(cx, cy, radius);
    drawNoiseField(cx, cy, radius, time);
    drawTrails();
    drawTargets(time);
  }

  function drawSweep(cx, cy, radius) {
    const ctx = radarCtx;
    const slices = 46;
    const span = 58;
    const leading = state.sweepAngle;

    ctx.save();
    ctx.globalCompositeOperation = "screen";
    for (let index = slices - 1; index >= 0; index -= 1) {
      const ratio = index / slices;
      const end = leading - ratio * span;
      const start = end - span / slices - 0.35;
      const alpha = 0.11 * (1 - ratio) ** 2.45;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(
        cx,
        cy,
        radius,
        ((start - 90) * Math.PI) / 180,
        ((end - 90) * Math.PI) / 180,
      );
      ctx.closePath();
      ctx.fillStyle = `rgba(0, 255, 156, ${alpha.toFixed(4)})`;
      ctx.fill();
    }

    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(
      cx,
      cy,
      radius,
      ((leading - 16 - 90) * Math.PI) / 180,
      ((leading - 90) * Math.PI) / 180,
    );
    ctx.closePath();
    const edgeGradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    edgeGradient.addColorStop(0, "rgba(0, 255, 156, 0.02)");
    edgeGradient.addColorStop(0.78, "rgba(0, 255, 156, 0.1)");
    edgeGradient.addColorStop(1, "rgba(150, 255, 214, 0.22)");
    ctx.fillStyle = edgeGradient;
    ctx.fill();

    const angle = ((leading - 90) * Math.PI) / 180;
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(x, y);
    ctx.strokeStyle = "rgba(159, 255, 215, 0.9)";
    ctx.lineWidth = 1.4;
    ctx.shadowColor = "rgba(0, 255, 156, 0.9)";
    ctx.shadowBlur = 11;
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius + 2, 0, TAU);
    ctx.strokeStyle = "rgba(0, 255, 156, 0.055)";
    ctx.lineWidth = 10;
    ctx.stroke();
    ctx.restore();
  }

  function drawNoiseField(cx, cy, radius, time) {
    const ctx = radarCtx;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, TAU);
    ctx.clip();
    for (let index = 0; index < 22; index += 1) {
      const seed = index * 12.9898 + Math.floor(time / 180);
      const angle = ((Math.sin(seed) * 43758.5453) % 1) * TAU;
      const distance = (Math.abs(Math.sin(seed * 0.73)) * radius * 0.95);
      const x = cx + Math.cos(angle) * distance;
      const y = cy + Math.sin(angle) * distance;
      ctx.fillStyle = `rgba(95, 255, 184, ${0.018 + (index % 3) * 0.01})`;
      ctx.fillRect(x, y, index % 4 === 0 ? 2 : 1, 1);
    }
    ctx.restore();
  }

  function drawTrails() {
    for (const target of state.targets.values()) {
      if (target.trail.length < 2) continue;
      const points = target.trail.map((point) =>
        polarToCanvas(point.azimuth, point.distance),
      );

      for (let index = 1; index < points.length; index += 1) {
        const progress = index / (points.length - 1);
        radarCtx.beginPath();
        radarCtx.moveTo(points[index - 1].x, points[index - 1].y);
        radarCtx.lineTo(points[index].x, points[index].y);
        radarCtx.strokeStyle = `rgba(255, 65, 77, ${0.12 + progress * 0.58})`;
        radarCtx.lineWidth = 0.8 + progress * 1.25;
        radarCtx.lineCap = "round";
        radarCtx.stroke();
      }
    }
  }

  function drawTargets(time) {
    for (const target of state.targets.values()) {
      const position = polarToCanvas(target.smooth.azimuth, target.smooth.distance);
      const hovered = target.id === state.hoveredId;
      const selected = target.id === state.selectedId;
      const active = hovered || selected;
      const pulse = 0.5 + Math.sin(time * 0.005 + target.phase) * 0.5;
      const coreRadius = active ? 6.2 : 4.1;

      if (active) {
        const haloRadius = 16 + pulse * 7;
        const halo = radarCtx.createRadialGradient(
          position.x,
          position.y,
          1,
          position.x,
          position.y,
          haloRadius,
        );
        halo.addColorStop(0, "rgba(255, 109, 114, 0.62)");
        halo.addColorStop(0.38, "rgba(255, 65, 77, 0.2)");
        halo.addColorStop(1, "rgba(255, 65, 77, 0)");
        radarCtx.fillStyle = halo;
        radarCtx.beginPath();
        radarCtx.arc(position.x, position.y, haloRadius, 0, TAU);
        radarCtx.fill();

        radarCtx.strokeStyle = `rgba(255, 122, 128, ${0.35 + pulse * 0.45})`;
        radarCtx.lineWidth = 1;
        radarCtx.beginPath();
        radarCtx.arc(position.x, position.y, 12 + pulse * 7, 0, TAU);
        radarCtx.stroke();
      }

      const glow = radarCtx.createRadialGradient(
        position.x,
        position.y,
        0,
        position.x,
        position.y,
        coreRadius * 3.2,
      );
      glow.addColorStop(0, "rgba(255, 245, 245, 0.95)");
      glow.addColorStop(0.23, "rgba(255, 76, 84, 0.9)");
      glow.addColorStop(0.62, "rgba(255, 28, 42, 0.28)");
      glow.addColorStop(1, "rgba(255, 0, 28, 0)");
      radarCtx.fillStyle = glow;
      radarCtx.beginPath();
      radarCtx.arc(position.x, position.y, coreRadius * 3.2, 0, TAU);
      radarCtx.fill();

      radarCtx.beginPath();
      radarCtx.arc(position.x, position.y, coreRadius, 0, TAU);
      radarCtx.fillStyle = "#ff5058";
      radarCtx.shadowColor = "#ff2333";
      radarCtx.shadowBlur = active ? 18 : 9;
      radarCtx.fill();
      radarCtx.shadowBlur = 0;

      radarCtx.strokeStyle = "rgba(255, 235, 237, 0.8)";
      radarCtx.lineWidth = 0.7;
      radarCtx.beginPath();
      radarCtx.arc(position.x, position.y, coreRadius + 2.5, 0, TAU);
      radarCtx.stroke();

      radarCtx.fillStyle = active
        ? "rgba(255, 236, 238, 0.95)"
        : "rgba(255, 179, 183, 0.72)";
      radarCtx.font = `${active ? "700" : "500"} 8px Consolas, monospace`;
      radarCtx.textAlign = "left";
      radarCtx.fillText(target.id, position.x + 11, position.y - 8);

      if (active) {
        radarCtx.fillStyle = "rgba(177, 224, 205, 0.72)";
        radarCtx.font = "6px Consolas, monospace";
        radarCtx.fillText(
          `${target.smooth.distance.toFixed(1)}KM / ${target.smooth.azimuth.toFixed(1)}°`,
          position.x + 11,
          position.y + 3,
        );
      }
    }
  }

  function drawSignal(time) {
    const rect = elements.signalCanvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));

    if (
      elements.signalCanvas.width !== Math.round(width * dpr) ||
      elements.signalCanvas.height !== Math.round(height * dpr)
    ) {
      elements.signalCanvas.width = Math.round(width * dpr);
      elements.signalCanvas.height = Math.round(height * dpr);
      signalCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    signalCtx.clearRect(0, 0, width, height);
    signalCtx.strokeStyle = "rgba(0, 255, 156, 0.055)";
    signalCtx.lineWidth = 1;
    for (let x = 0; x <= width; x += 22) {
      signalCtx.beginPath();
      signalCtx.moveTo(x, 0);
      signalCtx.lineTo(x, height);
      signalCtx.stroke();
    }
    for (let y = 0; y <= height; y += 16) {
      signalCtx.beginPath();
      signalCtx.moveTo(0, y);
      signalCtx.lineTo(width, y);
      signalCtx.stroke();
    }

    const activity = state.connected ? 1 : 0.3;
    const phase = time * 0.0025;
    signalCtx.beginPath();
    for (let x = 0; x <= width; x += 1) {
      const envelope = Math.sin((x / width) * Math.PI);
      const wave =
        Math.sin(x * 0.13 + phase) * 8 +
        Math.sin(x * 0.043 - phase * 1.7) * 5 +
        Math.sin(x * 0.31 + phase * 2.2) * 2;
      const y = height / 2 + wave * envelope * activity;
      if (x === 0) signalCtx.moveTo(x, y);
      else signalCtx.lineTo(x, y);
    }
    signalCtx.strokeStyle = state.connected
      ? "rgba(0, 255, 156, 0.82)"
      : "rgba(255, 189, 66, 0.55)";
    signalCtx.lineWidth = 1;
    signalCtx.shadowColor = signalCtx.strokeStyle;
    signalCtx.shadowBlur = 6;
    signalCtx.stroke();
    signalCtx.shadowBlur = 0;

    const sweepX = ((phase * 25) % width + width) % width;
    signalCtx.fillStyle = "rgba(0, 255, 156, 0.08)";
    signalCtx.fillRect(sweepX, 0, 1.5, height);
  }

  function updateSmoothTargets(dt) {
    for (const target of state.targets.values()) {
      const blend = Math.min(1, dt * 4.5);
      const deltaAzimuth = shortestAngleDelta(
        target.smooth.azimuth,
        target.azimuth,
      );
      target.smooth.azimuth = normalizeDegrees(
        target.smooth.azimuth + deltaAzimuth * blend,
      );
      target.smooth.distance +=
        (target.distance - target.smooth.distance) * blend;
    }
  }

  function renderFrame(time) {
    const dt = Math.min(0.06, Math.max(0, (time - state.lastRenderAt) / 1000));
    state.lastRenderAt = time;
    state.fps = state.fps * 0.93 + (1 / Math.max(dt, 0.001)) * 0.07;

    const displayedDelta = shortestAngleDelta(
      state.sweepAngle,
      state.serverAzimuth + (state.connected ? 0 : 0),
    );
    state.sweepAngle = normalizeDegrees(
      state.sweepAngle + (state.rpm * 6) * dt + displayedDelta * Math.min(1, dt * 1.8),
    );

    updateSmoothTargets(dt);
    drawRadar(time);
    drawSignal(time);
    updateLiveReadouts();
    requestAnimationFrame(renderFrame);
  }

  function updateLiveReadouts() {
    const angle = normalizeDegrees(state.sweepAngle);
    elements.azimuthReadout.textContent = `${angle.toFixed(1).padStart(5, "0")}°`;
    elements.dialAzimuth.textContent = `${Math.round(angle).toString().padStart(3, "0")}°`;
    elements.revisionReadout.textContent = String(state.revolution).padStart(4, "0");
    elements.miniSweep.style.transform = `rotate(${angle}deg)`;
    elements.dialNeedle.style.transform = `rotate(${angle}deg)`;
    elements.fpsReadout.textContent = String(Math.min(99, Math.round(state.fps)));
  }

  function ensureTarget(rawTarget) {
    let target = state.targets.get(rawTarget.id);
    const distance = Number(rawTarget.range_m) / 1000 || Number(rawTarget.distance) || 0;
    const azimuth = normalizeDegrees(Number(rawTarget.azimuth ?? rawTarget.az) || 0);

    if (!target) {
      target = {
        id: rawTarget.id,
        distance,
        azimuth,
        speed: Number(rawTarget.speed) || 0,
        status: rawTarget.status || "ACTIVE",
        smooth: { distance, azimuth },
        trail: [],
        phase: Math.random() * TAU,
      };
      state.targets.set(target.id, target);
    }

    const previous = target.trail[target.trail.length - 1];
    if (
      !previous ||
      Math.hypot(previous.distance - distance, previous.azimuth - azimuth) > 0.04
    ) {
      target.trail.push({ distance, azimuth });
      if (target.trail.length > MAX_TRACK_POINTS) target.trail.shift();
    }

    target.distance = distance;
    target.azimuth = azimuth;
    target.speed = Number(rawTarget.speed) || target.speed;
    target.status = rawTarget.status || target.status;
    return target;
  }

  function applyTargets(targets) {
    if (!Array.isArray(targets)) return;
    const activeIds = new Set();
    for (const rawTarget of targets) {
      if (!rawTarget || typeof rawTarget.id !== "string") continue;
      ensureTarget(rawTarget);
      activeIds.add(rawTarget.id);
    }

    for (const id of state.targets.keys()) {
      if (!activeIds.has(id)) state.targets.delete(id);
    }

    renderTargetTable();
    updateThreatSummary();
  }

  function renderTargetTable() {
    const targets = [...state.targets.values()].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    elements.targetCount.textContent = String(targets.length).padStart(2, "0");
    elements.targetMeta.textContent = targets.length
      ? `${targets.length} CONTACTS / LIVE`
      : "AWAITING DATA";

    if (!targets.length) {
      elements.targetTableBody.innerHTML =
        '<tr class="empty-row"><td colspan="4">等待目标数据链路...</td></tr>';
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const target of targets) {
      const row = document.createElement("tr");
      row.dataset.targetId = target.id;
      row.tabIndex = 0;
      if (target.id === state.hoveredId) row.classList.add("is-active");
      row.innerHTML = `
        <td>${escapeHtml(target.id)}</td>
        <td>${target.distance.toFixed(1)} km</td>
        <td>${target.azimuth.toFixed(1)}°</td>
        <td>${Math.round(target.speed)} m/s</td>
      `;
      row.addEventListener("mouseenter", () => setHoveredTarget(target.id));
      row.addEventListener("mouseleave", () => setHoveredTarget(null));
      row.addEventListener("focus", () => setHoveredTarget(target.id));
      row.addEventListener("blur", () => setHoveredTarget(null));
      row.addEventListener("click", () => {
        state.selectedId = state.selectedId === target.id ? null : target.id;
        setHoveredTarget(target.id);
      });
      fragment.appendChild(row);
    }
    elements.targetTableBody.replaceChildren(fragment);
  }

  function setHoveredTarget(id) {
    if (state.hoveredId === id) return;
    state.hoveredId = id;
    for (const row of elements.targetTableBody.querySelectorAll("tr[data-target-id]")) {
      row.classList.toggle("is-active", row.dataset.targetId === id);
    }
    if (id) {
      addEvent("TRK", `高亮目标 ${id}`);
    }
  }

  function updateThreatSummary() {
    let inner = 0;
    let mid = 0;
    let outer = 0;
    for (const target of state.targets.values()) {
      if (target.distance <= 33) inner += 1;
      else if (target.distance <= 66) mid += 1;
      else outer += 1;
    }
    const total = Math.max(1, inner + mid + outer);
    elements.barInner.style.width = `${(inner / total) * 100}%`;
    elements.barMid.style.width = `${(mid / total) * 100}%`;
    elements.barOuter.style.width = `${(outer / total) * 100}%`;
    elements.countInner.textContent = String(inner);
    elements.countMid.textContent = String(mid);
    elements.countOuter.textContent = String(outer);
  }

  function updateSignalBars() {
    if (!state.connected) {
      elements.signalBars.forEach((bar, index) => {
        bar.style.height = `${8 + (index % 3) * 2}%`;
        bar.style.opacity = "0.2";
      });
      return;
    }

    const targetFactor = Math.min(1, state.targets.size / 8);
    elements.signalBars.forEach((bar, index) => {
      const wave = (Math.sin(performance.now() * 0.004 + index * 1.7) + 1) / 2;
      const height = 18 + wave * 57 + targetFactor * 19;
      bar.style.height = `${height.toFixed(1)}%`;
      bar.style.opacity = String(0.42 + wave * 0.48);
    });
  }

  function setConnectionState(connected) {
    state.connected = connected;
    elements.linkState.textContent = connected ? "SECURE" : "RECONNECTING";
    elements.linkState.className = connected ? "online" : "offline";
    elements.waveStatus.textContent = connected ? "ACQUIRING" : "NO SIGNAL";
    elements.waveStatus.style.color = connected ? "var(--green)" : "var(--red)";
    if (connected) {
      elements.bootOverlay.classList.add("is-hidden");
    }
  }

  function addEvent(kind, message) {
    const now = new Date();
    const time = now.toLocaleTimeString("zh-CN", { hour12: false });
    const line = document.createElement("p");
    line.innerHTML = `<time>${time}</time><span>${escapeHtml(kind)}</span>${escapeHtml(message)}`;
    elements.eventLog.prepend(line);
    while (elements.eventLog.children.length > 5) {
      elements.eventLog.lastElementChild.remove();
    }
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function handleMessage(message) {
    if (!message || typeof message !== "object") return;

    if (message.type === "hello") {
      const radar = message.config?.radar;
      if (radar) {
        state.rpm = Number(radar.rpm) || 30;
        elements.radarName.textContent = radar.name || "CNRAD/SA-B.001";
      }
      if (Array.isArray(message.scenario?.targets)) {
        applyTargets(message.scenario.targets);
      }
      if (!state.configured) {
        state.configured = true;
        addEvent("HELLO", "雷达配置与场景已同步");
      }
      return;
    }

    if (message.type === "frame") {
      applyTargets(message.targets);
      state.sequence = Number(message.seq) || state.sequence;
      state.simTime = Number(message.sim_t) || 0;
      state.revolution = Number(message.scan?.rev) || 0;
      state.serverAzimuth = normalizeDegrees(Number(message.scan?.az) || 0);
      state.rpm = Number(message.scan?.rpm) || state.rpm;
      state.tickMs = Number(message.stats?.tick_ms) || 0;
      state.frameEvents += 1;

      elements.sequenceReadout.textContent = String(state.sequence).padStart(6, "0");
      elements.tickReadout.textContent = state.tickMs.toFixed(2);
      elements.simTimeReadout.textContent = `${state.simTime.toFixed(1)} s`;
      updateSignalBars();

      if (performance.now() - state.lastFrameAt > 2400) {
        addEvent("FRAME", `收到第 ${state.sequence} 帧 / ${state.targets.size} 批目标`);
        state.lastFrameAt = performance.now();
      }
    }
  }

  function connectWebSocket() {
    setConnectionState(false);
    const socket = new WebSocket(WS_URL);
    state.socket = socket;

    socket.addEventListener("open", () => {
      state.reconnectDelay = 1000;
      setConnectionState(true);
      addEvent("LINK", "WebSocket 数据链路已建立");
      socket.send(JSON.stringify({ type: "ping", ts: Date.now() }));
    });

    socket.addEventListener("message", (event) => {
      try {
        handleMessage(JSON.parse(event.data));
      } catch (error) {
        console.warn("Invalid radar message", error);
      }
    });

    socket.addEventListener("close", () => {
      setConnectionState(false);
      addEvent("LINK", `链路断开，${state.reconnectDelay / 1000}s 后重连`);
      window.setTimeout(connectWebSocket, state.reconnectDelay);
      state.reconnectDelay = Math.min(8000, state.reconnectDelay * 1.7);
    });

    socket.addEventListener("error", () => {
      socket.close();
    });
  }

  function tickClock() {
    elements.systemClock.textContent = new Date().toLocaleTimeString("zh-CN", {
      hour12: false,
    });
  }

  const resizeObserver = new ResizeObserver(resizeRadar);
  resizeObserver.observe(elements.scopeStage);

  window.addEventListener("resize", resizeRadar);
  window.setInterval(tickClock, 1000);
  window.setInterval(updateSignalBars, 420);
  window.setInterval(() => {
    if (state.connected && state.socket?.readyState === WebSocket.OPEN) {
      state.socket?.send(JSON.stringify({ type: "ping", ts: Date.now() }));
    }
  }, 5000);

  tickClock();
  resizeRadar();
  connectWebSocket();
  requestAnimationFrame(renderFrame);
})();
