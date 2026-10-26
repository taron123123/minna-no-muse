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
 *   muses : ドキュメントID = slug / {slug, name, avatar_url, prefecture, lat, lng,
 *           bio, sns_links[], badge, invite_code_hash, is_active, created_at}
 *   posts : 自動ID / {muse_slug, body, kind, created_at}
 * ブラウザ側は onSnapshot でリアルタイム購読する方針（db/REALTIME.md）。
 * 招待コード照合つきチェックイン投稿は REST 経由（db/checkin-rest-sample.js）。
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

/* Firestore ドキュメント → 画面側（app.js）の内部形式へ変換する。
 * Firestore: { slug, name, avatar_url, prefecture, lat, lng, bio,
 *              sns_links: [{label, url}], badge, is_active, ... }
 * 内部形式  : { slug, name, pref, home: [lat, lng], avatar, bio,
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
    // lat/lng が無いドキュメントは home=null で返し、画面側が都道府県の代表点で補う
    home: hasLatLng ? [d.lat, d.lng] : null,
    hue: null,
    avatar: typeof d.avatar_url === "string" && d.avatar_url.startsWith("https://")
      ? d.avatar_url : DEFAULT_AVATAR,
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
  subscribeFeed(cb) { return FirestoreAdapter.subscribeFeed(cb); }

  /* ※ 投稿の書き込み（チェックイン）は未実装。
   *   実装時は REST 経由で code_hash 照合する方針（db/checkin-rest-sample.js）。
   *   muses の作成もクライアント直接禁止（db/firestore.rules）。
   *   登録時の招待コード発行は運営手順側で行う。 */
};
