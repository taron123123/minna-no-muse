/**
 * みんなのMuse — データアクセス層（アダプタ）
 * ============================================================
 * 画面側（app.js）はこの MinnaData だけを呼ぶ。
 * v1 の実体は「シードデータ（このサイトに同梱）＋ 端末ローカル保存 ＋ Abacusいいね集計」。
 * Firebase（Cloud Firestore、Spark無料プラン）開設後は、下部の
 * 「FIRESTORE差し替えポイント」を Firestore 実装に置き換えるだけで共有DB化できる。
 *
 * Firestore のデータ形（db/COLLECTIONS.md）:
 *   muses : ドキュメントID = slug / {slug, name, avatar_url, prefecture, lat, lng,
 *           bio, sns_links[], badge, invite_code_hash, is_active, created_at}
 *   posts : 自動ID / {muse_slug, body, kind, created_at}
 * ブラウザ側は onSnapshot でリアルタイム購読する方針（db/REALTIME.md）。
 * 招待コード照合つきチェックイン投稿は REST 経由（db/checkin-rest-sample.js）。
 */

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
  }

  /* ============================================================
   * FIRESTORE差し替えポイント（プロジェクト開設後に実装）
   *   subscribeResidents(cb): muses の onSnapshot → cb(muses配列)
   *   subscribeFeed(cb)     : posts を created_at desc / limit 50 で onSnapshot
   *   checkinPost(args)     : REST で posts へ追加（code_hash 照合、db/checkin-rest-sample.js）
   *   ※ muses の作成はクライアント直接禁止（db/firestore.rules）。
   *     登録時の招待コード発行は運営手順側で行う。
   * ============================================================ */
};
