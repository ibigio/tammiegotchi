const express = require('express');
const path = require('path');
const { promisify } = require('util');
const { execFile } = require('child_process');
const fs = require('fs');
require('dotenv').config();

const execFileAsync = promisify(execFile);
const app = express();

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const GENERATED_DIR = path.join(PUBLIC_DIR, 'generated');
const CACHE_FILE = path.join(ROOT, 'object-image-cache.json');
const MASTER_WALL_TEXTURE = path.join(PUBLIC_DIR, 'assets', 'wall_bricks.png');
const PYTHON_SCRIPT = path.join(ROOT, 'nanobanana_generate.py');
const PYTHON_BIN = fs.existsSync(path.join(ROOT, '.venv', 'bin', 'python'))
  ? path.join(ROOT, '.venv', 'bin', 'python')
  : 'python3';
const EXPERIMENT_GREEN_MATTE = '7FBF5B';
const EXPERIMENT_GREEN_THRESHOLD = 26;
let objectImageCache = {};

app.use(express.json({ limit: '2mb' }));
app.use(express.static(PUBLIC_DIR));
fs.mkdirSync(GENERATED_DIR, { recursive: true });

function normalizeFacing(facing) {
  if (facing === 'north' || facing === 'south' || facing === 'east' || facing === 'west') {
    return facing;
  }
  return 'south';
}

function normalizeObjectKey(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function oppositeFacing(facing) {
  const f = normalizeFacing(facing);
  if (f === 'north') return 'south';
  if (f === 'south') return 'north';
  if (f === 'east') return 'west';
  return 'east';
}

function orientationPhraseFromFacing(facing) {
  const f = normalizeFacing(facing);
  if (f === 'east') return 'as viewed from the side. (orientation: facing right)';
  if (f === 'west') return 'as viewed from the side. (orientation: facing left)';
  if (f === 'north') return 'as viewed from behind. (orientation: facing away)';
  return 'as viewed from in front. (orientation: facing toward viewer)';
}

function spritePrompt(userPrompt, objectFacing, referenceInstruction) {
  const orientationClause = orientationPhraseFromFacing(objectFacing);
  const facing = normalizeFacing(objectFacing);
  return (
    `Create a ${userPrompt}, ${orientationClause} ` +
    'Sprite art style, top-down 2.5D game asset, crisp readable silhouette, centered subject. ' +
    `This will be a video game asset facing ${facing}. ` +
    `${referenceInstruction} DO NOT INCLUDE THE REFERENCE IMAGE. ` +
    `Orientation: ${orientationClause}. ` +
    'Show the full object, fully visible, and make it take up most of the frame.'
  );
}

function reorientPromptFromExisting(objectName, objectFacing) {
  const f = normalizeFacing(objectFacing);
  if (f === 'east') {
    return (
      `Reorient this same ${objectName} to face right only. ` +
      'Keep the exact same object identity, design, colors, and scale. ' +
      'Do not redesign or add new features. ' +
      'This will be a video game asset facing east.'
    );
  }
  if (f === 'west') {
    return (
      `Reorient this same ${objectName} to face left only. ` +
      'Keep the exact same object identity, design, colors, and scale. ' +
      'Do not redesign or add new features. ' +
      'This will be a video game asset facing west.'
    );
  }
  if (f === 'north') {
    return (
      `Show this same ${objectName} from the back only. ` +
      'Keep the exact same object identity, design, colors, and scale. ' +
      'Do not redesign or add new features. ' +
      'This will be a video game asset facing north.'
    );
  }
  return (
    `Show this same ${objectName} from the front only. ` +
    'Keep the exact same object identity, design, colors, and scale. ' +
    'Do not redesign or add new features. ' +
    'This will be a video game asset facing south.'
  );
}

function raccoonRefPathFromFacing(facing) {
  const f = normalizeFacing(facing);
  return path.join(PUBLIC_DIR, 'assets', `raccoon_${f}.png`);
}

function outputFileAbsolute() {
  const file = `obj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`;
  return {
    abs: path.join(GENERATED_DIR, file),
    url: `/generated/${file}`,
  };
}

function absFromImageUrl(imageUrl) {
  return path.join(PUBLIC_DIR, imageUrl);
}

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      objectImageCache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    } else {
      objectImageCache = {};
    }
  } catch {
    objectImageCache = {};
  }
}

function saveCache() {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(objectImageCache, null, 2));
}

function getCachedVariant(objectKey, facing) {
  const obj = objectImageCache[objectKey];
  if (!obj) return null;
  const variant = obj[facing];
  if (!variant || !variant.imageUrl) return null;
  const abs = absFromImageUrl(variant.imageUrl);
  if (!fs.existsSync(abs)) return null;
  return { imageUrl: variant.imageUrl, abs };
}

function rememberVariant(objectKey, facing, imageUrl) {
  if (!objectImageCache[objectKey]) {
    objectImageCache[objectKey] = {};
  }
  objectImageCache[objectKey][facing] = { imageUrl, updatedAt: Date.now() };
  saveCache();
}

function removeVariant(objectKey, facing) {
  const obj = objectImageCache[objectKey];
  if (!obj || !obj[facing]) {
    return false;
  }
  delete obj[facing];
  if (Object.keys(obj).length === 0) {
    delete objectImageCache[objectKey];
  }
  saveCache();
  return true;
}

function anyCachedVariant(objectKey) {
  const obj = objectImageCache[objectKey];
  if (!obj) return null;
  for (const facing of ['south', 'east', 'west', 'north']) {
    const hit = getCachedVariant(objectKey, facing);
    if (hit) return { facing, ...hit };
  }
  return null;
}

function assertSafeGeneratedPath(imageUrl) {
  if (!imageUrl || typeof imageUrl !== 'string') {
    throw new Error('imageUrl is required');
  }
  if (!imageUrl.startsWith('/generated/')) {
    throw new Error('Only /generated images can be edited');
  }
  const abs = path.join(PUBLIC_DIR, imageUrl);
  const norm = path.normalize(abs);
  const genNorm = path.normalize(GENERATED_DIR + path.sep);
  if (!norm.startsWith(genNorm)) {
    throw new Error('Invalid image path');
  }
  return norm;
}

async function runGenerator({
  prompt,
  outputAbs,
  editAbs,
  refAbsList,
  whiteKey,
  floodFillThreshold,
  removeBg = true,
}) {
  fs.mkdirSync(path.dirname(outputAbs), { recursive: true });
  const args = [PYTHON_SCRIPT, prompt, '-o', outputAbs];
  if (editAbs) {
    args.push('--edit', editAbs);
  }
  if (Array.isArray(refAbsList)) {
    for (const refAbs of refAbsList) {
      args.push('--ref', refAbs);
    }
  }
  if (removeBg) {
    // Always use flood-fill in app flows so interior whites are preserved.
    args.push('--bg-remove-mode', 'flood-fill');
    if (whiteKey) {
      args.push('--white-key', whiteKey);
    }
    if (typeof floodFillThreshold === 'number') {
      args.push('--flood-fill-threshold', String(floodFillThreshold));
    }
  } else {
    args.push('--no-remove-white-bg');
  }

  const env = { ...process.env };
  if (!env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured in environment/.env');
  }

  try {
    const { stdout, stderr } = await execFileAsync(PYTHON_BIN, args, {
      cwd: ROOT,
      env,
      timeout: 180000,
      maxBuffer: 1024 * 1024,
    });
    return { stdout, stderr };
  } catch (err) {
    const detail = err.stderr || err.stdout || err.message;
    throw new Error(`Generator failed: ${detail}`);
  }
}

async function handleGenerateObject(req, res, opts = {}) {
  const { name, prompt, playerFacing } = req.body || {};
  if (!name || !prompt) {
    return res.status(400).json({ error: 'name and prompt are required' });
  }

  const objectFacing = oppositeFacing(playerFacing);
  const objectKey = normalizeObjectKey(prompt);

  // Cache hit: same object + same orientation.
  const exact = getCachedVariant(objectKey, objectFacing);
  if (exact) {
    return res.json({
      name,
      imageUrl: exact.imageUrl,
      cached: true,
      objectKey,
      orientation: objectFacing,
    });
  }

  // Cache hit: same object, different orientation -> reorient from existing.
  const existingAny = anyCachedVariant(objectKey);
  if (existingAny) {
    const out = outputFileAbsolute();
    try {
      await runGenerator({
        prompt: reorientPromptFromExisting(name, objectFacing),
        outputAbs: out.abs,
        editAbs: existingAny.abs,
        whiteKey: opts.whiteKey,
        floodFillThreshold: opts.floodFillThreshold,
      });
      rememberVariant(objectKey, objectFacing, out.url);
      return res.json({
        name,
        imageUrl: out.url,
        cached: false,
        objectKey,
        orientation: objectFacing,
        reorientedFrom: existingAny.facing,
      });
    } catch (err) {
      return res.status(500).json({ error: String(err.message || err) });
    }
  }

  const raccoonRefAbs = raccoonRefPathFromFacing(objectFacing);
  const out = outputFileAbsolute();
  try {
    await runGenerator({
      prompt: spritePrompt(
        prompt,
        objectFacing,
        'Use the provided raccoon reference image for style and orientation guidance.'
      ),
      outputAbs: out.abs,
      refAbsList: [raccoonRefAbs],
      whiteKey: opts.whiteKey,
      floodFillThreshold: opts.floodFillThreshold,
    });
    rememberVariant(objectKey, objectFacing, out.url);
    return res.json({
      name,
      imageUrl: out.url,
      cached: false,
      objectKey,
      orientation: objectFacing,
    });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
}

async function handleEditObject(req, res, opts = {}) {
  const { name, imageUrl, interaction, playerFacing } = req.body || {};
  if (!name || !imageUrl || !interaction) {
    return res.status(400).json({ error: 'name, imageUrl, and interaction are required' });
  }

  let inputAbs;
  try {
    inputAbs = assertSafeGeneratedPath(imageUrl);
  } catch (err) {
    return res.status(400).json({ error: String(err.message || err) });
  }

  const out = outputFileAbsolute();
  const prompt =
    'Sprite art style, top-down 2.5D game asset, crisp readable silhouette, centered subject. ' +
    'Use the provided object reference image for style guidance. ' +
    'Show the full object, fully visible, and make it take up most of the frame. ' +
    `Make changes to this image as a result of this interaction: ${interaction}. ` +
    'Preserve overall sprite readability and keep transparent-ready edges.';

  try {
    await runGenerator({
      prompt,
      outputAbs: out.abs,
      editAbs: inputAbs,
      whiteKey: opts.whiteKey,
      floodFillThreshold: opts.floodFillThreshold,
    });
    return res.json({ name, imageUrl: out.url });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
}

app.post('/api/generate-object', async (req, res) => handleGenerateObject(req, res));

app.post('/api/edit-object', async (req, res) => handleEditObject(req, res));

// Experimental path: ask model for a green matte and remove that color via flood-fill.
app.post('/api/generate-object-experimental-green', async (req, res) =>
  handleGenerateObject(req, res, {
    whiteKey: EXPERIMENT_GREEN_MATTE,
    floodFillThreshold: EXPERIMENT_GREEN_THRESHOLD,
  })
);

app.post('/api/edit-object-experimental-green', async (req, res) =>
  handleEditObject(req, res, {
    whiteKey: EXPERIMENT_GREEN_MATTE,
    floodFillThreshold: EXPERIMENT_GREEN_THRESHOLD,
  })
);

app.post('/api/generate-wall-texture', async (req, res) => {
  const { prompt } = req.body || {};
  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'prompt is required' });
  }
  if (!fs.existsSync(MASTER_WALL_TEXTURE)) {
    return res.status(500).json({ error: 'Master wall texture is missing on server' });
  }

  const out = outputFileAbsolute();
  const wallPrompt =
    `Create a tileable wall texture: ${prompt}. ` +
    'Use the provided master wall texture as style reference only. ' +
    'Do not include the reference image itself. ' +
    'No orientation instructions. ' +
    'Make it bright. ' +
    'Zoom in so texture elements are large and readable. ' +
    'Use low object count / low detail density. ' +
    'Keep it seamless and suitable for repeating game wall tiles.';

  try {
    await runGenerator({
      prompt: wallPrompt,
      outputAbs: out.abs,
      refAbsList: [MASTER_WALL_TEXTURE],
      removeBg: false,
    });
    return res.json({ imageUrl: out.url });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/api/uncache-object-orientation', (req, res) => {
  const { objectKey, orientation } = req.body || {};
  if (!objectKey || !orientation) {
    return res.status(400).json({ error: 'objectKey and orientation are required' });
  }
  const removed = removeVariant(normalizeObjectKey(objectKey), normalizeFacing(orientation));
  return res.json({ removed });
});

app.get('/healthz', (_req, res) => {
  res.status(200).json({ ok: true });
});

loadCache();

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
