# CLAUDE.md

このリポジトリで作業する Claude 向けの指示。

## まず読む

**md は [`README.md`](README.md) の 1 本に集約した。** セッションは頻繁に
切り替わるので、開始時に README.md を上から読む:

- 「現状」節（今どこまで / 何が動く）
- 「信号フロー」「設計の不変条件」「VRAM 上限」「ネイティブオーディオ」
- 「環境の落とし穴」
- 末尾「セッションログ」の最新エントリ

セッション終了時は README.md 末尾の**「セッションログ」に新エントリを追記**する
（テンプレはログ先頭）。旧 `docs/ARCHITECTURE.md` / `docs/SESSION.md` は廃止。

## コマンド

| 目的 | コマンド |
| --- | --- |
| 開発起動（HMR） | `npm run dev` |
| 型チェック（コミット前必須） | `npm run typecheck` |
| 本番ビルド | `npm run build` |
| ビルド済み起動 | `npm run preview` |
| ヘッドレス確認 | `DAW_SELFTEST=1 npm run dev`（`resample` でリサンプラ経路） |
| AI 回帰（内蔵 MCP） | `npm run dev:mcp` → `.mcp.json` の `awaker`（`bounce` で数値回帰、`transport record_start synthetic:true` で録音回帰） |

## 環境の落とし穴（重要）

- **`ELECTRON_RUN_AS_NODE=1`** がこの端末（Claude Code / VSCode 統合ターミナル）
  に設定されている。これがあると Electron が素の Node として起動し
  `app` / `BrowserWindow` が `undefined` になる。
  → `npm run dev` / `preview` は `scripts/run.mjs` 経由でこの変数を削除してから
  electron-vite を起動している。**`package.json` の scripts を
  `electron-vite dev` に戻さないこと。**
- **`package.json` に `"type": "module"` を付けない。** 付けると Electron が
  main を ESM ロードし `import ... from "electron"` の CJS preparse で落ちる。
  main/preload は CJS 出力、renderer だけ Vite が ESM でバンドルする。
- `src/main/index.ts` の `preload:` パスは `../preload/index.js`（`.mjs` ではない）。
- `index.html` の CSP は `'self'` 限定。外部 CDN 不可、ライブラリはバンドルする。
- `enable-features=Vulkan` を付けない（Vulkan 無し環境で WebGPU がデバイスロスト）。
- install-scripts ブロック環境。ネイティブ依存を足したら prebuilt を手動取得。
- renderer の `console.log` は detached DevTools 行き。main の `console.log` は
  ターミナル stdout に出る。

## 設計上の不変条件（崩さない）

- **オーディオデータの正は GPU の VRAM**（`GPUBuffer`、float32、**プレーナ**ch 毎）。
  CPU 側にサンプル配列のコピーを残さない。例外は `wav.ts` のデコード、
  `resample-gpu.ts` の係数表、マスターの再生用読み戻しだけ。
  ※ 100 トラック対応でこの不変条件を「RAM 常駐 + VRAM 再生窓」へ改訂する案が
  ある（README「VRAM 上限」）。改訂はユーザー合意の上で。
- 一般的な Web Audio 録音・再生は使わない。パラレルトラック → GPGPU（renderer の
  WebGPU）→ ステレオマスター → 読み戻し → **main のネイティブ出力
  （RtAudio → ASIO）**。録音は逆。
- オーディオデバイス I/O とディスク I/O は **main のみ**。renderer は GPGPU + UI +
  先読みスケジューラ。
- マスターは常にステレオ。トラックは mono/stereo 選択可（`GpuTrack.channelCount`）。
  インターリーブは main 境界だけ、内部はプレーナ。
- パン/ズームでサンプル・ピークに再アクセスしない。描画用ユニフォームだけ更新。
- WGSL は `src/renderer/src/gpu/shaders.ts` に文字列で集約。
- レンダラはフレームワーク非依存を維持（`state.ts` は最小の observable）。
- 32-bit float 固定（内部・renderer↔main・デバイス）。int 変換は `wav.ts` のみ。
- プロジェクト SR は固定・既定 96 kHz。読込時に GPU ポリフェーズ FIR で projSR へ。
- GPU を遊ばせない: 大きなバッチ dispatch、プレーナでコアレスド、チャンク
  読み戻し、パイプライン/バインドグループのキャッシュ。

## 現在フェーズ

**Phase 0 完了 → DAW の骨格づくり。** GPGPU 再生経路（ファイル → VRAM → GPGPU
マスター → 読み戻し → ネイティブ ASIO/WASAPI 出力）は実機で鳴っている。
マルチトラック mix・レーン UI・複数ファイル読込・マスターフェーダー・GPU
リサンプラまで実装済み。詳細と次の一手は `README.md`。

## コードスタイル

- 周囲のコードに合わせる。コメントは「なぜ」を簡潔に。日本語 / 英語混在可。
- 新しい依存を足す前に本当に必要か検討する（特に renderer / GPU 層）。
