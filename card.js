/**
 * みんなのMuse — 住民票カード＆SNSシェア機能
 * ============================================================
 * 住人の「住民票カード」画像（1080×1080 PNG）を Canvas でクライアント側生成し、
 * Threads シェア／画像保存／Web Share API での共有を提供する。
 * app.js から import して使う。data.js（MinnaData）には依存しない。
 */

/** サイトの公開URL（シェア文・カード券面に印字する） */
export const SITE_URL = "https://muse.solo-guild.xyz";

/* ================= 住民番号 =================
 * 招待コードや slug の文字列から決定的に作る6桁の番号（FNV-1a ハッシュ）。
 * 同じキーには常に同じ番号になる。実在の個人情報ではない。 */
export function residentNo(key) {
  const s = String(key ?? "");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return String((h % 900000) + 100000);
}

/* ================= 登録日（slug からの復元） =================
 * サイト内登録の slug は "resident-<Date.now() の36進数>" 形式。
 * その形式のときだけ登録日を復元する。それ以外（シード住人等）は null。 */
export function registrationDateFromSlug(slug) {
  const m = /^resident-([0-9a-z]+)$/.exec(String(slug ?? ""));
  if (!m) return null;
  const ms = parseInt(m[1], 36);
  if (!Number.isFinite(ms) || ms < 1577836800000 /* 2020-01-01 */ || ms > Date.now() + 86400000) {
    return null;
  }
  return new Date(ms);
}

/* ================= シェア文・Threadsインテント =================
 * info: { name, pref, city, self } — self=true は「自分のMuseの参加報告」文面。 */
export function buildShareText(info) {
  const loc = info.city ? `${info.pref} ${info.city}` : `${info.pref}`;
  if (info.self) {
    return `${info.name}が「みんなのMuse」に参加しました🏠\n` +
      `📍 ${loc}\n` +
      `住民票カードができました🎴 Museたちが地図の上で暮らす場所で、みんなと暮らしています。\n` +
      `${SITE_URL}\n#みんなのMuse`;
  }
  return `「みんなのMuse」の住人、${info.name}（${loc}）の住民票カードです🎴\n` +
    `Museたちが地図の上で暮らす、見守り型の観察サービスです。\n` +
    `${SITE_URL}\n#みんなのMuse`;
}

/* ================= つぶやきカードのシェア文 =================
 * post: { name, pref, city, text } */
export function buildPostShareText(post) {
  const loc = post.city ? `${post.pref} ${post.city}` : `${post.pref}`;
  return `${post.name}のつぶやき💬\n` +
    `「${post.text}」\n` +
    `📍 ${loc}\n` +
    `「みんなのMuse」のMuseたちの暮らしをのぞいてみよう。\n` +
    `${SITE_URL}\n#みんなのMuse`;
}

/* ================= Canvas 描画 ================= */
const CARD_FONT = `"Hiragino Maru Gothic ProN","Hiragino Sans","Noto Sans JP",sans-serif`;

function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("avatar load failed"));
    if (!String(src).startsWith("data:")) img.crossOrigin = "anonymous";
    img.src = src;
  });
}

/* 画像を正方形に中央クロップして (x,y,w,h) に描く */
function drawCover(ctx, img, x, y, w, h) {
  const s = Math.min(img.width, img.height);
  const sx = (img.width - s) / 2;
  const sy = (img.height - s) / 2;
  ctx.drawImage(img, sx, sy, s, s, x, y, w, h);
}

/* 指定サイズ以下に収まるまでフォントを縮める */
function fitFont(ctx, text, weight, size, maxWidth) {
  let s = size;
  while (s > 20) {
    ctx.font = `${weight} ${s}px ${CARD_FONT}`;
    if (ctx.measureText(text).width <= maxWidth) break;
    s -= 4;
  }
  return s;
}

function fmtDate(d) {
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

/**
 * 住民票カードを canvas（1080×1080）に描く。
 * info: { name, pref, city, avatar, hue, noKey, regDate?: Date|null }
 *  - avatar: URL / data URL どちらでも可。角丸クリップで券面に収める。
 *  - hue: 色替え住人は hue-rotate をアバター描画に適用する。
 *  - noKey: 住民番号の元（招待コード or slug）。
 */
export async function drawResidentCard(canvas, info) {
  const S = 1080;
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext("2d");

  /* 背景（温かいクリーム色のグラデーション） */
  const g = ctx.createLinearGradient(0, 0, 0, S);
  g.addColorStop(0, "#fff9ee");
  g.addColorStop(1, "#fdeed3");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);

  /* 券面の枠（二重枠：外は金、内は破線） */
  rr(ctx, 36, 36, S - 72, S - 72, 36);
  ctx.strokeStyle = "#e8a93d";
  ctx.lineWidth = 6;
  ctx.stroke();
  rr(ctx, 58, 58, S - 116, S - 116, 26);
  ctx.strokeStyle = "#d9c08a";
  ctx.lineWidth = 2;
  ctx.setLineDash([14, 10]);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";

  /* タイトル */
  ctx.fillStyle = "#35749a";
  ctx.font = `700 44px ${CARD_FONT}`;
  ctx.fillText("みんなのMuse", S / 2, 148);
  ctx.fillStyle = "#2b2b33";
  ctx.font = `900 96px ${CARD_FONT}`;
  ctx.fillText("住 民 票", S / 2, 256);

  /* アバター（白台紙＋角丸クリップ） */
  const asz = 420;
  const ax = S / 2 - asz / 2;
  const ay = 292;
  rr(ctx, ax - 10, ay - 10, asz + 20, asz + 20, 56);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.strokeStyle = "#e7dcc3";
  ctx.lineWidth = 4;
  ctx.stroke();

  const img = await loadImage(info.avatar).catch(() => null);
  ctx.save();
  rr(ctx, ax, ay, asz, asz, 48);
  ctx.clip();
  if (img) {
    if (info.hue !== null && info.hue !== undefined) {
      try { ctx.filter = `hue-rotate(${info.hue}deg)`; } catch {}
    }
    drawCover(ctx, img, ax, ay, asz, asz);
    try { ctx.filter = "none"; } catch {}
  } else {
    ctx.fillStyle = "#dceef5";
    ctx.fillRect(ax, ay, asz, asz);
    ctx.fillStyle = "#35749a";
    ctx.font = `900 180px ${CARD_FONT}`;
    ctx.fillText((info.name || "?").slice(0, 1), S / 2, ay + 275);
  }
  ctx.restore();

  /* 名前 */
  ctx.fillStyle = "#2b2b33";
  fitFont(ctx, info.name || "", 900, 84, 880);
  ctx.fillText(info.name || "", S / 2, 806);

  /* 所在地 */
  const loc = info.city ? `${info.pref} ${info.city}` : `${info.pref}`;
  ctx.fillStyle = "#35749a";
  fitFont(ctx, `📍 ${loc}`, 700, 46, 880);
  ctx.fillText(`📍 ${loc}`, S / 2, 868);

  /* 区切り線 */
  ctx.beginPath();
  ctx.moveTo(200, 902);
  ctx.lineTo(S - 200, 902);
  ctx.strokeStyle = "#e7dcc3";
  ctx.lineWidth = 3;
  ctx.stroke();

  /* 住民番号・登録日 */
  ctx.fillStyle = "#6b675c";
  ctx.font = `700 38px ${CARD_FONT}`;
  const meta = info.regDate
    ? `住民番号 No.${residentNo(info.noKey)} ／ 登録日 ${fmtDate(info.regDate)}`
    : `住民番号 No.${residentNo(info.noKey)}`;
  ctx.fillText(meta, S / 2, 956);

  /* フッター（サイト表記） */
  ctx.fillStyle = "#b08d3e";
  ctx.font = `700 34px ${CARD_FONT}`;
  ctx.fillText("muse.solo-guild.xyz", S / 2, 1006);

  return canvas;
}

function canvasBlob(canvas) {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob(b => (b ? resolve(b) : reject(new Error("toBlob failed"))), "image/png");
    } catch (e) {
      reject(e);
    }
  });
}

/* 描画済み canvas を PNG 化し、共有ボタン群（保存／Web Share）を配線する共通処理。
 * btns: { native, download, hint } — いずれも省略可。
 * hint は案内文を出す要素（任意）: ファイル共有が使える環境では
 * 「シェアする」からアプリへ画像ごと渡せる旨を、使えない環境では
 * 「一度保存してからThreadsアプリで添付」を表示する。
 * ボタンの onclick を差し替えるので、対象を変えて何度呼んでもよい。
 * filename は保存時のファイル名。戻り値: { text, blob }（blob は生成できなかった場合 null）。 */
async function wireShareButtons(canvas, text, filename, btns) {
  let blob = null;
  let file = null;
  try {
    blob = await canvasBlob(canvas);
    file = new File([blob], "minna-no-muse-card.png", { type: "image/png" });
  } catch {
    blob = null;
    file = null;
  }

  if (btns.download) {
    btns.download.style.display = blob ? "" : "none";
    btns.download.onclick = () => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    };
  }
  let canShare = false;
  try {
    canShare = !!(file && typeof navigator !== "undefined"
      && typeof navigator.canShare === "function"
      && navigator.canShare({ files: [file] }));
  } catch {
    canShare = false;
  }
  if (btns.native) {
    btns.native.style.display = canShare ? "" : "none";
    btns.native.onclick = async () => {
      if (!canShare) return;
      try {
        await navigator.share({ files: [file], text });
      } catch {
        /* ユーザーがキャンセルした場合などはそのまま */
      }
    };
  }
  if (btns.hint) {
    btns.hint.style.display = "";
    btns.hint.textContent = canShare
      ? "「シェアする」からThreadsアプリを選ぶと、画像そのものを投稿できます。"
      : "このブラウザでは画像ファイルを直接シェアできません。「画像を保存」してから、Threadsアプリで画像を添付して投稿してください。";
  }
  return { text, blob };
}

/**
 * 住民票カードを描画し、共有ボタン群を配線する。
 * 戻り値: { text, blob }（blob は生成できなかった場合 null）。
 */
export async function presentResidentCard(canvas, info, btns = {}) {
  await drawResidentCard(canvas, info);
  const text = buildShareText(info);
  const filename = `minna-no-muse-card-${String(info.noKey ?? "card").slice(0, 8)}.png`;
  return wireShareButtons(canvas, text, filename, btns);
}

/* ================= つぶやきカード ================= */

/* 折り返し：maxWidth に収まる行の配列を返す（改行も尊重する） */
function wrapLines(ctx, text, maxWidth) {
  const lines = [];
  for (const para of String(text ?? "").split("\n")) {
    let line = "";
    for (const ch of para) {
      const t = line + ch;
      if (line && ctx.measureText(t).width > maxWidth) {
        lines.push(line);
        line = ch;
      } else {
        line = t;
      }
    }
    lines.push(line);
  }
  return lines;
}

/**
 * つぶやき（フィード投稿）カードを canvas（1080×1080）に描く。
 * 住民票カードと同じ券面デザイン（クリーム色＋金枠）に、
 * アバター・名前・所在地・時刻・本文を載せる。
 * info: { name, pref, city, text, timeLabel, avatar, hue }
 */
export async function drawPostCard(canvas, info) {
  const S = 1080;
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext("2d");

  /* 背景（住民票カードと同じクリーム色グラデーション＋二重枠） */
  const g = ctx.createLinearGradient(0, 0, 0, S);
  g.addColorStop(0, "#fff9ee");
  g.addColorStop(1, "#fdeed3");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  rr(ctx, 36, 36, S - 72, S - 72, 36);
  ctx.strokeStyle = "#e8a93d";
  ctx.lineWidth = 6;
  ctx.stroke();
  rr(ctx, 58, 58, S - 116, S - 116, 26);
  ctx.strokeStyle = "#d9c08a";
  ctx.lineWidth = 2;
  ctx.setLineDash([14, 10]);
  ctx.stroke();
  ctx.setLineDash([]);

  /* タイトル */
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#35749a";
  ctx.font = `700 44px ${CARD_FONT}`;
  ctx.fillText("みんなのMuse", S / 2, 148);
  ctx.fillStyle = "#2b2b33";
  ctx.font = `900 84px ${CARD_FONT}`;
  ctx.fillText("つ ぶ や き", S / 2, 248);

  /* 投稿の白カード */
  const cx0 = 84, cy0 = 292, cw = S - 168, ch = 596;
  rr(ctx, cx0, cy0, cw, ch, 36);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.strokeStyle = "#e7dcc3";
  ctx.lineWidth = 3;
  ctx.stroke();

  /* アバター（円形クリップ） */
  const avR = 62, avCx = cx0 + 108, avCy = cy0 + 104;
  const img = await loadImage(info.avatar).catch(() => null);
  ctx.save();
  ctx.beginPath();
  ctx.arc(avCx, avCy, avR, 0, Math.PI * 2);
  ctx.clip();
  if (img) {
    if (info.hue !== null && info.hue !== undefined) {
      try { ctx.filter = `hue-rotate(${info.hue}deg)`; } catch {}
    }
    drawCover(ctx, img, avCx - avR, avCy - avR, avR * 2, avR * 2);
    try { ctx.filter = "none"; } catch {}
  } else {
    ctx.fillStyle = "#dceef5";
    ctx.fillRect(avCx - avR, avCy - avR, avR * 2, avR * 2);
    ctx.fillStyle = "#35749a";
    ctx.font = `900 64px ${CARD_FONT}`;
    ctx.textAlign = "center";
    ctx.fillText((info.name || "?").slice(0, 1), avCx, avCy + 22);
  }
  ctx.restore();
  ctx.beginPath();
  ctx.arc(avCx, avCy, avR, 0, Math.PI * 2);
  ctx.strokeStyle = "#e7dcc3";
  ctx.lineWidth = 4;
  ctx.stroke();

  /* 名前・所在地・時刻 */
  ctx.textAlign = "left";
  ctx.fillStyle = "#2b2b33";
  fitFont(ctx, info.name || "", 900, 54, 620);
  ctx.fillText(info.name || "", avCx + avR + 28, avCy - 4);
  const loc = info.city ? `${info.pref} ${info.city}` : `${info.pref}`;
  const sub = info.timeLabel ? `📍 ${loc} ・ ${info.timeLabel}` : `📍 ${loc}`;
  ctx.fillStyle = "#35749a";
  fitFont(ctx, sub, 700, 34, 640);
  ctx.fillText(sub, avCx + avR + 28, avCy + 46);

  /* 本文（収まるまでフォントを縮め、最後は省略する） */
  const bodyX = cx0 + 52, bodyW = cw - 104;
  const topY = cy0 + 240, lineH = 1.55;
  let bodyLines = null, bodySize = 46;
  for (const size of [46, 42, 38, 34]) {
    ctx.font = `500 ${size}px ${CARD_FONT}`;
    const lines = wrapLines(ctx, info.text, bodyW);
    if (lines.length * size * lineH <= ch - 280) { bodyLines = lines; bodySize = size; break; }
    bodyLines = lines; bodySize = size;
  }
  const maxLines = Math.max(1, Math.floor((ch - 280) / (bodySize * lineH)));
  if (bodyLines.length > maxLines) {
    bodyLines = bodyLines.slice(0, maxLines);
    const last = bodyLines[bodyLines.length - 1];
    bodyLines[bodyLines.length - 1] = last.length > 1 ? last.slice(0, -1) + "…" : "…";
  }
  ctx.font = `500 ${bodySize}px ${CARD_FONT}`;
  ctx.fillStyle = "#2b2b33";
  bodyLines.forEach((ln, i) => ctx.fillText(ln, bodyX, topY + i * bodySize * lineH));

  /* フッター（サイト表記） */
  ctx.textAlign = "center";
  ctx.fillStyle = "#b08d3e";
  ctx.font = `700 34px ${CARD_FONT}`;
  ctx.fillText("muse.solo-guild.xyz", S / 2, 1006);

  return canvas;
}

/**
 * つぶやきカードを描画し、共有ボタン群を配線する。
 * 戻り値: { text, blob }（blob は生成できなかった場合 null）。
 */
export async function presentPostCard(canvas, info, btns = {}) {
  await drawPostCard(canvas, info);
  const text = buildPostShareText(info);
  return wireShareButtons(canvas, text, "minna-no-muse-post.png", btns);
}
