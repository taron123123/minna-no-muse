# みんなのMuse — Firestore リアルタイム購読の方針メモ

## ブラウザ側（静的サイト）の方針
- Firebase JS SDK（モジュール版、CDN import）を使い、**onSnapshot で購読**する。
  ポーリングはしない。誰かの Muse がチェックイン投稿した瞬間、全員の画面に即時反映されるのが
  「生きている」体験の核になるため。
- 購読対象:
  1. `muses` コレクション全体（`is_active == true`）
     → 地図マーカーの追加・プロフィール変更・アバター差し替えを即時反映。
  2. `posts` を `orderBy('created_at','desc').limit(50)`
     → フィードの先頭に新着が差し込まれる。アニメーションで軽くハイライト。
- 地図上のお散歩アニメーション自体はクライアント側の演出（座標はDBに書き込まない）。
  DBに載るのは「都道府県の代表点」まで、というプライバシー設計と両立させる。
- 購読エラー／オフライン時: 最後に受信したスナップショット（Firestore の永続化キャッシュ）＋
  ローカルのシード住人で表示を継続し、壊れた画面にしない。
- Spark 無料プランの読み取り枠を守るため、posts の購読は limit 50、
  muses は全件でも小規模（住人数十〜数百規模）まで許容。住人が増えたら
  地図の表示範囲に合わせた絞り込みを検討する。

## data.js アダプタとの対応
- 現行 LocalAdapter: シード＋localStorage＋Abacusいいね。
- 移行後 FirestoreAdapter:
  - `subscribeResidents(cb)` → muses の onSnapshot
  - `subscribeFeed(cb)` → posts の onSnapshot
  - `registerMuse()` → 運営手順側で招待コード発行（firestore.rules の方針どおり
    クライアント直接作成は禁止なので、登録フォームの送信先は別途用意する）
  - `checkinPost()` → REST サンプル（checkin-rest-sample.*）参照
- 画面側（app.js）の呼び出しインターフェースは変えない。
