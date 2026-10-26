/**
 * みんなのMuse — 撮影（地図の静止画・動画キャプチャ）
 * ============================================================
 * 地図（Leaflet コンテナ）を CDN の html-to-image で画像化する。
 *   静止画: toCanvas → PNG Blob（解像度は表示の2倍以上・幅2048px上限）
 *   動画  : 静止画フレームを約100ms間隔（端末負荷に応じて最大300msまで
 *           自動で広げる）で合成キャンバス（幅は表示サイズ×DPR・上限1080px）
 *           へ描き続け、canvas.captureStream(30) + MediaRecorder
 *           （videoBitsPerSecond 6Mbps・mp4優先）で動画化する
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

/* 静止画キャプチャ: 地図の現在の表示を PNG Blob にする。失敗時は例外。
 * 画質のため pixelRatio は表示の2倍以上（DPR・最大3）を狙うが、
 * 出力幅が 2048px を超えないよう抑えてメモリ暴走を防ぐ。 */
export async function captureMapPhoto(el) {
  const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
  let pr = Math.min(3, Math.max(2, dpr));
  const w = el && el.clientWidth;
  if (w) pr = Math.min(pr, 2048 / w);
  const canvas = await captureMapCanvas(el, Math.max(1, pr));
  return canvasToBlob(canvas, "image/png");
}

/**
 * 動画キャプチャ: 最大 maxSeconds 秒の動画（mp4 優先・なければ webm）を生成する。
 * フレームは frameMs 間隔を目安に地図を再画像化して合成キャンバスへ描く。
 * 画像化に時間がかかる端末では、間隔を最大300msまで自動で広げて追いつかせる
 * （その分だけ実効フレームレートが下がる。速い端末では約10fps）。
 * 合成キャンバスの解像度は「表示サイズ × devicePixelRatio（最大2）」で、
 * 幅は width px（既定1080）を上限にする。
 * オプション: { maxSeconds=10, width=1080, frameMs=100,
 *               bitsPerSecond=6000000, onTick(残り秒数) }
 * 戻り値: { done: Promise<Blob>, stop(): void }
 * 非対応環境（supportsVideoCapture() が false）では例外を投げる。
 */
export function recordMapVideo(el, opts = {}) {
  if (!supportsVideoCapture()) {
    throw new Error("このブラウザは動画キャプチャに未対応です");
  }
  const maxSeconds = opts.maxSeconds ?? 10;
  const frameMs = opts.frameMs ?? 100;
  const bitsPerSecond = opts.bitsPerSecond ?? 6_000_000;
  const onTick = typeof opts.onTick === "function" ? opts.onTick : null;

  const clientW = Math.max(1, el.clientWidth || 720);
  const clientH = Math.max(1, el.clientHeight || Math.round(clientW * 9 / 16));
  const dpr = Math.min(2, (typeof window !== "undefined" && window.devicePixelRatio) || 1);
  const maxW = opts.width ?? 1080;
  const frameRatio = Math.min(maxW, Math.round(clientW * dpr)) / clientW;
  /* コーデックが好む偶数サイズに丸める */
  const even = n => Math.max(2, Math.round(n / 2) * 2);
  const W = even(clientW * frameRatio);
  const H = even(clientH * frameRatio);

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff9ee";
  ctx.fillRect(0, 0, W, H);

  /* 合成キャンバスは最大30fpsで取り込み、描画されたフレームを滑らかに記録する */
  const stream = canvas.captureStream(30);
  /* SNS 互換性の高い mp4 を最優先し、なければ webm 系にフォールバックする */
  const mimeType = [
    "video/mp4",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm"
  ].find(m => {
    try { return window.MediaRecorder.isTypeSupported(m); } catch { return false; }
  });
  const recOptions = { videoBitsPerSecond: bitsPerSecond };
  if (mimeType) recOptions.mimeType = mimeType;
  const rec = new window.MediaRecorder(stream, recOptions);
  const chunks = [];
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  const done = new Promise((resolve, reject) => {
    rec.onstop = () => resolve(new Blob(chunks, { type: rec.mimeType || "video/webm" }));
    rec.onerror = e => reject((e && e.error) || new Error("MediaRecorder error"));
  });

  let stopped = false;
  let frameTimer = null;
  let frameDelay = frameMs;
  const startedAt = Date.now();

  /* 1フレーム描いて、かかった時間（ms）を返す */
  const drawFrame = async () => {
    const t0 = Date.now();
    try {
      const frame = await captureMapCanvas(el, frameRatio);
      if (!stopped) ctx.drawImage(frame, 0, 0, W, H);
    } catch {
      /* フレームの画像化に失敗しても録画は続ける（前フレームを保持） */
    }
    return Date.now() - t0;
  };

  /* setInterval ではなく「描き終わってから次を予約」するチェーンにし、
   * 画像化が遅い端末でも詰まらず、間隔だけが自動で広がるようにする */
  const frameLoop = async () => {
    if (stopped) return;
    const dur = await drawFrame();
    if (stopped) return;
    if (dur > frameDelay) {
      frameDelay = Math.min(300, Math.ceil(dur * 1.15));
    }
    frameTimer = setTimeout(frameLoop, Math.max(0, frameDelay - dur));
  };

  function stop() {
    if (stopped) return;
    stopped = true;
    if (frameTimer !== null) clearTimeout(frameTimer);
    clearInterval(tickTimer);
    try { rec.stop(); } catch { /* 既に停止している場合 */ }
  }

  rec.start(250);
  frameLoop();
  const tickTimer = setInterval(() => {
    const left = maxSeconds - (Date.now() - startedAt) / 1000;
    if (onTick) onTick(Math.max(0, Math.ceil(left)));
    if (left <= 0) stop();
  }, 200);
  if (onTick) onTick(maxSeconds);

  return { done, stop };
}
