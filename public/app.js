const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const statusEl = document.getElementById('status');
ctx.imageSmoothingEnabled = false;

const TILE = 160;
const TILE_SQUISH = 0.8; // 2.5D tilt effect: tiles are 80% height
const TILE_H = TILE * TILE_SQUISH; // squished tile height
const ELEV = 24;
const WALL_HEIGHT = 60; // vertical height of wall face
const HOTBAR_SLOTS = 9;
const EDGE_BUFFER_X = 2;
const EDGE_BUFFER_Y = 1;
const VIEW_W = Math.floor(canvas.width / TILE);
const VIEW_H = Math.floor((canvas.height - ELEV) / TILE_H);
const ORIGIN_X = Math.floor((canvas.width - VIEW_W * TILE) / 2);
const ORIGIN_Y = Math.floor((canvas.height - (VIEW_H * TILE_H + ELEV)) / 2);

const state = {
  player: { x: 0, y: 0, facing: 'south' },
  camera: {
    x: -Math.floor(VIEW_W / 2),
    y: -Math.floor(VIEW_H / 2),
  },
  objects: new Map(),
  pendingOps: 0,
  modalOpen: false,
  selectedWallSlot: 0,
  wallHotbar: Array.from({ length: HOTBAR_SLOTS }, () => null),
};

const sprites = {
  north: loadImage('/assets/raccoon_north.png'),
  south: loadImage('/assets/raccoon_south.png'),
  east: loadImage('/assets/raccoon_east.png'),
  west: loadImage('/assets/raccoon_west.png'),
};

const normalGrassTextures = [
  loadImage('/assets/textures/grass_master_final.png'),
  loadImage('/assets/textures/grass_var_normal_01.png'),
  loadImage('/assets/textures/grass_var_normal_02.png'),
  loadImage('/assets/textures/grass_var_normal_03.png'),
];

const featureGrassTextures = [
  loadImage('/assets/textures/grass_var_flower_alt_01.png'),
  loadImage('/assets/textures/grass_var_flower_alt_02.png'),
  loadImage('/assets/textures/grass_var_flower_alt_03.png'),
  loadImage('/assets/textures/grass_var_flower_alt_04.png'),
  loadImage('/assets/textures/grass_var_flower_alt_05.png'),
  loadImage('/assets/textures/grass_var_flower_alt_06.png'),
  loadImage('/assets/textures/grass_var_tall.png'),
  loadImage('/assets/textures/grass_var_sunflower.png'),
];

function tileKey(x, y) {
  return `${x},${y}`;
}

function loadImage(src) {
  const img = new Image();
  img.src = src;
  return img;
}

function initWallHotbar() {
  state.wallHotbar[0] = {
    name: 'brick wall',
    imageUrl: '/assets/wall_bricks.png',
    img: loadImage('/assets/wall_bricks.png'),
    pending: false,
  };
}

initWallHotbar();

function hash2(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967295;
}

function textureForTile(x, y) {
  const baseRoll = hash2(x * 3 + 11, y * 5 + 17);
  const featureRoll = hash2(x * 7 + 19, y * 11 + 23);
  const isFeature = featureRoll < 0.11; // keep special tiles occasional

  if (isFeature) {
    const idx = Math.floor(baseRoll * featureGrassTextures.length) % featureGrassTextures.length;
    return featureGrassTextures[idx];
  }

  const idx = Math.floor(baseRoll * normalGrassTextures.length) % normalGrassTextures.length;
  return normalGrassTextures[idx];
}

function worldToScreen(wx, wy) {
  return {
    sx: wx - state.camera.x,
    sy: wy - state.camera.y,
  };
}

function screenToPx(sx, sy) {
  return {
    x: ORIGIN_X + sx * TILE,
    y: ORIGIN_Y + sy * TILE_H, // Use squished height for 2.5D effect
  };
}

function aheadPos() {
  const dirs = {
    north: [0, -1],
    south: [0, 1],
    east: [1, 0],
    west: [-1, 0],
  };
  const [dx, dy] = dirs[state.player.facing];
  return { x: state.player.x + dx, y: state.player.y + dy };
}

function countInstancesOfVariant(objectKey, orientation, excludeTileKey) {
  let count = 0;
  for (const [k, obj] of state.objects.entries()) {
    if (k === excludeTileKey) continue;
    if (obj.objectKey === objectKey && obj.orientation === orientation) {
      count += 1;
    }
  }
  return count;
}

function keepPlayerAwayFromEdge() {
  const sx = state.player.x - state.camera.x;
  const sy = state.player.y - state.camera.y;
  const maxX = VIEW_W - 1 - EDGE_BUFFER_X;
  const maxY = VIEW_H - 1 - EDGE_BUFFER_Y;

  if (sx < EDGE_BUFFER_X) state.camera.x = state.player.x - EDGE_BUFFER_X;
  if (sx > maxX) state.camera.x = state.player.x - maxX;
  if (sy < EDGE_BUFFER_Y) state.camera.y = state.player.y - EDGE_BUFFER_Y;
  if (sy > maxY) state.camera.y = state.player.y - maxY;
}

function startOperationMessage(base) {
  state.pendingOps += 1;
  setStatus(`${base} (${state.pendingOps} active)`);
}

function finishOperationMessage(baseDone) {
  state.pendingOps = Math.max(0, state.pendingOps - 1);
  if (state.pendingOps > 0) {
    setStatus(`${baseDone}. ${state.pendingOps} still active.`);
  } else {
    setStatus(baseDone);
  }
}

/* ---- Custom prompt modal ---- */

function showPrompt(title, defaultValue = '') {
  state.modalOpen = true;
  return new Promise((resolve) => {
    const overlay = document.getElementById('modal-overlay');
    const titleEl = document.getElementById('modal-title');
    const input = document.getElementById('modal-input');
    const okBtn = document.getElementById('modal-ok');
    const cancelBtn = document.getElementById('modal-cancel');

    titleEl.textContent = title;
    input.value = defaultValue;
    overlay.classList.remove('hidden');

    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });

    function cleanup() {
      state.modalOpen = false;
      overlay.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onOverlay);
      input.removeEventListener('keydown', onKey);
    }

    function onOk() {
      const val = input.value;
      cleanup();
      resolve(val);
    }

    function onCancel() {
      cleanup();
      resolve(null);
    }

    function onOverlay(e) {
      if (e.target === overlay) onCancel();
    }

    function onKey(e) {
      e.stopPropagation();
      if (e.key === 'Enter') onOk();
      if (e.key === 'Escape') onCancel();
    }

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('click', onOverlay);
    input.addEventListener('keydown', onKey);
  });
}

/* ---- Background + drawing ---- */

function drawBaseGrassLayer() {
  ctx.fillStyle = '#90af7b';
  ctx.fillRect(ORIGIN_X, ORIGIN_Y, VIEW_W * TILE, VIEW_H * TILE_H + ELEV);
}

function drawTile(wx, wy, highlight = false) {
  const { sx, sy } = worldToScreen(wx, wy);
  const p = screenToPx(sx, sy);

  const v = hash2(wx, wy);
  const topTone = 72 + Math.floor(v * 7);
  const sideTone = 58 + Math.floor(v * 6);

  const tex = textureForTile(wx, wy);
  if (tex.complete) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(p.x, p.y, TILE, TILE_H); // Squished tile height
    ctx.clip();
    ctx.globalAlpha = 0.92;
    ctx.drawImage(tex, p.x, p.y, TILE, TILE_H); // Draw texture squished
    ctx.restore();
  }

  // Top face of tile (squished)
  ctx.beginPath();
  ctx.moveTo(p.x, p.y);
  ctx.lineTo(p.x + TILE, p.y);
  ctx.lineTo(p.x + TILE, p.y + TILE_H);
  ctx.lineTo(p.x, p.y + TILE_H);
  ctx.closePath();
  ctx.fillStyle = highlight ? 'rgba(212, 232, 186, 0.50)' : `hsla(95, 34%, ${topTone}%, 0.28)`;
  ctx.fill();
  ctx.strokeStyle = '#6f8961';
  ctx.stroke();

  // Side face of tile (elevation edge)
  ctx.beginPath();
  ctx.moveTo(p.x, p.y + TILE_H);
  ctx.lineTo(p.x + TILE, p.y + TILE_H);
  ctx.lineTo(p.x + TILE, p.y + TILE_H + ELEV);
  ctx.lineTo(p.x, p.y + TILE_H + ELEV);
  ctx.closePath();
  ctx.fillStyle = `hsl(95, 26%, ${sideTone}%)`;
  ctx.fill();
}

function drawWall(wx, wy, obj) {
  const { sx, sy } = worldToScreen(wx, wy);
  const p = screenToPx(sx, sy);

  const hasReadyImage = obj.img && obj.img.complete;
  const usePlaceholder = obj.pending || !hasReadyImage;

  function drawWallSurface(y, h) {
    if (usePlaceholder) {
      // Temporary wall texture while generating: visible on both top and face.
      ctx.save();
      ctx.fillStyle = 'rgba(120, 120, 120, 0.55)';
      ctx.fillRect(p.x, y, TILE, h);
      ctx.strokeStyle = 'rgba(210, 210, 210, 0.35)';
      ctx.lineWidth = 1;
      for (let x = p.x + 8; x < p.x + TILE; x += 16) {
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - 8, y + h);
        ctx.stroke();
      }
      ctx.restore();
      return;
    }
    ctx.drawImage(obj.img, p.x, y, TILE, h);
  }

  // Draw wall top surface (squished), offset up by WALL_HEIGHT
  const wallTopY = p.y - WALL_HEIGHT;

  ctx.save();
  ctx.beginPath();
  ctx.rect(p.x, wallTopY, TILE, TILE_H);
  ctx.clip();
  drawWallSurface(wallTopY, TILE_H);
  ctx.restore();

  // Draw wall face (vertical side, not squished)
  const faceStartY = wallTopY + TILE_H; // bottom of wall top
  const faceEndY = p.y + TILE_H; // bottom of floor tile
  const faceHeight = faceEndY - faceStartY; // equals WALL_HEIGHT

  // Clip to not overlap southern tile
  const southernTileTopY = p.y + TILE_H;
  const clippedFaceEndY = Math.min(faceEndY, southernTileTopY);
  const clippedFaceHeight = clippedFaceEndY - faceStartY;

  if (clippedFaceHeight > 0) {
    ctx.save();

    // Set up clipping region
    ctx.beginPath();
    ctx.rect(p.x, faceStartY, TILE, clippedFaceHeight);
    ctx.clip();

    // Flip texture upside down
    ctx.translate(p.x, faceStartY + clippedFaceHeight);
    ctx.scale(1, -1);

    // Draw the texture (or placeholder) flipped
    if (usePlaceholder) {
      ctx.fillStyle = 'rgba(120, 120, 120, 0.55)';
      ctx.fillRect(0, 0, TILE, clippedFaceHeight);
      ctx.strokeStyle = 'rgba(210, 210, 210, 0.35)';
      ctx.lineWidth = 1;
      for (let x = 8; x < TILE; x += 16) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x - 8, clippedFaceHeight);
        ctx.stroke();
      }
    } else {
      ctx.drawImage(obj.img, 0, 0, TILE, clippedFaceHeight);
    }

    // Darken with overlay
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
    ctx.fillRect(0, 0, TILE, clippedFaceHeight);

    ctx.restore();
  }
}

function drawObject(wx, wy, obj) {
  // Handle walls specially
  if (obj.isWall) {
    drawWall(wx, wy, obj);
    return;
  }

  const { sx, sy } = worldToScreen(wx, wy);
  const p = screenToPx(sx, sy);
  const cx = p.x + TILE / 2;
  const cy = p.y + TILE_H * 0.35; // Position toward top to appear centered in 3D space
  const isEditPending = obj.pending && obj.pendingKind === 'edit';

  if (obj.pending && !isEditPending) {
    const elapsed = performance.now() - obj.pendingSince;
    const t = Math.log1p(elapsed / 550) / Math.log1p(12);
    const alpha = Math.min(0.2 + 0.75 * t, 0.95);
    const wobble = Math.sin(elapsed / 190) * 1.8;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#2c3931';
    ctx.shadowColor = '#101514';
    ctx.shadowBlur = 22;
    ctx.fillRect(cx - 40 + wobble, cy - 40, 80, 80);
    ctx.restore();
    return;
  }

  if (!obj.img || !obj.img.complete) return;
  const w = 144;
  const h = 144;

  if (isEditPending) {
    const elapsed = performance.now() - obj.pendingSince;
    const pulse = (Math.sin(elapsed / 190) + 1) / 2;
    const scale = 1 + pulse * 0.03;
    const dw = w * scale;
    const dh = h * scale;

    ctx.save();
    ctx.globalAlpha = 0.92 + pulse * 0.08;
    ctx.shadowColor = `rgba(255, 245, 170, ${0.35 + pulse * 0.4})`;
    ctx.shadowBlur = 10 + pulse * 18;
    ctx.drawImage(obj.img, cx - dw / 2, cy - dh / 2, dw, dh);

    // Soft light pass to make the object feel energized while updating.
    ctx.fillStyle = `rgba(255, 245, 180, ${0.06 + pulse * 0.09})`;
    ctx.fillRect(cx - dw / 2, cy - dh / 2, dw, dh);
    ctx.restore();
    return;
  }

  ctx.drawImage(obj.img, cx - w / 2, cy - h / 2, w, h);
}

function drawPlayer() {
  const { sx, sy } = worldToScreen(state.player.x, state.player.y);
  const p = screenToPx(sx, sy);
  const img = sprites[state.player.facing];
  if (!img.complete) return;
  const w = 136;
  const h = 136;
  ctx.drawImage(img, p.x + TILE / 2 - w / 2, p.y + TILE_H * 0.35 - h / 2, w, h);
}

function drawHotbar() {
  const slotW = 72;
  const slotH = 72;
  const gap = 8;
  const totalW = HOTBAR_SLOTS * slotW + (HOTBAR_SLOTS - 1) * gap;
  const x0 = Math.floor((canvas.width - totalW) / 2);
  const y0 = canvas.height - slotH - 10;

  ctx.save();
  ctx.fillStyle = 'rgba(20,20,20,0.45)';
  ctx.fillRect(x0 - 10, y0 - 10, totalW + 20, slotH + 20);

  for (let i = 0; i < HOTBAR_SLOTS; i += 1) {
    const x = x0 + i * (slotW + gap);
    const slot = state.wallHotbar[i];
    const selected = i === state.selectedWallSlot;

    ctx.fillStyle = selected ? 'rgba(255,245,180,0.30)' : 'rgba(0,0,0,0.35)';
    ctx.fillRect(x, y0, slotW, slotH);
    ctx.strokeStyle = selected ? '#fff1a5' : 'rgba(255,255,255,0.30)';
    ctx.lineWidth = selected ? 3 : 1;
    ctx.strokeRect(x, y0, slotW, slotH);

    if (slot) {
      if (slot.pending) {
        const pulse = (Math.sin(performance.now() / 220 + i) + 1) / 2;
        ctx.fillStyle = `rgba(170, 180, 190, ${0.25 + pulse * 0.3})`;
        ctx.fillRect(x + 8, y0 + 8, slotW - 16, slotH - 16);
      } else if (slot.img && slot.img.complete) {
        ctx.drawImage(slot.img, x + 5, y0 + 5, slotW - 10, slotH - 10);
      }
    }

    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.font = '14px "VT323", monospace';
    ctx.textAlign = 'left';
    ctx.fillText(String(i + 1), x + 4, y0 + 14);
  }

  ctx.restore();
}

/* ---- Interaction ---- */

async function interact() {
  if (state.modalOpen) return;

  const { x, y } = aheadPos();
  const key = tileKey(x, y);
  const existing = state.objects.get(key);

  if (!existing) {
    const userPrompt = await showPrompt('What should appear?', 'a donut with pink frosting');
    if (!userPrompt) return;
    const name = userPrompt.trim();
    if (!name) return;

    const opId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    state.objects.set(key, {
      name,
      isWall: false,
      pending: true,
      pendingKind: 'create',
      pendingSince: performance.now(),
      opId,
    });
    startOperationMessage(`Materializing ${name}`);

    try {
      const resp = await fetch('/api/generate-object', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, prompt: userPrompt, playerFacing: state.player.facing }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Failed to create object');

      const current = state.objects.get(key);
      if (!current || current.opId !== opId) {
        finishOperationMessage(`Created ${name}`);
        return;
      }

      state.objects.set(key, {
        name: data.name,
        imageUrl: data.imageUrl,
        objectKey: data.objectKey,
        orientation: data.orientation,
        isWall: false,
        img: loadImage(data.imageUrl),
        pending: false,
      });
      finishOperationMessage(`Created ${name}`);
    } catch (err) {
      const current = state.objects.get(key);
      if (current && current.opId === opId) {
        state.objects.delete(key);
      }
      finishOperationMessage(`Create failed: ${err.message}`);
    }
    return;
  }

  if (existing.pending) {
    const verb = existing.pendingKind === 'edit' ? 'updating' : 'materializing';
    setStatus(`${existing.name} is still ${verb}.`);
    return;
  }

  const interaction = await showPrompt(`What to do with ${existing.name}?`, 'give it sunglasses');
  if (!interaction) return;

  const opId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const old = { ...existing };
  state.objects.set(key, {
    ...existing,
    pending: true,
    pendingKind: 'edit',
    pendingSince: performance.now(),
    opId,
  });
  startOperationMessage(`Transforming ${existing.name}`);

  try {
    const resp = await fetch('/api/edit-object', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: existing.name,
        imageUrl: existing.imageUrl,
        interaction,
        playerFacing: state.player.facing,
      }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to edit object');

    const current = state.objects.get(key);
    if (!current || current.opId !== opId) {
      finishOperationMessage(`Updated ${existing.name}`);
      return;
    }

    state.objects.set(key, {
      name: data.name,
      imageUrl: data.imageUrl,
      objectKey: existing.objectKey || data.objectKey,
      orientation: existing.orientation || data.orientation,
      isWall: existing.isWall, // preserve wall flag
      img: loadImage(data.imageUrl),
      pending: false,
    });
    finishOperationMessage(`Updated ${data.name}`);
  } catch (err) {
    const current = state.objects.get(key);
    if (current && current.opId === opId) {
      state.objects.set(key, old);
    }
    finishOperationMessage(`Edit failed: ${err.message}`);
  }
}

async function deleteObjectAhead() {
  const { x, y } = aheadPos();
  const key = tileKey(x, y);
  const existing = state.objects.get(key);
  if (!existing) {
    setStatus('No object in front to delete.');
    return;
  }
  if (existing.pending) {
    setStatus(`${existing.name} is currently ${existing.pendingKind === 'edit' ? 'updating' : 'materializing'} and cannot be deleted yet.`);
    return;
  }
  const objectKey = existing.objectKey;
  const orientation = existing.orientation;
  const shouldUncache =
    objectKey &&
    orientation &&
    countInstancesOfVariant(objectKey, orientation, key) === 0;

  state.objects.delete(key);
  if (!shouldUncache) {
    setStatus(`Deleted ${existing.name}.`);
    return;
  }

  try {
    const resp = await fetch('/api/uncache-object-orientation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ objectKey, orientation }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.removed) {
      setStatus(`Deleted ${existing.name}. Cache cleanup skipped.`);
      return;
    }
    setStatus(`Deleted ${existing.name}. Uncached ${orientation} variant for redo.`);
  } catch {
    setStatus(`Deleted ${existing.name}. Cache cleanup failed.`);
  }
}

async function placeWall() {
  if (state.modalOpen) return;

  const { x, y } = aheadPos();
  const key = tileKey(x, y);
  const existing = state.objects.get(key);

  if (existing) {
    setStatus('Tile occupied. Cannot place wall.');
    return;
  }

  const slot = state.wallHotbar[state.selectedWallSlot];
  if (!slot || slot.pending || !slot.img) {
    setStatus(`Slot ${state.selectedWallSlot + 1} has no ready wall texture.`);
    return;
  }

  state.objects.set(key, {
    name: slot.name || `wall ${state.selectedWallSlot + 1}`,
    isWall: true,
    imageUrl: slot.imageUrl,
    wallSlot: state.selectedWallSlot,
    img: slot.img,
    pending: false,
  });
  setStatus(`Placed wall from slot ${state.selectedWallSlot + 1}.`);
}

async function generateWallTextureForSelectedSlot() {
  if (state.modalOpen) return;
  const slotIndex = state.selectedWallSlot;
  const prompt = await showPrompt(
    `Generate wall texture for slot ${slotIndex + 1}`,
    'dark mossy brick wall texture'
  );
  if (!prompt) return;

  state.wallHotbar[slotIndex] = {
    name: prompt.trim() || `wall ${slotIndex + 1}`,
    pending: true,
    pendingSince: performance.now(),
  };
  setStatus(`Generating wall texture for slot ${slotIndex + 1}...`);

  try {
    const resp = await fetch('/api/generate-wall-texture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to generate wall texture');

    state.wallHotbar[slotIndex] = {
      name: prompt.trim() || `wall ${slotIndex + 1}`,
      imageUrl: data.imageUrl,
      img: loadImage(data.imageUrl),
      pending: false,
    };
    setStatus(`Wall texture saved to slot ${slotIndex + 1}.`);
  } catch (err) {
    state.wallHotbar[slotIndex] = null;
    setStatus(`Wall texture generation failed: ${err.message}`);
  }
}

function setStatus(msg) {
  statusEl.textContent = msg;
}

/* ---- Input ---- */

function directionFromKey(key) {
  if (key === 'ArrowUp') return { facing: 'north', dx: 0, dy: -1 };
  if (key === 'ArrowDown') return { facing: 'south', dx: 0, dy: 1 };
  if (key === 'ArrowLeft') return { facing: 'west', dx: -1, dy: 0 };
  if (key === 'ArrowRight') return { facing: 'east', dx: 1, dy: 0 };
  return null;
}

window.addEventListener('keydown', (e) => {
  if (state.modalOpen) return;

  if (e.code === 'Space') {
    e.preventDefault();
    interact();
    return;
  }

  if (e.code === 'Backspace') {
    e.preventDefault();
    deleteObjectAhead();
    return;
  }

  if (e.key === 'g' || e.key === 'G') {
    e.preventDefault();
    generateWallTextureForSelectedSlot();
    return;
  }

  if (e.key === 'w' || e.key === 'W') {
    e.preventDefault();
    placeWall();
    return;
  }

  if (/^[1-9]$/.test(e.key)) {
    e.preventDefault();
    state.selectedWallSlot = Number(e.key) - 1;
    setStatus(`Selected wall slot ${e.key}.`);
    return;
  }

  const dir = directionFromKey(e.key);
  if (!dir) return;

  e.preventDefault();
  state.player.facing = dir.facing;

  if (e.shiftKey) {
    return;
  }

  const nx = state.player.x + dir.dx;
  const ny = state.player.y + dir.dy;

  if (state.objects.has(tileKey(nx, ny))) {
    return;
  }

  state.player.x = nx;
  state.player.y = ny;
  keepPlayerAwayFromEdge();
});

/* ---- Render loop ---- */

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  drawBaseGrassLayer();

  const target = aheadPos();

  for (let sy = 0; sy < VIEW_H; sy += 1) {
    for (let sx = 0; sx < VIEW_W; sx += 1) {
      const wx = state.camera.x + sx;
      const wy = state.camera.y + sy;
      drawTile(wx, wy, wx === target.x && wy === target.y);
    }
  }

  for (let sy = 0; sy < VIEW_H; sy += 1) {
    for (let sx = 0; sx < VIEW_W; sx += 1) {
      const wx = state.camera.x + sx;
      const wy = state.camera.y + sy;
      const obj = state.objects.get(tileKey(wx, wy));
      if (obj) drawObject(wx, wy, obj);
      if (state.player.x === wx && state.player.y === wy) drawPlayer();
    }
  }

  drawHotbar();

  requestAnimationFrame(render);
}

keepPlayerAwayFromEdge();
render();
setStatus('Ready.');
