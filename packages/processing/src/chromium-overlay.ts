import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

export type ChromiumOverlayWord = {
  startSeconds: number;
  endSeconds: number;
  text: string;
};

export type ChromiumOverlayEvent = {
  startSeconds: number;
  endSeconds: number;
  text: string;
  words: ChromiumOverlayWord[];
};

export type ChromiumOverlayCard = {
  id: string;
  text: string;
  lines?: string[];
  startSeconds: number;
  endSeconds: number;
  color: string;
  shape: 'rounded' | 'pill';
  xPercent: number;
  yPercent: number;
  widthPercent: number;
  heightPercent: number;
  transitionSeconds: number;
  backgroundColor?: string;
  textColor?: string;
  border?: string;
  borderRadiusPx?: number;
  boxShadow?: string;
  fontFamily?: string;
  fontWeight?: number;
  fontSizePx?: number;
  lineHeight?: number;
  textAlign?: string;
  paddingPx?: { horizontal: number; vertical: number };
};

export type ChromiumOverlayNameTag = {
  id: string;
  name: string;
  title: string;
  startSeconds: number;
  endSeconds: number;
  color: string;
  xPercent: number;
  yPercent: number;
  widthPercent: number;
  heightPercent: number;
  transitionSeconds: number;
  backgroundColor?: string;
  textColor?: string;
  border?: string;
  borderRadiusPx?: number;
  boxShadow?: string;
  fontFamily?: string;
  fontWeight?: number;
  fontSizePx?: number;
};

export type ChromiumOverlayStyle = {
  fontFamily?: unknown;
  fontWeight?: unknown;
  fontSizePx?: unknown;
  lineHeight?: unknown;
  gapEm?: unknown;
  maxWidthPercent?: unknown;
  color?: unknown;
  activeColor?: unknown;
  backgroundColor?: unknown;
  borderRadiusPx?: unknown;
  paddingPx?: unknown;
  textAlign?: unknown;
  textShadow?: unknown;
};

export type ChromiumOverlayOptions = {
  ffmpegBinary: string;
  sourcePath: string;
  logoPath: string | null;
  outputPath: string;
  workDir: string;
  baseFilter: string;
  logoFilter: { x: string; y: string; height: number } | null;
  width: number;
  height: number;
  fps: number;
  startSeconds: number;
  duration: number;
  headlineCards: ChromiumOverlayCard[];
  nameTags: ChromiumOverlayNameTag[];
  captionEvents: ChromiumOverlayEvent[];
  captionPosition: { x: number; y: number };
  captionStyle: ChromiumOverlayStyle | undefined;
  fontPath: string | null;
  videoEncoder?: VideoEncoder;
  videoToolboxBitrate?: string;
  ffmpegPreset?: string;
  ffmpegCrf?: string;
};

export type VideoEncoder = 'libx264' | 'h264_videotoolbox';

export type ChromiumOverlayResult = {
  overlayMs: number;
  encodingMs: number;
  encoder: VideoEncoder;
};

const colorFallbacks: Record<string, { background: string; text: string }> = {
  navy: { background: '#17243b', text: '#ffffff' },
  black: { background: '#101010', text: '#ffffff' },
  purple: { background: '#5646c8', text: '#ffffff' },
  blue: { background: '#2768b5', text: '#ffffff' },
  green: { background: '#2e7d66', text: '#ffffff' },
  red: { background: '#b44a45', text: '#ffffff' },
  white: { background: '#ffffff', text: '#101624' },
};

export function findChromiumExecutable(env: NodeJS.ProcessEnv = process.env) {
  const candidates = [
    env.CHROMIUM_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/opt/homebrew/bin/chromium',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
  ].filter((value): value is string => Boolean(value));
  return candidates.find((value) => {
    try {
      return Boolean(value) && existsSync(value);
    } catch {
      return false;
    }
  }) ?? null;
}

export async function renderWithChromiumOverlay(options: ChromiumOverlayOptions): Promise<ChromiumOverlayResult> {
  const executablePath = findChromiumExecutable();
  if (!executablePath) throw new Error('Chromium renderer requested, but no Chrome/Chromium executable was found; set CHROMIUM_BIN');
  if (options.duration <= 0) throw new Error('Chromium overlay duration must be positive');

  const startedAt = nowMs();
  const htmlPath = join(options.workDir, 'editor-overlay.html');
  await writeFile(htmlPath, buildOverlayHtml(options), 'utf8');

  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--allow-file-access-from-files', '--disable-background-networking', '--disable-dev-shm-usage'],
  });
  let ffmpeg: ReturnType<typeof spawn> | null = null;
  try {
    const page = await browser.newPage({ viewport: { width: options.width, height: options.height }, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);

    const duration = options.duration;
    const frames = Math.max(1, Math.ceil(duration * options.fps));
    const ffmpegArgs = [
      '-y',
      '-ss', options.startSeconds.toFixed(3),
      '-i', options.sourcePath,
      '-f', 'image2pipe',
      '-vcodec', 'png',
      '-framerate', String(options.fps),
      '-i', 'pipe:0',
    ];
    if (options.logoPath && options.logoFilter) ffmpegArgs.push('-loop', '1', '-i', options.logoPath);
    const cssInput = '[1:v]format=rgba[css]';
    const base = `[0:v]${options.baseFilter}[base]`;
    const composite = '[base][css]overlay=0:0:format=auto[with_css]';
    const logo = options.logoPath && options.logoFilter
      ? `;[2:v]scale=-1:${options.logoFilter.height}[logo];[with_css][logo]overlay=${options.logoFilter.x}:${options.logoFilter.y}:format=auto[v]`
      : ';[with_css]null[v]';
    ffmpegArgs.push(
      '-filter_complex', `${base};${cssInput};${composite}${logo}`,
      '-map', '[v]',
      '-map', '0:a?',
      '-t', duration.toFixed(3),
      '-r', String(options.fps),
      ...videoEncoderArgs(options.videoEncoder ?? 'libx264', options.ffmpegPreset, options.ffmpegCrf, options.videoToolboxBitrate),
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11',
      '-movflags', '+faststart',
      options.outputPath,
    );

    ffmpeg = spawn(options.ffmpegBinary, ffmpegArgs, { stdio: ['pipe', 'ignore', 'pipe'] });
    const encodingStartedAt = nowMs();
    let stderr = '';
    ffmpeg.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const ffmpegDone = new Promise<void>((resolve, reject) => {
      ffmpeg?.once('error', reject);
      ffmpeg?.once('close', (code) => code === 0 ? resolve() : reject(new Error(`${options.ffmpegBinary} exited with ${code}: ${stderr.trim()}`)));
    });

    for (let frame = 0; frame < frames; frame += 1) {
      const time = Math.min(duration - 0.0001, frame / options.fps);
      await page.evaluate((currentTime) => {
        (window as unknown as Window & { setRenderTime: (value: number) => void }).setRenderTime(currentTime);
      }, time);
      const png = await page.screenshot({ type: 'png', omitBackground: true });
      const stdin = ffmpeg.stdin;
      if (!stdin) throw new Error('FFmpeg overlay input pipe was not available');
      if (!stdin.write(png)) await once(stdin, 'drain');
    }
    ffmpeg.stdin?.end();
    const overlayFinishedAt = nowMs();
    await ffmpegDone;
    return {
      overlayMs: Math.max(0, overlayFinishedAt - startedAt),
      encodingMs: Math.max(0, nowMs() - encodingStartedAt),
      encoder: options.videoEncoder ?? 'libx264',
    };
  } finally {
    if (ffmpeg && !ffmpeg.killed) ffmpeg.kill('SIGTERM');
    await browser.close();
    await rm(htmlPath, { force: true });
  }
}

export function videoEncoderArgs(encoder: VideoEncoder, preset = 'veryfast', crf = '20', videoToolboxBitrate = '8M') {
  return encoder === 'h264_videotoolbox'
    ? ['-c:v', 'h264_videotoolbox', '-b:v', videoToolboxBitrate, '-maxrate', videoToolboxBitrate, '-bufsize', videoToolboxBitrate]
    : ['-c:v', 'libx264', '-preset', preset, '-crf', crf];
}

function nowMs() {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

export function buildOverlayHtml(options: ChromiumOverlayOptions) {
  const fontUrl = options.fontPath ? pathToFileURL(options.fontPath).href : null;
  const payload = JSON.stringify({
    width: options.width,
    height: options.height,
    duration: options.duration,
    fontUrl,
    cards: options.headlineCards,
    nameTags: options.nameTags,
    captionEvents: options.captionEvents,
    captionPosition: options.captionPosition,
    captionStyle: options.captionStyle ?? {},
  }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
@font-face { font-family: "NB International Pro"; src: url("${fontUrl ?? ''}") format("truetype"); font-weight: 700; }
html, body { margin: 0; width: ${options.width}px; height: ${options.height}px; overflow: hidden; background: transparent; }
#canvas { position: relative; width: ${options.width}px; height: ${options.height}px; overflow: hidden; background: transparent; font-family: "NB International Pro", Arial, sans-serif; }
.headline-card, .name-tag { position: absolute; box-sizing: border-box; display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; overflow: hidden; }
.headline-card { z-index: 3; }
.name-tag { z-index: 4; align-items: flex-start; text-align: left; overflow: hidden; }
.headline-card-content { width: 100%; height: 100%; box-sizing: border-box; display: flex; flex-direction: column; justify-content: center; align-items: center; overflow: hidden; border-radius: inherit; }
.headline-line { display: block; width: 100%; white-space: nowrap; overflow: hidden; }
.caption-layer { position: absolute; z-index: 2; transform: translate(-50%, -50%); box-sizing: border-box; display: flex; flex-direction: column; align-items: center; text-align: center; pointer-events: none; }
.caption-line { display: flex; flex-wrap: wrap; justify-content: center; width: 100%; max-width: 100%; gap: .32em; white-space: normal; }
.caption-word { display: inline-block; max-width: 100%; overflow-wrap: anywhere; }
</style></head><body><main id="canvas"><section id="captions" class="caption-layer"></section><section id="headlines"></section><section id="name-tags"></section></main>
<script>
const data = ${payload};
const canvas = document.getElementById('canvas');
const headlines = document.getElementById('headlines');
const nameTags = document.getElementById('name-tags');
const captions = document.getElementById('captions');
const clamp = (value, fallback, min, max) => Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Number(value))) : fallback;
const safeCss = (value, fallback) => typeof value === 'string' && !/[;{}<>]/.test(value) && value.trim() ? value.trim() : fallback;
const colorForName = (name, key) => ((${JSON.stringify(colorFallbacks)})[name] || { background: '#17243b', text: '#ffffff' })[key];
const transition = (time, start, end, seconds, entrance) => {
  const duration = Math.max(0.05, Math.min(Number(seconds) || 0.35, (end - start) / 2));
  const exit = Math.max(0, Math.min(1, (end - time) / duration));
  const enter = entrance ? Math.max(0, Math.min(1, (time - start) / duration)) : 1;
  const linear = Math.min(enter, exit);
  return linear * linear * (3 - 2 * linear);
};
const setBoxStyle = (node, item, style) => {
  const geometry = item.geometryPercent || item;
  node.style.left = clamp(geometry.x ?? geometry.xPercent, 50, 0, 100) + '%';
  node.style.top = clamp(geometry.y ?? geometry.yPercent, 70, 0, 100) + '%';
  node.style.width = clamp(geometry.width ?? geometry.widthPercent, 84, 1, 100) + '%';
  node.style.height = clamp(geometry.height ?? geometry.heightPercent, 21, 1, 100) + '%';
  node.style.background = safeCss(style.backgroundColor, colorForName(item.color, 'background'));
  node.style.color = safeCss(style.textColor, colorForName(item.color, 'text'));
  node.style.border = safeCss(style.border, 'none');
  node.style.borderRadius = Math.max(0, Number(style.borderRadiusPx) || 0) + 'px';
  node.style.boxShadow = safeCss(style.boxShadow, 'none');
  node.style.fontFamily = safeCss(style.fontFamily, 'NB International Pro, Arial, sans-serif');
  node.style.fontWeight = String(clamp(style.fontWeight, 700, 100, 900));
  node.style.fontSize = Math.max(5, Number(style.fontSizePx) || 22) + 'px';
  node.style.lineHeight = String(Math.max(0.8, Number(style.lineHeight) || 1.1));
  const padding = style.paddingPx && typeof style.paddingPx === 'object' ? style.paddingPx : {};
  node.style.padding = (Number(padding.vertical) || 0) + 'px ' + (Number(padding.horizontal) || 0) + 'px';
  node.style.textAlign = safeCss(style.textAlign, 'center');
  node.style.transformOrigin = 'center center';
};
const updateBox = (node, item, entrance) => {
  const progress = transition(window.renderTime, Number(item.startSeconds), Number(item.endSeconds), Number(item.transitionSeconds), entrance);
  node.style.opacity = String(progress);
  node.style.transform = 'translate(-50%, -50%) scale(' + (0.86 + 0.14 * progress) + ')';
  node.hidden = window.renderTime < Number(item.startSeconds) || window.renderTime > Number(item.endSeconds);
};
const fitHeadlineFont = (node, style) => {
  const content = node.querySelector('.headline-card-content');
  if (!content) return;
  const saved = Number(style.fontSizePx);
  const maximum = Math.min(160, Math.max(Number.isFinite(saved) && saved > 0 ? saved : 160, 5));
  const fits = () => content.scrollWidth <= content.clientWidth + 1 && content.scrollHeight <= content.clientHeight + 1;
  let low = 5;
  let high = Math.floor(maximum);
  let best = low;
  while (low <= high) {
    const candidate = Math.floor((low + high) / 2);
    node.style.fontSize = candidate + 'px';
    if (fits()) {
      best = candidate;
      low = candidate + 1;
    } else {
      high = candidate - 1;
    }
  }
  node.style.fontSize = best + 'px';
};
const cardEntries = data.cards.map((item) => {
    const style = { ...item, ...(item.style || {}) };
    const node = document.createElement('article'); node.className = 'headline-card';
    setBoxStyle(node, item, style);
    const lines = Array.isArray(item.lines) && item.lines.length ? item.lines : [item.text];
    const content = document.createElement('div'); content.className = 'headline-card-content';
    lines.forEach((line) => { const span = document.createElement('span'); span.className = 'headline-line'; span.textContent = line; content.appendChild(span); });
    node.appendChild(content);
    headlines.appendChild(node);
    node.hidden = false;
    // The editor's render spec already contains measured lines and the exact
    // output-pixel font size. Preserve those values for editor/render parity;
    // only legacy social-copy cards need the renderer's fallback fitting.
    if (!(Array.isArray(item.lines) && item.lines.length && Number.isFinite(Number(style.fontSizePx)) && Number(style.fontSizePx) > 0)) {
      fitHeadlineFont(node, style);
    }
    return { item, node };
  });
const nameTagEntries = data.nameTags.map((item) => {
    const style = { ...item, ...(item.style || {}) };
    const node = document.createElement('article'); node.className = 'name-tag';
    setBoxStyle(node, item, style);
    const name = document.createElement('strong'); name.textContent = item.name || 'Name';
    const title = document.createElement('span'); title.textContent = item.title || 'Title';
    node.append(name, title); nameTags.appendChild(node);
    return { item, node };
  });
const style = data.captionStyle || {};
  captions.style.left = clamp(data.captionPosition.x, 50, 0, 100) + '%';
  captions.style.top = clamp(data.captionPosition.y, 84, 0, 100) + '%';
  // A max-width alone leaves a shrink-to-fit flex box whose nowrap children can
  // paint beyond the video. Give the caption layer the editor's exact resolved
  // width and allow a word-boundary safety wrap for legacy/stale line layouts.
  captions.style.width = clamp(style.maxWidthPercent, 84, 1, 100) + '%';
  captions.style.maxWidth = 'none';
  captions.style.fontFamily = safeCss(style.fontFamily, 'NB International Pro, Arial, sans-serif');
  captions.style.fontWeight = String(clamp(style.fontWeight, 700, 100, 900));
  captions.style.fontSize = Math.max(5, Number(style.fontSizePx) || 22) + 'px';
  captions.style.lineHeight = String(Math.max(0.8, Number(style.lineHeight) || 1.18));
  captions.style.textShadow = safeCss(style.textShadow, 'none');
  captions.style.color = safeCss(style.color, '#ffffff');
  captions.style.gap = Math.max(0, Number(style.gapEm) || 0.32) + 'em';
const captionEntries = data.captionEvents.map((event) => {
    const line = document.createElement('div'); line.className = 'caption-line';
    line.style.gap = Math.max(0, Number(style.gapEm) || 0.32) + 'em';
    const words = event.words.map((word) => {
      const span = document.createElement('span'); span.className = 'caption-word'; span.textContent = word.text;
      line.appendChild(span);
      return { word, span };
    });
    captions.appendChild(line);
    return { event, line, words };
  });
const render = () => {
  const time = window.renderTime;
  cardEntries.forEach(({ item, node }) => updateBox(node, item, false));
  nameTagEntries.forEach(({ item, node }) => updateBox(node, item, true));
  captionEntries.forEach(({ event, line, words }) => {
    line.hidden = !(time >= event.startSeconds && time <= event.endSeconds);
    words.forEach(({ word, span }) => {
      span.style.color = time >= word.startSeconds && time < word.endSeconds ? safeCss(style.activeColor, '#3b6be3') : safeCss(style.color, '#ffffff');
    });
  });
};
window.renderTime = 0;
window.setRenderTime = (time) => { window.renderTime = time; render(); };
render();
</script></body></html>`;
}
