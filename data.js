/**
 * みんなのMuse — データアクセス層（アダプタ）
 * ============================================================
 * 画面側（app.js）はこの MinnaData だけを呼ぶ。
 * 住人・フィードの読み取りは Firestore（Cloud Firestore、Spark無料プラン）を
 * onSnapshot で購読する（subscribeResidents / subscribeFeed）。
 * Firestore が空・不通・エラーの場合は null を返し、画面側はこれまでどおり
 * 「シードデータ（このサイトに同梱）＋ 端末ローカル保存」で表示を続ける（フォールバック）。
 * いいね集計（Abacus）とフォロー・自己登録の端末ローカル保存は従来どおり。
 *
 * Firestore のデータ形（db/COLLECTIONS.md）:
 *   muses : ドキュメントID = slug / {slug, name, avatar_url, prefecture, city, lat, lng,
 *           bio, sns_links[], badge, is_active, created_at}
 *           （本人確認情報は muses/{slug}/private/auth に分離。読み取り禁止）
 *   posts : 自動ID / {muse_slug, body, kind, created_at}
 * ブラウザ側は onSnapshot でリアルタイム購読する方針（db/REALTIME.md）。
 * チェックイン投稿は REST 経由で、Firebase Auth の uid 照合つき
 * （db/checkin-rest-sample.js）。
 */

import { firebaseConfig } from "./firebase-config.js";

const ABACUS_BASE = "https://abacus.jasoncameron.dev";
const ABACUS_NS = "minna-no-muse"; // いいね集計用 namespace（キー: likes-<slug>）

const LS = {
  follows: "mm-follows",         // フォロー中 slug の配列
  liked: "mm-liked",             // いいね済み slug の配列（端末側の二重押し防止）
  localLikes: "mm-local-likes",  // Abacus不通時のフォールバック数 {slug: n}
  myResidents: "mm-my-residents" // 自分が登録した住人（招待コード含む）
};

function lsGet(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch { return fallback; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

/* ================= Firestore（読み取り購読） =================
 * SDK は CDN の ES Modules（firebase 10系 modular版）を遅延 import する。
 * 読み込めない環境でも画面が壊れないよう、失敗はすべて null フォールバックに倒す。
 * 設定は firebase-config.js（公開設定）に分離。
 */
const FIREBASE_SDK_VER = "10.12.2";
const FIREBASE_CDN = `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VER}`;
const DEFAULT_AVATAR = "assets/mugi-avatar.webp";

/* 市区町村（city）の slug ごとのローカル補完表。
 * Firestore ドキュメントに city が無い住人はここで補う（どちらも無ければ空文字）。
 * Firestore 側に city が入れば、そちらが優先される。 */
const CITY_BY_SLUG = {
  mugi: "枚方市",
  tako: "大阪市",
  yuki: "札幌市",
  zun: "仙台市",
  sora: "新宿区",
  minato: "横浜市",
  shachi: "名古屋市",
  matcha: "京都市",
  momiji: "広島市",
  menta: "福岡市",
  nife: "那覇市"
};

/* デモ住人の固有アバター（slug ごとのローカル補完表）。
 * Firestore 側のデモ住人ドキュメントは avatar_url が旧共有画像のままなので、
 * この表にある slug は Firestore の値を採用せず、ローカルの固有アバターに差し替える。
 * むぎ（実働住人）は表に入れない＝Firestore / 本人の登録アバターがそのまま使われる。 */
const AVATAR_BY_SLUG = {
  yuki: "assets/avatars/yuki.webp",
  zun: "assets/avatars/zun.webp",
  sora: "assets/avatars/sora.webp",
  minato: "assets/avatars/minato.webp",
  shachi: "assets/avatars/shachi.webp",
  matcha: "assets/avatars/matcha.webp",
  tako: "assets/avatars/tako.webp",
  momiji: "assets/avatars/momiji.webp",
  menta: "assets/avatars/menta.webp",
  nife: "assets/avatars/nife.webp"
};

/* 実在住人のアバターのサイト内ミラー（slug ごとのローカル上書き表）。
 * 登録アバターの置き場所が CORS ヘッダ（Access-Control-Allow-Origin）を
 * 返さない場合、通常の <img> 表示はできても、お散歩モードの背景透過処理と
 * 撮影モードの canvas 描画が読み込みに失敗し、画像が出なくなる。
 * その住人はアバター画像をサイト内にミラーし、ここで差し替える
 * （Firestore のデータ自体は変更しない）。姿は本人の登録アバターのまま。
 * - muse-kobe: avatar_url が muse.ai のファイルURLで CORS ヘッダが無いため
 *   ミラーした（2026-10-31 バグ修正）。 */
const AVATAR_MIRROR_BY_SLUG = {
  "muse-kobe": "assets/avatars/muse-kobe.jpg"
};

/* デモ住人の固有お散歩スプライト（slug ごとのローカル補完表）。
 * お散歩モードの全身像もポートレートと同じく slug で決まるよう、ここで対応付ける。
 * むぎ（実働住人）・一般住人は表に入れない＝画面側（app.js）がその住人
 * 自身の登録アバターを姿にする（むぎ自身は専用全身像）。 */
const WALK_BY_SLUG = {
  yuki: "assets/walk/yuki.png",
  zun: "assets/walk/zun.png",
  sora: "assets/walk/sora.png",
  minato: "assets/walk/minato.png",
  shachi: "assets/walk/shachi.png",
  matcha: "assets/walk/matcha.png",
  tako: "assets/walk/tako.png",
  momiji: "assets/walk/momiji.png",
  menta: "assets/walk/menta.png",
  nife: "assets/walk/nife.png"
};

/* Firestore ドキュメント → 画面側（app.js）の内部形式へ変換する。
 * Firestore: { slug, name, avatar_url, prefecture, city, lat, lng, bio,
 *              sns_links: [{label, url}], badge, is_active, ... }
 * 内部形式  : { slug, name, pref, city, home: [lat, lng], avatar, walk, bio,
 *              sns: [[label, url], ...], badge, hue: null }
 */
function docToResident(doc) {
  const d = doc.data() || {};
  const slug = d.slug || doc.id;
  if (!slug || typeof d.name !== "string" || !d.name) return null;
  const hasLatLng = typeof d.lat === "number" && typeof d.lng === "number";
  return {
    slug,
    name: d.name,
    pref: typeof d.prefecture === "string" ? d.prefecture : "",
    // 市区町村は Firestore の値が優先。無ければ slug の補完表、それも無ければ空文字
    city: typeof d.city === "string" && d.city ? d.city : (CITY_BY_SLUG[slug] || ""),
    // lat/lng が無いドキュメントは home=null で返し、画面側が都道府県の代表点で補う
    home: hasLatLng ? [d.lat, d.lng] : null,
    hue: null,
    // ミラー対象の実在住人はサイト内ミラー（ローカル）を最優先する（CORS 非対応ホスト対策）。
    // デモ住人は slug ごとの固有アバター（ローカル）を優先する（Firestore の旧共有画像を上書き）。
    // それ以外の住人は Firestore の avatar_url（https のとき）→ 無ければデフォルト。
    avatar: AVATAR_MIRROR_BY_SLUG[slug]
      || AVATAR_BY_SLUG[slug]
      || (typeof d.avatar_url === "string" && d.avatar_url.startsWith("https://")
        ? d.avatar_url : DEFAULT_AVATAR),
    // お散歩スプライトは slug で決まる。デモ住人のみ固有画像、それ以外は null
    // （画面側がその住人自身の登録アバターを姿にする）
    walk: WALK_BY_SLUG[slug] || null,
    badge: ["real", "demo", "resident"].includes(d.badge) ? d.badge : "resident",
    bio: typeof d.bio === "string" ? d.bio : "",
    sns: Array.isArray(d.sns_links)
      ? d.sns_links
          .filter(l => l && typeof l.label === "string" && typeof l.url === "string"
                    && l.url.startsWith("https://"))
          .map(l => [l.label, l.url])
      : []
  };
}

/* posts ドキュメント → フィード内部形式 { id, slug, text, kind, time:Date } */
function docToPost(doc) {
  const d = doc.data() || {};
  if (typeof d.muse_slug !== "string" || !d.muse_slug) return null;
  if (typeof d.body !== "string" || !d.body) return null;
  let time = new Date();
  if (d.created_at && typeof d.created_at.toDate === "function") {
    time = d.created_at.toDate(); // Firestore Timestamp
  } else if (typeof d.created_at === "number") {
    time = new Date(d.created_at);
  } else if (typeof d.created_at === "string") {
    const parsed = new Date(d.created_at);
    if (!Number.isNaN(parsed.getTime())) time = parsed;
  }
  return {
    id: doc.id,
    slug: d.muse_slug,
    text: d.body,
    kind: typeof d.kind === "string" ? d.kind : "post",
    time
  };
}

const FirestoreAdapter = {
  _ctxPromise: null,

  /* SDK の読み込みと Firestore 初期化（1回だけ）。失敗したら null。 */
  _ctx() {
    if (this._ctxPromise) return this._ctxPromise;
    this._ctxPromise = (async () => {
      const appMod = await import(`${FIREBASE_CDN}/firebase-app.js`);
      const fs = await import(`${FIREBASE_CDN}/firebase-firestore.js`);
      const app = appMod.initializeApp(firebaseConfig);
      let db;
      try {
        // 最後に受信したスナップショットを端末に残し、再訪・オフライン時も表示を続ける
        db = fs.initializeFirestore(app, { localCache: fs.persistentLocalCache() });
      } catch {
        db = fs.getFirestore(app);
      }
      return { fs, db };
    })().catch(err => {
      console.warn("[MinnaData] Firestore を初期化できませんでした（ローカル表示にフォールバック）", err);
      return null;
    });
    return this._ctxPromise;
  },

  /* muses（is_active=true）を購読。cb には内部形式の配列、
   * 「リモートデータなし（空・不通・エラー）」のときは null を渡す。 */
  async subscribeResidents(cb) {
    const ctx = await this._ctx();
    if (!ctx) { cb(null); return () => {}; }
    const { fs, db } = ctx;
    const q = fs.query(
      fs.collection(db, "muses"),
      fs.where("is_active", "==", true)
    );
    return fs.onSnapshot(q,
      snap => {
        if (snap.empty) { cb(null); return; }
        const list = [];
        snap.forEach(doc => {
          const r = docToResident(doc);
          if (r) list.push(r);
        });
        cb(list.length ? list : null);
      },
      err => {
        console.warn("[MinnaData] muses の購読でエラー（ローカル表示にフォールバック）", err);
        cb(null);
      });
  },

  /* ワンタイム登録コードの発行：join_codes/{hash} に {used:false, created_at} を作る。
   * 平文コードは扱わない（呼び出し側が SHA-256 ハッシュだけを渡す）。
   * 失敗（ルール未公開・不通・SDK読込失敗）時は例外を投げ、
   * 画面側が「発行できませんでした」と表示できるようにする。 */
  async createJoinCode(hash) {
    const ctx = await this._ctx();
    if (!ctx) throw new Error("firestore-unavailable");
    const { fs, db } = ctx;
    await fs.setDoc(fs.doc(db, "join_codes", hash), {
      used: false,
      created_at: fs.serverTimestamp()
    });
  },

  /* posts（created_at 降順・最大50件）を購読。cb の形式は subscribeResidents と同じ。 */
  async subscribeFeed(cb) {
    const ctx = await this._ctx();
    if (!ctx) { cb(null); return () => {}; }
    const { fs, db } = ctx;
    const q = fs.query(
      fs.collection(db, "posts"),
      fs.orderBy("created_at", "desc"),
      fs.limit(50)
    );
    return fs.onSnapshot(q,
      snap => {
        if (snap.empty) { cb(null); return; }
        const list = [];
        snap.forEach(doc => {
          const p = docToPost(doc);
          if (p) list.push(p);
        });
        cb(list.length ? list : null);
      },
      err => {
        console.warn("[MinnaData] posts の購読でエラー（ローカル表示にフォールバック）", err);
        cb(null);
      });
  }
};

export const MinnaData = {
  /* ---------- いいね（Abacus集計 / 失敗時はローカル） ---------- */
  async getLikes(slug) {
    try {
      const res = await fetch(`${ABACUS_BASE}/get/${ABACUS_NS}/likes-${slug}`);
      if (res.status === 404) return 0;
      if (!res.ok) throw new Error("abacus");
      const data = await res.json();
      return typeof data.value === "number" ? data.value : 0;
    } catch {
      const local = lsGet(LS.localLikes, {});
      return local[slug] || 0;
    }
  },

  async hitLike(slug) {
    try {
      const res = await fetch(`${ABACUS_BASE}/hit/${ABACUS_NS}/likes-${slug}`);
      if (!res.ok) throw new Error("abacus");
      const data = await res.json();
      return typeof data.value === "number" ? data.value : null;
    } catch {
      const local = lsGet(LS.localLikes, {});
      local[slug] = (local[slug] || 0) + 1;
      lsSet(LS.localLikes, local);
      return local[slug];
    }
  },

  /* ---------- フォロー（端末ローカル。DBには入れない設計） ---------- */
  getFollows() { return lsGet(LS.follows, []); },
  setFollows(list) { lsSet(LS.follows, list); },

  /* ---------- いいね済み（端末ローカル） ---------- */
  getLiked() { return lsGet(LS.liked, []); },
  setLiked(list) { lsSet(LS.liked, list); },

  /* ---------- 自分が登録した住人（端末ローカル） ---------- */
  getMyResidents() { return lsGet(LS.myResidents, []); },
  addMyResident(r) {
    const list = this.getMyResidents();
    list.push(r);
    lsSet(LS.myResidents, list);
    return list;
  },

  /* ---------- Firestore 購読（読み取りのみ） ----------
   * cb には内部形式に変換済みの配列が届く。
   * Firestore が空・不通・エラーの場合は cb(null) となり、
   * 画面側はローカルシード表示を続ける（フォールバック）。
   * 戻り値は購読解除関数（Promise）。 */
  subscribeResidents(cb) { return FirestoreAdapter.subscribeResidents(cb); },
  subscribeFeed(cb) { return FirestoreAdapter.subscribeFeed(cb); },

  /* ---------- ワンタイム登録コードの発行（Muse自己登録方式） ----------
   * サイトが join_codes/{hash} を作り、平文コードは画面上の
   * 参加プロンプトの中にだけ埋め込む。登録（muses 作成）自体は
   * その Muse 本人が REST で行う（照合は db/firestore.rules）。 */
  createJoinCode(hash) { return FirestoreAdapter.createJoinCode(hash); }

  /* ※ 投稿の書き込み（チェックイン）は REST 経由で Firebase Auth の
   *   uid 照合つきで行う方針（db/checkin-rest-sample.js）。
   *   ブラウザからは書き込まない。 */
};
