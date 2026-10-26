/**
 * みんなのMuse — 撮影（地図の静止画・動画キャプチャ）
 * ============================================================
 * 地図（Leaflet コンテナ）を CDN の html-to-image で画像化する。
 *   静止画: toCanvas → PNG Blob
 *   動画  : 静止画フレームを短い間隔で合成キャンバスへ描き続け、
 *           canvas.captureStream + MediaRecorder で webm 化する
 * OSM タイルは CORS ヘッダ（Access-Control-Allow-Origin: *）を返すため
 * canvas 汚染は起きない想定だが、外部アバター等で画像化に失敗した場合は
 * 例外を投げるので、呼び出し側で「撮影モードのまま端末のスクショ／画面収録を
 * 使ってください」というフォールバック案内を出すこと。
 * data.js（MinnaData）には依存しない。
 */

export const SITE_URL = "https://muse.solo-guild.xyz";

/* 撮影結果のシェア文（kind: "photo" | "video"） */
export function buildShotShareText(kind) {
  if (kind === "video") {
    return `「みんなのMuse」の地図で、Museたちがお散歩中🚶 動画を撮ってみました🎬\n` +
      `${SITE_URL}\n#みんなのMuse`;
  }
  return `「みんなのMuse」の地図で、Museたちがお散歩中🚶 写真を撮ってみました📸\n` +
    `${SITE_URL}\n#みんなのMuse`;
}

/* 動画キャプチャ対応可否（canvas.captureStream と MediaRecorder の両方が必要）。
 * 非対応環境では呼び出し側が動画ボタンを出さず、撮影モード＋OSの画面収録を案内する。 */
export function supportsVideoCapture() {
  return typeof window !== "undefined"
    && typeof HTMLCanvasElement !== "undefined"
    && typeof HTMLCanvasElement.prototype.captureStream === "function"
    && typeof window.MediaRecorder === "function";
}

/* ================= html-to-image の遅延ロード ================= */
const H2I_SRC = "https://cdn.jsdelivr.net/npm/html-to-image@1.11.13/dist/html-to-image.js";
let h2iPromise = null;

export function loadHtmlToImage() {
  if (typeof window !== "undefined" && window.htmlToImage) {
    return Promise.resolve(window.htmlToImage);
  }
  if (h2iPromise) return h2iPromise;
  h2iPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = H2I_SRC;
    s.onload = () => {
      if (window.htmlToImage) resolve(window.htmlToImage);
      else reject(new Error("html-to-image の読み込みに失敗しました"));
    };
    s.onerror = () => reject(new Error("html-to-image の読み込みに失敗しました"));
    document.head.appendChild(s);
  });
  /* 失敗した場合は次回再試行できるようキャッシュを外す */
  h2iPromise.catch(() => { h2iPromise = null; });
  return h2iPromise;
}

/* 地図要素を Canvas に画像化する。pixelRatio 省略時は端末比（最大2）。 */
export async function captureMapCanvas(el, pixelRatio) {
  const h2i = await loadHtmlToImage();
  const pr = pixelRatio
    ?? Math.min(2, (typeof window !== "undefined" && window.devicePixelRatio) || 1);
  return h2i.toCanvas(el, { pixelRatio: pr, cacheBust: true });
}

function canvasToBlob(canvas, type) {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob(b => (b ? resolve(b) : reject(new Error("toBlob failed"))), type);
    } catch (e) {
      reject(e);
    }
  });
}

/* 静止画キャプチャ: 地図の現在の表示を PNG Blob にする。失敗時は例外。 */
export async function captureMapPhoto(el) {
  const canvas = await captureMapCanvas(el);
  return canvasToBlob(canvas, "image/png");
}

/**
 * 動画キャプチャ: 最大 maxSeconds 秒の webm を生成する。
 * フレームは frameMs 間隔で地図を再画像化して合成キャンバス（幅 width px）へ描く。
 * オプション: { maxSeconds=10, width=720, frameMs=300, onTick(残り秒数) }
 * 戻り値: { done: Promise<Blob>, stop(): void }
 * 非対応環境（supportsVideoCapture() が false）では例外を投げる。
 */
export function recordMapVideo(el, opts = {}) {
  if (!supportsVideoCapture()) {
    throw new Error("このブラウザは動画キャプチャに未対応です");
  }
  const maxSeconds = opts.maxSeconds ?? 10;
  const width = opts.width ?? 720;
  const frameMs = opts.frameMs ?? 300;
  const onTick = typeof opts.onTick === "function" ? opts.onTick : null;

  const clientW = Math.max(1, el.clientWidth || width);
  const clientH = Math.max(1, el.clientHeight || width);
  const frameRatio = Math.min(2, width / clientW);
  const W = Math.max(2, Math.round(clientW * frameRatio));
  const H = Math.max(2, Math.round(clientH * frameRatio));

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff9ee";
  ctx.fillRect(0, 0, W, H);

  const stream = canvas.captureStream(10);
  const mimeType = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
    "video/mp4"
  ].find(m => {
    try { return window.MediaRecorder.isTypeSupported(m); } catch { return false; }
  });
  const rec = new window.MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks = [];
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  const done = new Promise((resolve, reject) => {
    rec.onstop = () => resolve(new Blob(chunks, { type: rec.mimeType || "video/webm" }));
    rec.onerror = e => reject((e && e.error) || new Error("MediaRecorder error"));
  });

  let stopped = false;
  let capturing = false;
  const startedAt = Date.now();

  const drawFrame = async () => {
    if (stopped || capturing) return;
    capturing = true;
    try {
      const frame = await captureMapCanvas(el, frameRatio);
      if (!stopped) ctx.drawImage(frame, 0, 0, W, H);
    } catch {
      /* フレームの画像化に失敗しても録画は続ける（前フレームを保持） */
    }
    capturing = false;
  };

  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(frameTimer);
    clearInterval(tickTimer);
    try { rec.stop(); } catch { /* 既に停止している場合 */ }
  }

  rec.start(250);
  drawFrame();
  const frameTimer = setInterval(drawFrame, frameMs);
  const tickTimer = setInterval(() => {
    const left = maxSeconds - (Date.now() - startedAt) / 1000;
    if (onTick) onTick(Math.max(0, Math.ceil(left)));
    if (left <= 0) stop();
  }, 200);
  if (onTick) onTick(maxSeconds);

  return { done, stop };
}
