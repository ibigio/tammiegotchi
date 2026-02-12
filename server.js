const express = require('express');
const path = require('path');
const { promisify } = require('util');
const { execFile } = require('child_process');
require('dotenv').config();

const execFileAsync = promisify(execFile);
const app = express();

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const GENERATED_DIR = path.join(PUBLIC_DIR, 'generated');
const PYTHON_SCRIPT = path.join(ROOT, 'nanobanana_generate.py');

app.use(express.json({ limit: '2mb' }));
app.use(express.static(PUBLIC_DIR));

function normalizeFacing(facing) {
  if (facing === 'north' || facing === 'south' || facing === 'east' || facing === 'west') {
    return facing;
  }
  return 'south';
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
  if (f === 'east') return 'as viewed from the side, and slightly from above, facing right';
  if (f === 'west') return 'as viewed from the side, and slightly from above, facing left';
  if (f === 'north') return 'as viewed from behind, slightly from above';
  return 'as viewed from in front, slightly from above';
}

function spritePrompt(userPrompt, objectFacing) {
  const orientation = orientationPhraseFromFacing(objectFacing);
  return (
    'Sprite art style, top-down 2.5D game asset, crisp readable silhouette, centered subject. ' +
    `${orientation}. Show the full object, fully visible, and make it take up most of the frame. ` +
    userPrompt
  );
}

function outputFileAbsolute() {
  const file = `obj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`;
  return {
    abs: path.join(GENERATED_DIR, file),
    url: `/generated/${file}`,
  };
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

async function runGenerator({ prompt, outputAbs, editAbs }) {
  const args = [PYTHON_SCRIPT, prompt, '-o', outputAbs];
  if (editAbs) {
    args.push('--edit', editAbs);
  }

  const env = { ...process.env };
  if (!env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured in environment/.env');
  }

  try {
    const { stdout, stderr } = await execFileAsync('python3', args, {
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

app.post('/api/generate-object', async (req, res) => {
  const { name, prompt, playerFacing } = req.body || {};
  if (!name || !prompt) {
    return res.status(400).json({ error: 'name and prompt are required' });
  }

  const objectFacing = oppositeFacing(playerFacing);
  const out = outputFileAbsolute();
  try {
    await runGenerator({
      prompt: spritePrompt(prompt, objectFacing),
      outputAbs: out.abs,
    });
    return res.json({ name, imageUrl: out.url });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/api/edit-object', async (req, res) => {
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
  const objectFacing = oppositeFacing(playerFacing);
  const prompt = spritePrompt(
    `Make changes to this image as a result of this interaction: ${interaction}. Preserve overall sprite readability and keep transparent-ready edges.`,
    objectFacing
  );

  try {
    await runGenerator({
      prompt,
      outputAbs: out.abs,
      editAbs: inputAbs,
    });
    return res.json({ name, imageUrl: out.url });
  } catch (err) {
    return res.status(500).json({ error: String(err.message || err) });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
