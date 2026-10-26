/**
 * みんなのMuse — 撮影（地図の静止画・動画キャプチャ）
 * ============================================================
 * 静止画: 地図（Leaflet コンテナ）を CDN の html-to-image で画像化し PNG 化する
 *   （解像度は表示の2倍以上・幅2048px上限）。
 * 動画  : 2方式ある。
 *   (A) 専用レンダラ方式（標準）: 録画開始時点の地図ビュー（中心・ズーム・
 *       表示サイズ）を固定し、OSM タイル画像と住人スプライトを Canvas へ
 *       requestAnimationFrame で直接描画する。DOM 画像化を介さないため
 *       毎フレームの描画が軽く、captureStream(30) のまま滑らかに録れる。
 *       タイルは crossOrigin='anonymous' で読み込む（OSM タイルは CORS
 *       ヘッダを返す）。タイル読み込みに失敗した場合は (B) に落ちる。
 *       この方式を使うには呼び出し側（app.js）が opts.getScene /
 *       opts.getResidents / opts.onLock / opts.onUnlock を渡すこと。
 *       住人の位置は app.js 側で約120ms間隔に更新されるため、そのまま
 *       描くと歩行が階段状にカクつく。レンダラは位置のサンプル履歴を
 *       持ち、描画時刻を少し遅らせて時刻ベースで線形補間してから描く。
 *       実際に使われた方式は opts.onMode("renderer" | "h2i") で呼び出し
 *       側へ通知される（フォールバック時は「低速モード」と表示するため）。
 *   (B) html-to-image 方式（フォールバック）: 地図 DOM を約100ms間隔
 *       （端末負荷に応じて最大300msまで自動で広げる）で再画像化して
 *       合成キャンバスへ描き続ける従来方式。
 *   どちらも合成キャンバスの解像度は「表示サイズ × devicePixelRatio
 *   （最大2）」・幅1080px上限、MediaRecorder は videoBitsPerSecond
 *   6Mbps・mp4優先。
 * 外部アバター等で画像化に失敗した場合は例外を投げるので、呼び出し側で
 * 「撮影モードのまま端末のスクショ／画面収録を使ってください」という
 * フォールバック案内を出すこと。
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

/* Web Share API でファイル自体を共有できるか（モバイルの共有シート経由で
 * Threads アプリ等へ動画・画像ファイルを渡せるか）の判定。
 * 使えない環境では「一度保存してからアプリで添付」を案内する。 */
export function canShareFiles(files) {
  try {
    return typeof navigator !== "undefined"
      && typeof navigator.canShare === "function"
      && Array.isArray(files) && files.length > 0
      && navigator.canShare({ files });
  } catch {
    return false;
  }
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

/* ================= 動画共通ヘルパ ================= */

/* MediaRecorder を作る。合成キャンバスは最大30fpsで取り込み、
 * SNS 互換性の高い mp4 を最優先し、なければ webm 系にフォールバックする。
 * 戻り値: { rec, done }（done は停止時に Blob で解決する Promise） */
function createMediaRecorder(canvas, bitsPerSecond) {
  const stream = canvas.captureStream(30);
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
  return { rec, done };
}

/* 合成キャンバスの大きさ: 表示サイズ × devicePixelRatio（最大2）、
 * 幅は opts.width（既定1080px）上限。コーデックが好む偶数サイズに丸める。
 * ratio は「キャンバスpx / CSS px」。 */
function computeFrameSize(el, opts = {}) {
  const clientW = Math.max(1, el.clientWidth || 720);
  const clientH = Math.max(1, el.clientHeight || Math.round(clientW * 9 / 16));
  const dpr = Math.min(2, (typeof window !== "undefined" && window.devicePixelRatio) || 1);
  const maxW = opts.width ?? 1080;
  const frameRatio = Math.min(maxW, Math.round(clientW * dpr)) / clientW;
  const even = n => Math.max(2, Math.round(n / 2) * 2);
  const W = even(clientW * frameRatio);
  const H = even(clientH * frameRatio);
  return { W, H, ratio: W / clientW, clientW, clientH };
}

/* 残り秒数のカウントダウンタイマ（両方式共通）。
 * onTimeout は時間切れ時に呼ばれる（通常は stop 処理）。 */
function startTickTimer(maxSeconds, startedAt, onTick, onTimeout) {
  const tickTimer = setInterval(() => {
    const left = maxSeconds - (Date.now() - startedAt) / 1000;
    if (onTick) onTick(Math.max(0, Math.ceil(left)));
    if (left <= 0) onTimeout();
  }, 200);
  if (onTick) onTick(maxSeconds);
  return tickTimer;
}

/* ================= (B) html-to-image 方式（フォールバック） =================
 * 地図 DOM を frameMs 間隔で再画像化して合成キャンバスへ描き続ける従来方式。
 * 画像化が遅い端末では間隔を最大300msまで自動で広げる（実効fpsは下がる）。 */
function recordMapVideoH2I(el, opts = {}) {
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

  const { rec, done } = createMediaRecorder(canvas, bitsPerSecond);

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
  const tickTimer = startTickTimer(maxSeconds, startedAt, onTick, stop);

  return { done, stop };
}

/* ================= (A) 専用レンダラ方式 =================
 * 録画開始時点のビューを固定し、OSM タイルと住人スプライトを Canvas へ
 * 直接描画する。投影は Leaflet と同じ Web Mercator。
 * view = { centerLat, centerLng, zoom, width, height（CSS px）, walk } */

/* 経度→世界ピクセルX（scale = 世界の一辺のピクセル数） */
function lngToWorldX(lng, scale) {
  return (lng + 180) / 360 * scale;
}
/* 緯度→世界ピクセルY */
function latToWorldY(lat, scale) {
  const s = Math.sin(lat * Math.PI / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale;
}

/* 緯度経度 → ビュー内 CSS ピクセル座標 [x, y]（中心が [width/2, height/2]） */
export function projectToCssPx(view, lat, lng) {
  const scale = 256 * Math.pow(2, view.zoom);
  const cx = lngToWorldX(view.centerLng, scale);
  const cy = latToWorldY(view.centerLat, scale);
  return [
    lngToWorldX(lng, scale) - cx + view.width / 2,
    latToWorldY(lat, scale) - cy + view.height / 2
  ];
}

/* ビューを覆うタイルの配置一覧を返す。
 * 各要素: { z, x, y（URL用にラップ済み）, dx, dy, size（CSS pxでの描画位置と一辺） }
 * ズームが非整数の場合は整数タイルズームで読み、描画時に拡大縮小して合わせる。 */
export function computeTilePlacements(view) {
  const z = Math.max(0, Math.min(19, Math.round(view.zoom)));
  const n = Math.pow(2, z);
  const ts = Math.pow(2, view.zoom - z); // 1タイルの表示辺 = 256 * ts（CSS px）
  const scaleZ = 256 * n;
  const cx = lngToWorldX(view.centerLng, scaleZ);
  const cy = latToWorldY(view.centerLat, scaleZ);
  /* ビューの広さをタイルズームの世界ピクセルに換算した半幅・半高 */
  const halfW = view.width / (2 * ts);
  const halfH = view.height / (2 * ts);
  const x0 = cx - halfW;
  const y0 = cy - halfH;
  const txMin = Math.floor(x0 / 256);
  const txMax = Math.floor((x0 + view.width / ts - 1) / 256);
  const tyMin = Math.max(0, Math.floor(y0 / 256));
  const tyMax = Math.min(n - 1, Math.floor((y0 + view.height / ts - 1) / 256));
  const list = [];
  for (let tx = txMin; tx <= txMax; tx++) {
    for (let ty = tyMin; ty <= tyMax; ty++) {
      list.push({
        z,
        x: ((tx % n) + n) % n,
        y: ty,
        dx: (tx * 256 - x0) * ts,
        dy: (ty * 256 - y0) * ts,
        size: 256 * ts
      });
    }
  }
  return list;
}

const TILE_TIMEOUT_MS = 5000;   /* 1回の試行のタイムアウト */
const TILE_MAX_ATTEMPTS = 3;     /* 1枚あたりの最大試行回数（リトライ込み） */
const TILE_MAX_MISSING = 2;      /* この枚数までの欠けは許容して描画する */

function sleepMs(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/* タイル1枚を1回だけ読み込む試行 */
function loadTileOnce(p) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    const timer = setTimeout(() => reject(new Error("タイル読み込みタイムアウト")), TILE_TIMEOUT_MS);
    img.onload = () => { clearTimeout(timer); resolve({ ...p, img }); };
    img.onerror = () => { clearTimeout(timer); reject(new Error("タイル読み込みに失敗しました")); };
    img.src = `https://tile.openstreetmap.org/${p.z}/${p.x}/${p.y}.png`;
  });
}

/* タイルをすべて読み込む。1枚ごとの失敗は間隔を空けてリトライし、
 * 数枚の欠け（TILE_MAX_MISSING まで）は背景色のまま許容して正規ルートを
 * 維持する。それ以上失敗したら例外（→ フォールバック＋低速モード表示）。 */
export async function loadTiles(view) {
  const placements = computeTilePlacements(view);
  if (!placements.length) throw new Error("タイル範囲が空です");
  const results = await Promise.all(placements.map(async p => {
    for (let attempt = 0; attempt < TILE_MAX_ATTEMPTS; attempt++) {
      try {
        return await loadTileOnce(p);
      } catch {
        if (attempt < TILE_MAX_ATTEMPTS - 1) await sleepMs(300 * (attempt + 1));
      }
    }
    return null;
  }));
  const loaded = results.filter(Boolean);
  const missing = placements.length - loaded.length;
  if (missing > TILE_MAX_MISSING) {
    throw new Error(`タイル読み込みに失敗しました（${missing}/${placements.length}枚）`);
  }
  return loaded;
}

/* 画像を CORS クリーンに読み込む（失敗しても例外にせず null を返す）。
 * 同一URLはキャッシュする。汚染源になり得る画像は使わず、呼び出し側で
 * プレースホルダに落とす。 */
const imageCache = new Map();
function loadImageCORS(url, timeoutMs = 6000) {
  if (!url) return Promise.resolve(null);
  if (imageCache.has(url)) return imageCache.get(url);
  const p = new Promise(resolve => {
    let settled = false;
    const finish = v => { if (!settled) { settled = true; resolve(v); } };
    try {
      const img = new Image();
      img.crossOrigin = "anonymous";
      const timer = setTimeout(() => finish(null), timeoutMs);
      img.onload = () => { clearTimeout(timer); finish(img); };
      img.onerror = () => { clearTimeout(timer); finish(null); };
      img.src = url;
    } catch {
      finish(null);
    }
  });
  imageCache.set(url, p);
  return p;
}

/* ================= 位置の時刻ベース補間 =================
 * 住人の位置は app.js の徘徊タイマ（約120ms間隔）で更新されるため、
 * 観測した位置をそのまま描くと歩行が120ms刻みの階段状になる。
 * レンダラは住人ごとに位置サンプルの履歴を持ち、描画対象時刻を
 * INTERP_DELAY_MS だけ過去にずらして、サンプル間を線形補間する。
 * これで見た目の移動が連続になり、歩行のカクつきが消える。 */

/* 補間のために描画を遅らせる量（サンプル間隔120ms＋観測ジッタの余裕） */
export const INTERP_DELAY_MS = 160;

/* samples: [{ t, lat, lng }]（t は時刻・昇順）を時刻 t で線形補間する。
 * 範囲外は端のサンプルを返し、空なら null を返す。 */
export function interpolateLatLng(samples, t) {
  if (!samples || !samples.length) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (t <= first.t) return { lat: first.lat, lng: first.lng };
  if (t >= last.t) return { lat: last.lat, lng: last.lng };
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i];
    const b = samples[i + 1];
    if (a.t <= t && t <= b.t) {
      const f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
      return { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f };
    }
  }
  return { lat: last.lat, lng: last.lng };
}

/* サンプル履歴へ現在位置を積み、補間済み位置を返す。
 * track は prep.tracks の slug ごとの配列。位置が変わったときだけ積む
 * （止まっている住人はサンプルが増えず、補間結果も静止のままになる）。 */
export function sampleResidentPosition(prep, r, now) {
  let track = prep.tracks.get(r.slug);
  if (!track) {
    track = [];
    prep.tracks.set(r.slug, track);
  }
  const last = track[track.length - 1];
  if (!last || last.lat !== r.lat || last.lng !== r.lng) {
    track.push({ t: now, lat: r.lat, lng: r.lng });
  }
  const rt = now - INTERP_DELAY_MS;
  /* 補間に不要になった古いサンプルを捨てる（直前の1点は残す） */
  while (track.length > 2 && track[1].t <= rt) track.shift();
  return interpolateLatLng(track, rt) || { lat: r.lat, lng: r.lng };
}

/* レンダラの準備: ビュー固定＋タイル読み込み＋住人画像の先読み。
 * タイルが揃わなければ例外を投げる（呼び出し側で (B) にフォールバック）。 */
async function prepareSceneRenderer(el, opts, scene) {
  const view = {
    centerLat: scene.centerLat,
    centerLng: scene.centerLng,
    zoom: scene.zoom,
    width: scene.width || el.clientWidth || 720,
    height: scene.height || el.clientHeight || Math.round((scene.width || el.clientWidth || 720) * 9 / 16),
    walk: !!scene.walk
  };
  const tiles = await loadTiles(view);
  const residents = typeof opts.getResidents === "function" ? (opts.getResidents() || []) : [];
  const urls = new Set();
  residents.forEach(r => {
    if (r.sprite) urls.add(r.sprite);
    if (r.avatar) urls.add(r.avatar);
  });
  const images = new Map();
  await Promise.all([...urls].map(async u => { images.set(u, await loadImageCORS(u)); }));
  return { view, tiles, images, prevX: new Map(), face: new Map(), tracks: new Map() };
}

/* ---- 描画部品（index.html の .muse-marker / .muse-walker の見た目に寄せる） ---- */
const FONT_STACK = '"Hiragino Maru Gothic ProN","Hiragino Sans","Noto Sans JP",sans-serif';
const BUBBLE_FONT = `700 10.5px ${FONT_STACK}`;
const LABEL_FONT = `800 11.5px ${FONT_STACK}`;
const INK = "#2b2b33";
const BORDER = "#e7dcc3";

/* 角丸矩形のパス（ctx.roundRect に依存しない） */
function pillPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arc(x + w - rr, y + rr, rr, -Math.PI / 2, 0);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arc(x + w - rr, y + h - rr, rr, 0, Math.PI / 2);
  ctx.lineTo(x + rr, y + h);
  ctx.arc(x + rr, y + h - rr, rr, Math.PI / 2, Math.PI);
  ctx.lineTo(x, y + rr);
  ctx.arc(x + rr, y + rr, rr, Math.PI, Math.PI * 1.5);
  ctx.closePath();
}

/* テキストを maxW に収まるよう文字単位で折り返す（最大 maxLines 行、溢れは …） */
function wrapText(ctx, text, maxW, maxLines) {
  const chars = [...String(text)];
  const lines = [];
  let line = "";
  for (const ch of chars) {
    if (ctx.measureText(line + ch).width > maxW && line) {
      lines.push(line);
      line = ch;
      if (lines.length === maxLines) break;
    } else {
      line += ch;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines) {
    const joined = lines.join("");
    if (joined.length < chars.length) {
      let last = lines[maxLines - 1];
      while (last && ctx.measureText(last + "…").width > maxW) last = last.slice(0, -1);
      lines[maxLines - 1] = last + "…";
    }
  }
  return lines;
}

/* 吹き出し（ステータス）: 中心 cx・上端 top に描く */
function drawBubble(ctx, cx, top, text) {
  if (!text) return;
  ctx.save();
  ctx.font = BUBBLE_FONT;
  const lines = wrapText(ctx, text, 134, 3);
  if (!lines.length) { ctx.restore(); return; }
  const lineH = 15.2;
  const w = Math.max(...lines.map(l => ctx.measureText(l).width)) + 16;
  const h = lines.length * lineH + 6;
  const x0 = cx - w / 2;
  ctx.fillStyle = "rgba(255,255,255,0.96)";
  ctx.strokeStyle = BORDER;
  ctx.lineWidth = 1.5;
  pillPath(ctx, x0, top, w, h, 10);
  ctx.fill();
  ctx.stroke();
  /* しっぽ */
  ctx.beginPath();
  ctx.moveTo(cx - 5, top + h - 1);
  ctx.lineTo(cx + 5, top + h - 1);
  ctx.lineTo(cx, top + h + 5);
  ctx.closePath();
  ctx.fillStyle = "rgba(255,255,255,0.96)";
  ctx.fill();
  ctx.fillStyle = INK;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  lines.forEach((l, i) => ctx.fillText(l, cx, top + 4 + i * lineH));
  ctx.restore();
}

/* 名前ラベル: 中心 cx・上端 top に描く */
function drawLabel(ctx, cx, top, name) {
  if (!name) return;
  ctx.save();
  ctx.font = LABEL_FONT;
  const w = ctx.measureText(String(name)).width + 18;
  const h = 19;
  pillPath(ctx, cx - w / 2, top, w, h, h / 2);
  ctx.fillStyle = "rgba(255,255,255,0.94)";
  ctx.fill();
  ctx.strokeStyle = BORDER;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = INK;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(name), cx, top + h / 2 + 0.5);
  ctx.restore();
}

/* 画像が無い住人の仮の姿（金色の円＋頭文字） */
function drawPlaceholder(ctx, cx, cy, radius, name) {
  ctx.save();
  ctx.fillStyle = "#e8a93d";
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = `800 ${Math.round(radius * 0.95)}px ${FONT_STACK}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText([...String(name || "?")][0] || "?", cx, cy + 1);
  ctx.restore();
}

/* 正方形にクロップして cover 描画する */
function drawImageCover(ctx, img, x, y, w, h) {
  const iw = img.width || w;
  const ih = img.height || h;
  const s = Math.min(iw, ih);
  ctx.drawImage(img, (iw - s) / 2, (ih - s) / 2, s, s, x, y, w, h);
}

function setHueFilter(ctx, hue) {
  if (hue === null || hue === undefined) return;
  try { ctx.filter = `hue-rotate(${hue}deg)`; } catch { /* 非対応環境では無視 */ }
}

/* お散歩モードの1体分（アイコン 88×132・アンカー (44,108) 基準） */
function drawWalker(ctx, prep, item, now) {
  const { r, x, y } = item;
  const moving = !!r.moving;
  /* 吹き出し（DOM の並び順どおり最初に描く） */
  drawBubble(ctx, x, y - 108, r.status);
  /* 足元の影（歩行中は shadowpulse 相当で伸縮） */
  const pulse = moving ? Math.pow(Math.sin(Math.PI * ((now % 480) / 480)), 2) : 0;
  ctx.save();
  ctx.globalAlpha = 1 - 0.25 * pulse;
  ctx.fillStyle = "rgba(60,50,20,0.28)";
  ctx.beginPath();
  ctx.ellipse(x, y + 1, 29 * (1 - 0.16 * pulse), 7, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  /* 体（walkbob / idlesway 相当の上下動と傾き、向き反転、色替え） */
  let ty = 0;
  let rotDeg = 0;
  if (moving) {
    const t = now % 480;
    ty = -5 * Math.abs(Math.sin(Math.PI * t / 240));
    rotDeg = -2.5 * Math.cos(2 * Math.PI * t / 240);
  } else {
    ty = -2.5 * (0.5 - 0.5 * Math.cos(2 * Math.PI * (now % 3200) / 3200));
  }
  const img = prep.images.get(r.sprite) || prep.images.get(r.avatar) || null;
  ctx.save();
  const oy = y - 2 + ty; // transform-origin 50% 92% 相当
  ctx.translate(x, oy);
  ctx.rotate(rotDeg * Math.PI / 180);
  ctx.translate(-x, -oy);
  if (r.facing < 0) {
    ctx.translate(x, 0);
    ctx.scale(-1, 1);
    ctx.translate(-x, 0);
  }
  setHueFilter(ctx, r.hue);
  if (img) {
    ctx.drawImage(img, x - 37, y - 70 + ty, 74, 74);
  } else {
    drawPlaceholder(ctx, x, y - 70 + ty + 37, 30, r.name);
  }
  ctx.restore();
  /* 名前ラベル */
  drawLabel(ctx, x, y + 4, r.name);
}

/* 通常モードの1体分（アイコン 76×104・アンカー (38,62) 基準） */
function drawPin(ctx, prep, item, now) {
  const { r, x, y } = item;
  drawBubble(ctx, x, y - 62, r.status);
  const bobY = -5 * (0.5 - 0.5 * Math.cos(2 * Math.PI * (now % 2600) / 2600));
  const cx = x;
  const cy = y - 1 + bobY;
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 3;
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(cx, cy, 25, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  const img = prep.images.get(r.avatar) || prep.images.get(r.sprite) || null;
  if (img) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, 22, 0, Math.PI * 2);
    ctx.clip();
    setHueFilter(ctx, r.hue);
    drawImageCover(ctx, img, cx - 22, cy - 22, 44, 44);
    ctx.restore();
  } else {
    drawPlaceholder(ctx, cx, cy, 22, r.name);
  }
  drawLabel(ctx, x, y + 26, r.name);
}

/* OSM クレジット（録画にも帰属表示を残す） */
function drawAttribution(ctx, view) {
  ctx.save();
  ctx.font = `10px ${FONT_STACK}`;
  const text = "© OpenStreetMap contributors";
  const w = ctx.measureText(text).width + 10;
  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.fillRect(view.width - w, view.height - 16, w, 16);
  ctx.fillStyle = "#333333";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, view.width - w + 5, view.height - 7.5);
  ctx.restore();
}

/* 1フレーム分を描く（CSS px 座標系で描き、ctx 側で ratio を掛ける） */
function drawScene(ctx, prep, opts, now) {
  const { view, tiles } = prep;
  ctx.fillStyle = "#f2efe9";
  ctx.fillRect(0, 0, view.width, view.height);
  for (const t of tiles) {
    ctx.drawImage(t.img, t.dx, t.dy, t.size, t.size);
  }
  const residents = typeof opts.getResidents === "function" ? (opts.getResidents() || []) : [];
  const items = [];
  for (const r of residents) {
    if (typeof r.lat !== "number" || typeof r.lng !== "number") continue;
    /* 120ms刻みの生位置ではなく、サンプル履歴から補間した位置を描く */
    const pos = prep.tracks ? sampleResidentPosition(prep, r, now) : { lat: r.lat, lng: r.lng };
    const [x, y] = projectToCssPx(view, pos.lat, pos.lng);
    if (x < -160 || y < -200 || x > view.width + 160 || y > view.height + 80) continue;
    /* 向きが渡ってこない場合は位置の変化量から推定する */
    if (typeof r.facing !== "number") {
      const prev = prep.prevX.get(r.slug);
      if (prev !== undefined && Math.abs(x - prev) > 0.3) {
        prep.face.set(r.slug, x < prev ? -1 : 1);
      }
      r.facing = prep.face.get(r.slug) || 1;
    }
    prep.prevX.set(r.slug, x);
    items.push({ r, x, y });
  }
  /* 北（画面の上）の住人から描き、南の住人が手前に重なるようにする */
  items.sort((a, b) => a.y - b.y);
  for (const item of items) {
    if (view.walk) drawWalker(ctx, prep, item, now);
    else drawPin(ctx, prep, item, now);
  }
  drawAttribution(ctx, view);
}

/* 専用レンダラで録画する。prep は prepareSceneRenderer の結果。 */
function startRendererRecording(el, opts, prep) {
  const maxSeconds = opts.maxSeconds ?? 10;
  const bitsPerSecond = opts.bitsPerSecond ?? 6_000_000;
  const onTick = typeof opts.onTick === "function" ? opts.onTick : null;
  const { W, H, ratio } = computeFrameSize(el, opts);

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#f2efe9";
  ctx.fillRect(0, 0, W, H);

  const { rec, done } = createMediaRecorder(canvas, bitsPerSecond);

  let stopped = false;
  let rafId = null;
  const startedAt = Date.now();

  const draw = (now) => {
    if (stopped) return;
    try {
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      drawScene(ctx, prep, opts, now);
    } catch {
      /* 1フレームの描画失敗で録画自体は止めない（前フレームを保持） */
    }
    rafId = requestAnimationFrame(draw);
  };

  function stop() {
    if (stopped) return;
    stopped = true;
    if (rafId !== null) cancelAnimationFrame(rafId);
    clearInterval(tickTimer);
    try { rec.stop(); } catch { /* 既に停止している場合 */ }
  }

  rec.start(250);
  rafId = requestAnimationFrame(draw);
  const tickTimer = startTickTimer(maxSeconds, startedAt, onTick, stop);

  return { done, stop };
}

/**
 * 動画キャプチャ: 最大 maxSeconds 秒の動画（mp4 優先・なければ webm）を生成する。
 *
 * 標準は専用レンダラ方式（A）: 呼び出し側が次のコールバックを渡す。
 *   opts.getScene()     -> { centerLat, centerLng, zoom, width, height, walk }
 *                          録画開始時点のビュー。recordMapVideo の呼び出しと
 *                          同期的に1回だけ評価され、録画中は固定される。
 *   opts.getResidents() -> [{ slug, name, status, lat, lng, facing, moving,
 *                             sprite, avatar, hue }]（毎フレーム評価される）
 *   opts.onLock()       -> 録画中の地図操作を無効化する（開始時に同期的に呼ぶ）
 *   opts.onUnlock()     -> 録画終了（成功・失敗・停止）時に必ず呼ぶ
 * タイル読み込みに失敗した場合や、コールバックが無い場合は従来の
 * html-to-image 方式（B）にフォールバックする。その際は
 * opts.onMode("h2i") で呼び出し側へ通知されるので、利用者へ
 * 「低速モードで録画しました」と表示できる（無言で落とさない）。
 * 正規ルートで録画が始まった場合は opts.onMode("renderer") が呼ばれる。
 * オプション: { maxSeconds=10, width=1080, bitsPerSecond=6000000,
 *               onTick(残り秒数), onMode(方式), getScene, getResidents,
 *               onLock, onUnlock }
 * 戻り値: { done: Promise<Blob>, stop(): void }
 * 非対応環境（supportsVideoCapture() が false）では例外を投げる。
 * この判定を通過しない限り (A)(B) どちらの録画も始まらないため、
 * 未対応環境で中途半端に旧方式だけが動くことはない。
 */
export function recordMapVideo(el, opts = {}) {
  if (!supportsVideoCapture()) {
    throw new Error("このブラウザは動画キャプチャに未対応です");
  }
  const notifyMode = (mode) => {
    if (typeof opts.onMode === "function") {
      try { opts.onMode(mode); } catch { /* 通知失敗で録画は止めない */ }
    }
  };
  /* ビューは録画開始のこの瞬間に固定する（準備の非同期処理中に
   * ユーザーが地図を動かしても録画内容がずれないように） */
  let scene = null;
  if (typeof opts.getScene === "function") {
    try { scene = opts.getScene(); } catch { scene = null; }
  }
  if (!scene || typeof opts.getResidents !== "function") {
    notifyMode("h2i");
    return recordMapVideoH2I(el, opts);
  }
  if (typeof opts.onLock === "function") {
    try { opts.onLock(); } catch { /* ロック失敗でも録画は続ける */ }
  }

  let inner = null;
  let stopRequested = false;
  const done = (async () => {
    try {
      let prep = null;
      try {
        prep = await prepareSceneRenderer(el, opts, scene);
      } catch (err) {
        console.warn("専用レンダラの準備に失敗しました。従来方式にフォールバックします", err);
        prep = null;
      }
      if (stopRequested) throw new Error("録画は開始前に停止されました");
      notifyMode(prep ? "renderer" : "h2i");
      inner = prep
        ? startRendererRecording(el, opts, prep)
        : recordMapVideoH2I(el, opts);
      return await inner.done;
    } finally {
      if (typeof opts.onUnlock === "function") {
        try { opts.onUnlock(); } catch { /* 復帰失敗は無視 */ }
      }
    }
  })();

  return {
    done,
    stop() {
      if (inner) inner.stop();
      else stopRequested = true;
    }
  };
}
