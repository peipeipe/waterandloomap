# Water & Loo Map

OpenStreetMap と Overpass API を利用して、現在地周辺の水飲み場・蛇口・トイレを探せる完全クライアントサイドの地図アプリです。

PC・スマートフォンともブラウザ全画面で動作するレスポンシブWebアプリです。

## ローカル起動

```bash
cd app
npm install
npm run dev
```

## Cloudflare Pages

- Root directory: `app`
- Build command: `npm run build`
- Build output directory: `dist/client`

バックエンドやAPIキーは不要です。地図表示にはOpenStreetMap、スポット取得には公開Overpass APIを使用します。
