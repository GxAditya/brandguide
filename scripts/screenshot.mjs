#!/usr/bin/env node
/**
 * Screenshots the rendered brand guide, set in each brand's own identity.
 *
 * Uses saved output from scripts/demo.mjs and drives headless Chrome over the
 * real render path, so what lands in docs/ is what a user sees.
 *
 *   node scripts/demo.mjs              # first, to produce demo-output/
 *   node scripts/screenshot.mjs
 *
 * Chrome is only needed for this script. The app itself has no dependencies.
 */

import { mkdir, copyFile, readdir, rm } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DEMO = join(ROOT, 'demo-output');
const STAGE = join(ROOT, 'public', '_samples');
const SHOTS = join(ROOT, 'docs', 'screenshots');

const PORT = Number(process.env.SCREENSHOT_PORT || 3222);
const CHROME = process.env.CHROME_BIN || 'google-chrome';

const VIEWPORTS = [
  // Desktop shoots the whole deck laid out as a contact sheet, so the
  // screenshot shows every page the guide contains rather than page one.
  // 1260 is the width the fixed 1200px canvas needs once the rail is off.
  { name: 'desktop', width: 1260, height: 21000, query: 'all=1&pages=24' },
  // Mobile shoots the live single-page viewer, which is what a phone shows.
  { name: 'mobile', width: 430, height: 2400, query: 'pages=14' },
];

async function main() {
  if (!(await exists(DEMO))) {
    process.stderr.write('\nNo demo-output/ yet. Run: node scripts/demo.mjs\n\n');
    process.exit(1);
  }

  await rm(STAGE, { recursive: true, force: true });
  await mkdir(STAGE, { recursive: true });
  await mkdir(SHOTS, { recursive: true });

  // Stage each saved guide somewhere the static server can reach it.
  const staged = [];
  for (const dir of await readdir(DEMO)) {
    const folder = join(DEMO, dir);
    if (!(await isDir(folder))) continue;
    const files = await readdir(folder);
    const guideFile = files.find((f) => f.endsWith('-brand-guide.json'));
    if (!guideFile) continue;

    const name = dir.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    await copyFile(join(folder, guideFile), join(STAGE, `${name}.json`));
    staged.push({ name, file: `/_samples/${name}.json`, title: basename(dir) });
  }

  if (!staged.length) {
    process.stderr.write('\nNo brand guides found in demo-output/.\n\n');
    process.exit(1);
  }

  const server = await startServer();
  process.stdout.write(`\nserver on http://localhost:${PORT}\n`);

  try {
    for (const target of staged) {
      for (const viewport of VIEWPORTS) {
        const out = join(SHOTS, `${target.name}-${viewport.name}.png`);
        await shoot({
          url: `http://localhost:${PORT}/_harness.html?file=${target.file}&${viewport.query}`,
          out,
          ...viewport,
        });
        process.stdout.write(`  ${target.title.padEnd(10)} ${viewport.name.padEnd(8)} → ${basename(out)}\n`);
      }
    }
  } finally {
    server.kill();
  }

  process.stdout.write(`\nScreenshots in docs/screenshots/\n\n`);
}

function shoot({ url, out, width, height }) {
  return new Promise((resolve, reject) => {
    const args = [
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      `--window-size=${width},${height}`,
      // Let the module fetch and render before the shot is taken.
      '--virtual-time-budget=10000',
      `--screenshot=${out}`,
      url,
    ];

    const child = spawn(CHROME, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`chrome exited ${code}: ${stderr.slice(-400)}`));
    });
    child.on('error', (err) => reject(new Error(`could not run ${CHROME}: ${err.message}`)));
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, 'src', 'server', 'index.js')], {
      env: { ...process.env, PORT: String(PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let ready = false;
    const timer = setTimeout(() => {
      if (!ready) reject(new Error('server did not start within 10s'));
    }, 10_000);

    child.stdout.on('data', (chunk) => {
      if (!ready && String(chunk).includes('http://localhost')) {
        ready = true;
        clearTimeout(timer);
        resolve(child);
      }
    });
    child.on('error', reject);
  });
}

async function exists(path) {
  try {
    await readdir(path);
    return true;
  } catch {
    return false;
  }
}

async function isDir(path) {
  const { stat } = await import('node:fs/promises');
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

main().catch((err) => {
  process.stderr.write(`\n${err.message}\n\n`);
  process.exit(1);
});