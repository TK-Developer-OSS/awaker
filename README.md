# Awaker DAW over GPU

**GPGPU オリエンテッドな DAW。**（旧称 gpudaw / npm パッケージ名 `awaker` /
内部 app 名 `awaker`）オーディオデータの実体を GPU の VRAM に置き、
パラレルトラックを GPGPU（WebGPU コンピュート）で処理して**ステレオマスター**に
まとめ、**ネイティブ出力ドライバ（RtAudio / ASIO・WASAPI）**で再生する。録音は
その逆（未実装）。一般的な Web Audio の録音・再生経路は使わない。GUI は
スタンドアロンの Electron + TypeScript（VSCode 的構成）。

---

## 🔁 セッション再開手順

> **md はこの 1 本に集約した**（旧 `docs/ARCHITECTURE.md` / `docs/SESSION.md` は
> 廃止）。このファイルを上から読めば足りる。`CLAUDE.md` は不変条件と環境の
> 落とし穴だけの短い版で、ハーネスが毎セッション自動ロードする。

1. **現状** … すぐ下の「現状」節。
2. **設計** … 「信号フロー」「不変条件」「VRAM 上限」「ネイティブオーディオ」。
3. **落とし穴** … 「環境の落とし穴」節。
4. **動かす** … `npm run dev`（起動時にテストベッドのパラデータを自動ロード）。
5. **型チェック** … `npm run typecheck`（コミット前に必ず）。
6. **作業したら** … このファイル末尾の**「セッションログ」に 1 エントリ追記**して
   から終わる（テンプレはログの先頭）。

> **ユーザーへの確認・質問は ntfy にも投げる**（ユーザーは別端末で見ている）:
> `https://ntfy.sh/tk-development-oss` へ POST。日本語本文は JSON を一時ファイルに
> 書いて `curl -H "Content-Type: application/json" --data-binary @file https://ntfy.sh/`
> （`{"topic":"tk-development-oss","title":"…","message":"…"}`）。`-d` 直書きは
> マルチバイトが添付ファイル扱いになるので不可。


---

## 鉄の起きて

日本語で回答すること


---

## 現状（2026-09-06 時点、実機確認済み）

Phase 0（GPGPU 再生経路）は実機で鳴っている。以降は DAW の骨格づくり。

- **出力**: `audify`(RtAudio) の **ASIO** を自動選択（Antelope / Zen Go を検出。
  無ければ WASAPI 排他 → 共有にフォールバック）。ASIO SDK は audify 1.10.1 の
  Windows prebuilt に**同梱**されておりソースビルド不要。開発機で Zen Go を
  **ネイティブ 192 kHz** でオープン確認。`DAW_AUDIO_API` / `DAW_AUDIO_DEVICE` で
  上書き可。
- **プロジェクトレート固定**（既定 **96 kHz**、選択 44.1/48/96/192、トラック
  投入でロック）。192 kHz は 1 トラック VRAM 2 倍なので大容量 VRAM / 少トラック
  向けの選択肢。読込 WAV は **GPU ポリフェーズ FIR**（`gpu/resample-gpu.ts` +
  `RESAMPLE_WGSL`、64 tap × 512 phase、Blackman-Harris、実測オーバーシュート
  0 dB）でプロジェクトレートへ変換しながら VRAM へ書く。旧 CPU Catmull-Rom は
  撤去（ホットなマスターを ~+1 dB 持ち上げていた）。`INTERLEAVE_WGSL` が
  マスターを ±1 にハードクランプ（最終段）。
- **マルチトラック**: `GpuTrack[]` を `MASTER_WGSL` でトラック毎に 1 パス
  走らせて planar マスターへ加算（track 0 = 書き、以降 = accumulate）。
  1 エンコーダ / 1 submit。マスターフェーダー（ミキサー右端、既定 **-10 dB**、
  `MasterBus.masterGain`）。
- **GUI 骨格**: トランスポート（Play/Stop/クロック/＋Add Track/Project レート/
  メトリクス）＋上下左右の空ペイン＋中央にトラックレーン（高さ 100px、
  左＝番号+ファイル名、中央＝波形、右＝予約）。波形はダーク／ブライトの
  エメラルド。Add Track ウィザードで **複数 WAV を一括選択 → 本数ぶんレーン**、
  トラック名はファイル名から自動。
- **テストベッド自動ロード**（当面）: 起動時に
  `C:\Users\****\Documents\リファレンス音源\MoniBlue_AprilBlues` の WAV を
  全部トラックとして読み込む。`DAW_AUTOLOAD=<dir>` で差し替え、`DAW_AUTOLOAD=`
  （空）で無効化。`?selftest` 起動時は自動ロードしない。
- **再生中 GPU 負荷対策**: 波形は dirty 時＋画面内レーンのみ再描画（定常再生中は
  0 サブミット）。先読みブロック 32768 フレーム（読み戻し ~6 回/秒）、
  staging / bindgroup / スクラッチ配列を使い回し。main の ring コピーは memcpy 化。
  実測: 24 トラック / 96 kHz 再生で GPU ~7%、専用 VRAM ~1.6 GB。
- **インサート**: `Insert` 契約 + フローティングプラグインウィンドウで配線済み。
  トラックラック（Reverb / Delay / 5-band EQ / Awaker Enhancer）+ マスターラック。
  マスター専用に **Bus Comp**（SSL G 系 + 明るめ倍音 Drive）と **Maximizer**
  （ルックアヘッド brickwall + LUFS メーター）。LUFS は scheduler がマスター
  読み戻しから **BS.1770-4 K 特性**（libebur128 の解析係数、SR 非依存）で算出
  （Momentary / Short-term / **Integrated**（ゲーティング付き）/ Maximum、
  マスターストリップに Short-term、Maximizer 窓に全 4 項）。
- **未着手（重い）**: 100 トラックはこの VRAM 常駐方式だと容量が壁（8 GB で
  ~90 トラック分 @96k）。本命は「VRAM 上限」節参照。

---

## ライセンス

**Apache License 2.0**（`LICENSE` / `NOTICE`）。著作権表示を残せば商用含め自由に
利用・改変・再配布できる。派生物の開示強制（copyleft）はない。MIT ではなく
Apache-2.0 を選んだのは、**明示的な特許ライセンス付与 + 特許報復条項**があるため
（この project は既存特許を意識して DSP を設計している）。

コントリビューションは Apache-2.0 §5 により自動的に同ライセンス扱い。CLA は課さ
ない。任意で DCO（`git commit -s` の `Signed-off-by`）を推奨。

---

## コマンド

| 目的 | コマンド |
| --- | --- |
| 開発起動（HMR） | `npm run dev`（`scripts/run.mjs` 経由。`ELECTRON_RUN_AS_NODE` を外す） |
| 型チェック（コミット前必須） | `npm run typecheck` |
| 本番ビルド | `npm run build`（`out/` に main/preload/renderer） |
| ビルド済み起動 | `npm run preview` |
| ヘッドレス確認 | `DAW_SELFTEST=1 npm run dev`（`resample` でリサンプラ経路も） |
| AI 回帰用（MCP サーバー有効） | `npm run dev:mcp`（`http://127.0.0.1:7777/mcp`、`DAW_MCP_PORT` で変更。リポジトリ直下の `.mcp.json` で Claude Code から接続） |

必要環境: Node 20+（開発は Node 24 / npm 11）、WebGPU が動く GPU/ドライバ
（開発機は RTX 3060 Ti / Windows 11）、ネイティブオーディオ出力デバイス。

---

## 信号フロー（再生）

```
[main / Node.js]                         [renderer / Chromium + WebGPU]
 ファイル選択 (dialog, multi) / autoload
 readFile(WAV) ──IPC(bytes, 1本ずつ)────▶ decodeWav (CPU 1回)
                                            │ GPU ポリフェーズ FIR で projSR へ
                                            ▼ 変換しながら writeBuffer（ch 毎）
                              GpuTrack.channels[0..N]  GPUBuffer<f32>（プレーナ）
                                            │
                              MasterBus: トラック毎に MASTER_WGSL を 1 パス
                                gain/pan/masterGain で planar マスターへ加算
                                → INTERLEAVE_WGSL（±1 クランプ + interleave）
                                → copyBufferToBuffer → mapAsync 読み戻し
                                            │ IPC: daw:audio:chunk（数十 KB）
      ┌─────────────────────────────────────┘
      ▼
 audio-out.ts（RtAudio: ASIO → WASAPI 排他 → 共有）
   インターリーブ f32 ステレオのリングバッファへ書き込み
   frameOutputCallback がリングから 1 デバイスブロックずつ出力
   100ms 毎に daw:audio:status（リング充填量 / underrun）を renderer へ

 再生ヘッド位置 = main 報告の「出力済みフレーム数」を performance.now() 補間
 （AudioContext は使わない）
```

先読み: `BLOCK_FRAMES` 32768 フレーム単位、目標 `TARGET_LOOKAHEAD_S` 0.5s。
`mapAsync` はデバイスコールバック内で呼べないのでスケジューラが先読みで
GPU 処理 → 読み戻し → main のリングへ供給する。

**録音（実装済み 2026-10-03）**: ASIO は 1 ドライバ 1 クライアントなので出力と
**同一 RtAudio ストリームのデュプレックス**で入力を開く（`audio-out.ts`、
`inputChannels` 指定時のみ）。入力コールバック → main で ~8k フレームにバッチ →
IPC `daw:rec:chunk` → renderer の `Recorder`（`audio/recorder.ts`）が armed
トラックごとの VRAM バッファ（30 s 開始・倍々で伸長）へ `writeBuffer`。
Stop で `GpuTrack.adoptRecorded` → 読み戻し → main が 32f WAV を
`userData/recordings/` へ書き出し → AudioSource（path 付き）+ クリップ化
（1 回の Undo。重なる既存クリップは `clearRange` で置換）。**録音中は VRAM のみ**
（停止時にまとめて書き出す方針のため、録音中のクラッシュは take 全損）。
モニタリングは **Zen Go のダイレクトモニター（ハード側）** を使う前提で、ソフト
モニターは持たない。

---

## 設計の不変条件（崩さない）

- **オーディオデータの正は GPU の VRAM**（`GPUBuffer`、float32、**プレーナ** ch 毎）。
  CPU 側にサンプル配列のコピーを残さない。例外は `wav.ts` のデコード（直後に
  `writeBuffer` して破棄）、`resample-gpu.ts` の係数表生成（小さい）、
  マスターの再生用読み戻し（先読みスケジューラ）だけ。
- 一般的な Web Audio 録音・再生は使わない。信号は パラレルトラック → GPGPU
  （renderer の WebGPU）→ ステレオマスター → 読み戻し → **main のネイティブ出力
  （RtAudio → ASIO）**。録音は逆。
- ASIO/WASAPI は renderer から叩けない。**オーディオデバイス I/O は main のみ**。
  ディスク I/O も main のみ。renderer は GPGPU + UI + 先読みスケジューラ。
- マスターは常にステレオ。トラックは mono/stereo 選択可（`GpuTrack.channelCount`
  = 1|2）。インターリーブは main 境界だけ、内部はプレーナ。MasterBus が
  mono→stereo を pan law で up-mix。
- パン/ズームでサンプル・ピークに再アクセスしない。描画用ユニフォームだけ更新。
- WGSL は `src/renderer/src/gpu/shaders.ts` に文字列で集約。
- レンダラはフレームワーク非依存を維持（`state.ts` は最小の observable）。
- GPU を遊ばせない: 大きなバッチ dispatch、プレーナでコアレスド、チャンク
  読み戻し、パイプライン/バインドグループのキャッシュ、`timestamp-query` で計測。
- 32-bit float 固定（内部・renderer↔main・デバイス）。int 変換は `wav.ts` のみ。

**逃げ道（CUDA / Vulkan ネイティブ）**: WebGPU は 1 キュー・共有メモリ 16KB・
Tensor/cuFFT 不可。将来 profiling で特定カーネル（畳み込みリバーブ、音源分離、
ML 系）が GPU バウンドと分かったら **そのカーネルだけ** main 側の CUDA/Vulkan
アドオンへ。出力はもともと main なので構造上そのまま合流。全体を CUDA にはしない。

---

## サンプルレート / フォーマット / リサンプラ

- **内部処理は float32**（GPU）。`f16` は精度が許すカーネルで将来併用。
- **プロジェクト SR は固定**。既定 **96 kHz / 32-bit float**（選択 44.1 / 48 /
  96 / 192、トラックが 1 本でも入ると SR セレクタはロック）。192 kHz は VRAM が
  2 倍なので大容量 VRAM / 少トラック向けの選択肢として残す（機能はフル）。
- 読込時に **GPU ポリフェーズ FIR** でプロジェクト SR へ変換
  （`gpu/resample-gpu.ts` が CPU で係数表生成・キャッシュ → `RESAMPLE_WGSL`、
  `GpuTrack.uploadChannels(planar, fromRate, toRate)`）。64 taps × 512 phases、
  Blackman-Harris 窓 sinc、カットオフ 0.94·ナイキスト、各 phase 行を Σ=1 正規化
  （DC ゲイン厳密 1.0、実測オーバーシュート 0 dB、44.1k 源で ~19 kHz フラット）。
  ダウンサンプルも同フィルタでアンチエイリアス。grid-stride（フルソングは
  数千万フレーム → workgroup 上限超え）。`PEAKS_WGSL` も同様。
- 旧 CPU Catmull-Rom（`resample.ts`）は撤去 — 補間スプライン特有の
  オーバーシュートでホットなマスターを ~+1 dB 持ち上げていた。
- `INTERLEAVE_WGSL` がマスターを ±1 にハードクランプ（トラック加算 / >0dBFS の
  float WAV が float→int 変換であふれるのを防ぐ最終段。範囲内の音は不変）。

---

## VRAM 上限（マルチトラックのスケール限界）

「オーディオの正は VRAM 常駐」は**トラック分数**に厳しい上限を課す。
32-bit float プレーナ・ステレオ = **96 kHz で 0.77 MB/秒/トラック、
192 kHz でその 2 倍**（+ ピークバッファ ≈ 1/256）。

- 実測（2026-09-06、RTX 3060 Ti / 8 GB、他アプリ併用）: 192 kHz で 16 トラック
  の長尺曲 → 専用 VRAM ~6.8/8 GB で飽和。GPU 演算自体は 6〜19%。この時点の
  ボトルネックは演算ではなく **VRAM 容量**。96 kHz / 24 トラックで ~1.6 GB。
- 概算: 8 GB で 192 kHz なら合計 ~45 トラック分、96 kHz なら ~90 トラック分。
  100 トラック×フルレングスは 8 GB では不可能。

**当面の方針**（ユーザー決定）: 既定を 96 kHz に下げて footprint 半減。192 kHz は
「16 GB 級 GPU / 少トラック」向けの選択肢。

**100 トラックの本命**（未着手・要不変条件改訂）: オーディオの正体を **CPU RAM
（将来はディスク mmap）** に移し、VRAM には**再生ヘッド周辺 1〜2 秒/トラックだけ**
常駐させてストリーミング供給する（実 DAW のディスクストリーミング方式）。波形
ピークは 1/256 サイズなので全曲ぶん VRAM 常駐で可（100 トラックでも ~140 MB）。

---

## ネイティブオーディオ（RtAudio / audify / ASIO）

- `audify` = RtAudio + RtMidi の N-API バインディング。N-API なので Electron でも
  再ビルド不要。だめなら `@electron/rebuild`。
- **ASIO は audify 1.10.1 の Windows prebuilt に同梱**（旧メモの「SDK 再ビルドが
  要る」は誤り）。`RtAudioFormat.RTAUDIO_SINT24` も実在（同梱 d.ts が古く欠落 →
  `src/main/audify.d.ts` で差し替え）。
- `src/main/audio-out.ts` がバックエンドを優先順で自動選択:
  1. **ASIO**（`/zen ?go|antelope|synergy core/i` に一致するドライバのみ自動採用。
     Generic / ASIO4ALL 系は拾わない）
  2. **WASAPI 排他**（`RTAUDIO_HOG_DEVICE`、projSR でデバイスを native 駆動）
  3. **WASAPI 共有**（最終手段、ドライバがリサンプルし得る）
  ストリーム format は常に FLOAT32。RtAudio がデバイス native（ASIO は
  SINT32 = 24bit 相当）へ変換。起動時に backend / デバイス名 / 実レート / block /
  latency を `console.log`。無害な RtAudio メッセージ（Stop 時の二重 closeStream、
  列挙時の未接続ドライバ probe 失敗）は `[audio-out] (rtaudio, benign)` に降格。
- env override: `DAW_AUDIO_API=asio|wasapi|wasapi-shared`、`DAW_AUDIO_DEVICE=<substr>`。
- ASIO は排他。gpudaw 再生中は他アプリから同デバイスを使えない。他アプリが
  掴んでいると openStream が throw → WASAPI 排他へフォールバック。
- ASIO バッファ長は Antelope コントロールパネルの設定値（コードからは実質固定、
  開発機で 8192）。`listDevices()` IPC はまだ WASAPI 固定、デバイスピッカー UI 未実装。

---

## 環境の落とし穴

- **ESM 地雷**: `package.json` に `"type": "module"` を付けない。付けると Electron
  が CJS の main を ESM ロードして `import ... from "electron"` で落ちる。
  main/preload は CJS 出力、renderer だけ Vite が ESM でバンドル。
  `package.json` の scripts を `electron-vite dev` に戻さないこと。
- **`ELECTRON_RUN_AS_NODE=1`** がこの端末（Claude Code / VSCode 統合ターミナル）に
  設定済み。Electron が素の Node 起動になり `app` / `BrowserWindow` が undefined に。
  `npm run dev` / `preview` は `scripts/run.mjs` がこの変数を削除してから
  electron-vite を起動する。**scripts を戻さないこと。**
- `src/main/index.ts` の `preload:` パスは `../preload/index.js`（`.mjs` ではない）。
- **CSP**: `index.html` の CSP は `'self'` 限定。外部 CDN 不可、ライブラリはバンドル。
- **`enable-features=Vulkan` を付けない**: Vulkan の無い環境で WebGPU がデバイス
  ロストする。`enable-unsafe-webgpu` のみ。
- **install-scripts ブロック環境**: ネイティブ依存を足したら prebuilt を手動取得
  （`node node_modules/prebuild-install/bin.js -r napi` を該当ディレクトリで）。
  再 `npm install` 時は `node node_modules/electron/install.js` も手動。
- デバイスロスト時の全再構築は未実装。`device.lost` は `reason==='destroyed'`
  （HMR リロード等）を無視し、それ以外で cache をクリアするのみ。
- renderer の `console.log` は detached DevTools 行き（ターミナル stdout に出ない）。
  main の `console.log` は stdout に出る（`[audio-out] …` はここで確認できる）。

---

## ファイルマップ

| パス | 役割 |
| --- | --- |
| `src/main/index.ts` | Electron main。ウィンドウ、WebGPU フラグ、IPC。ディスク I/O・autoload はここ。 |
| `src/main/audio-out.ts` | ネイティブ出力（RtAudio、ASIO/WASAPI 自動選択）。リングバッファ + デバイスコールバック。 |
| `src/main/audify.d.ts` | audify の型差し替え（同梱 d.ts が enum 非 export で使えない）。 |
| `src/preload/index.ts` | `window.daw` ブリッジ（ファイル選択 / 読込 / autoload / audio start·stop·chunk·status）。 |
| `src/renderer/index.html` | UI シェル（トランスポート + ペイン + レーン + ウィザード + マスターストリップ）。 |
| `src/renderer/src/main.ts` | ブートストラップ。レーン管理、GPU/描画/オーディオの結線、rAF ループ、入力、autoload。 |
| `src/renderer/src/state.ts` | フレームワークレスな最小 observable ステート。 |
| `src/renderer/src/wav.ts` | 最小 WAV デコーダ（PCM 8/16/24/32・float32）。CPU サンプル処理はここだけ。 |
| `src/renderer/src/gpu/device.ts` | 共有 `GPUDevice` 初期化。 |
| `src/renderer/src/gpu/shaders.ts` | WGSL 集約（peaks / waveform / tone / master / interleave / resample / tube・reverb）。 |
| `src/renderer/src/gpu/track.ts` | `GpuTrack`: ch 毎サンプルバッファ、GPU リサンプル、ピーク計算。 |
| `src/renderer/src/gpu/resample-gpu.ts` | ポリフェーズ FIR 係数表（CPU 生成・キャッシュ）。 |
| `src/renderer/src/gpu/master-bus.ts` | N トラック → ステレオマスターの合算 + interleave + 読み戻し。 |
| `src/renderer/src/gpu/waveform-renderer.ts` | ピークバッファから波形描画（レーン毎 canvas）。 |
| `src/renderer/src/gpu/insert.ts` | insert-effect 契約（`process(enc, io)` で planar ステレオブロックを in place 変換）。 |
| `src/renderer/src/gpu/effects/{reverb,delay,eq5,tubeeq,awaker}.ts` | 配線済み insert（スロット/ラックに出る）。`tube.ts` は残置・未配線。`tubeeq.ts` = Pultec EQP-1A 風の真空管パッシブ・プログラム EQ（12AX7 バッファ → パッシブ EQ → 12AX7 メイクアップ）。 |
| `src/renderer/src/gpu/effects/{buscomp,maximizer}.ts` | **マスター専用** insert（Bus Comp = SSL G 系 + 明るめ倍音、Maximizer = ルックアヘッド brickwall）。`FX_KINDS` の `masterOnly`。 |
| `src/renderer/src/audio/scheduler.ts` | 先読みスケジューラ（GPGPU → 読み戻し → main へ）。マスター読み戻しから K 特性 LUFS メーター（Momentary/Short-term/Max）も算出。 |

---

## ロードマップ / 既知の問題

**公開レビュー前に埋める機能の穴**（2026-09-08 議論。これが無いと「DAW」として
土俵に乗らない。優先度順）

- [ ] **オフライン書き出し（オーディオバウンス）** — 最優先。ファイルを 1 個も
      吐けない = 再生専用の玩具に見える。かつ一番安い: マスターチェーン + 読み戻しは
      既にある → スケジューラをリアルタイムクロックから外して回す →
      `wav.ts` にエンコーダを足す（今はデコード専用）→ main で書き出し。~1 日。
- [ ] **音楽タイムライン（小節・拍・BPM・グリッド・スナップの UI 配線）** —
      `bpm` / `timeSig` / `gridMode` はモデルに入っている（`edit/model.ts` /
      `state.ts`）。ルーラ表示と `snapFrame` の全操作配線がロードマップの
      既存項目そのもの（下の `#pane-top` タイムルーラー参照）。生サンプル軸のままだと
      開いた瞬間「小節が無い」と気づかれる。中コスト・視覚効果大。
- [ ] **録音経路（入力 → VRAM → トラック）** — 「録音は逆」と設計上あちこちに
      書いてあるのに実装ゼロ（`audify.d.ts` に `setInputCallback` はあるが未使用）。
      入力なしでは「なぜ DAW？」と言われる。再生経路のミラーだが
      モニタリングのレイテンシ・arm/punch でそれなり。※下の「録音経路」項目と同一、
      優先度を公開ブロッカーへ格上げ。
- [ ] **wave 再生インストゥルメント（サンプラ）** — MVP は
      ドラム/ワンショットサンプラ + 簡易ノートブロックレーン（ピアノロールでは
      なくクリップ的なノート矩形）。engine 側は既存インフラに嵌まる:
      サンプルは既に VRAM（`AudioSource`）、注入先は `CLIPGATHER` → レーン
      `[L|R]` スクラッチ → `MIXADD` の経路（`CLIPGATHER` の代わりに
      `INSTRUMENT_WGSL` を 1 dispatch）、ブロックスケジューラも流用。新規 =
      `MidiClip` 型 + CPU ボイスアロケータ + `INSTRUMENT_WGSL`（insert 1 個ぶん）
      + ノートレーン UI（`lane-fx` オーバーレイ流用）。MIDI 入力（RtMidi は
      audify 同梱）と `.mid` インポートは任意。**重いのはピアノロール UI と
      マルチサンプル/ループ** → future work と明記。中途半端なピアノロールは
      「オーディオのみ」と正直に書くより印象が悪い。
- [ ] **オートメーション（音量 / パン / プラグイン値の時間変化）** — コア機能だが
      初回レビューは無しでも成立する。「未実装」と明記して次段送りで可。

**公開の体裁**（レビュー募集の前提。機能ではないがブロッカー）

- [x] **LICENSE ファイル**（2026-09-08）— **Apache-2.0** を採用（`LICENSE` +
      `NOTICE`、`package.json` の `license` も設定）。MIT より特許ライセンス付与 +
      報復条項がある点を重視（この project は既存特許を意識して DSP を設計して
      いる。メモリ `gpudaw-strip-saturation-ip` 参照）。コントリビューションは
      Apache-2.0 §5 で同ライセンス扱い（CLA なし、DCO は任意）。
- [ ] **README の顔** — 「現状」節が 2026-09-06 付けで作業は 09-08 まで進んでいて
      古い。冒頭に「何が動く / 何が無い / ビルドと起動 / 前提ハード
      （WebGPU・ASIO・Windows）」の簡潔版（できれば英語）を。2000 行超の
      セッションログは付録扱いに。
- [ ] **デバイスピッカー UI** — `listDevices()` IPC は WASAPI 固定・UI 未実装。
      他インターフェースのレビュアーは `DAW_AUDIO_API` / `DAW_AUDIO_DEVICE` 頼み
      → README に明記（最低限）。
- [ ] **自動チェック** — `DAW_SELFTEST` だけ。CI もユニットテストも無いことを
      正直に書く。

**次の一手（候補、優先度は次セッションで）**
- [ ] **プラグインのモーダル化**（次セッションの本題）: insert プラグインの編集 UI を
      今の左詳細ペイン（`#pane-left`、264px・縦スクロール、`buildFxParams` /
      `buildInsertRack`）から、フローティング/モーダルなプラグインウィンドウへ。
      スロット名クリック / ラックのカードから開く。複数同時に開けるか、単一
      モーダルかは要検討。チャンネルストリップ本体（`ChannelStrip`）を含めるかも。
- [ ] チャンネルストリップ: トラック毎 gain / pan / mute / solo（今は全トラック
      unity/center 固定。`MASTER_WGSL` は既に per-track gain/pan 対応、配線は
      scheduler の per-lane mix + レーンヘッダー UI）
- [ ] 100 トラック本命: オーディオ RAM 常駐 + VRAM 再生窓ストリーミング（上記）
- [ ] mix の 1 dispatch 化（全サンプル 1 バッファ + トラック記述子 SSBO）
- [~] `#pane-top` タイムルーラー: 時間表示 + クイックトランスポート + グリッド
      overlay は実装済（セッション 38）。小節・拍 / BPM / スナップは未。
      `#pane-bottom` ミキサはチャンネル/マスターストリップ済、インスペクタは左ペイン
- [ ] レーン削除・並べ替え、トラック名編集
- [ ] チャンネルストリップに **Input Gain ノブ**を追加（現状 Input セクションは
      Trim スライダのみ。ロータリの独立ゲイン段が欲しい）
- [ ] クリップモデル（trackId/startFrame/offset/length）+ ブロック描画
- [ ] 録音経路（入力 → VRAM → トラック）
- [ ] エフェクトチェーン再配線（`Insert` / `MasterBus.inserts` は温存済み）
- [ ] FFT（WGSL、subgroup）→ スペクトル表示・畳み込みリバーブ
- [ ] `timestamp-query` で µs/block 実測表示
- [ ] 波形ステレオ表示（今は ch0 ピークのみ）
- [ ] プロジェクト保存/読込、オフライン書き出し
- [ ] SR ロック時の UI（理由 hint）or 全トラック再リサンプルで解除
- [ ] **各トラックレーンに VU メーター**（メモ / 2026-09-07(6)）: 現状 VU はミキサー
      ストリップ（`.strip-vu`、`Lane.envelope` の 20ms 窓ピーク近似、post-fader）と
      マスター（読み戻しブロックのピーク）だけ。トラックレーン側（`#tracks` の
      `.lane` 右予約枠 `.lane-right` か波形の脇）にも小さな VU を出したい。データは
      既存 `Lane.envelope` + `laneToSource` の solo/mute 解決をそのまま流用できる
      （GPU 読み戻し不要 = 追加コストほぼゼロ）。`frame()` のストリップメーター
      ループ（`lane.vu` fast-attack/slow-release 済み）に描画先を 1 個足すだけ。
      本物の per-track ポスト DSP メーターにするなら `StripBank` 出力スライスの
      ピークを読み戻す必要があり別タスク。

**既知の細かい問題**
- 終端後 buffer 表示が一瞬跳ねる（クランプ済み、根治は wind-down 検出）。
- レーン毎に WebGPU canvas context を持つ（多トラックで swapchain がかさむ可能性。
  可視カリングで未描画レーンは `getCurrentTexture()` を呼ばず当面は緩和）。
- マルチトラック mix はトラック毎に別 compute パス（同一 encoder）で `outP` を
  RMW。WebGPU はパス間で storage 書き込みを可視化するので順序は安全。
- 複数 WAV の SR が違っても各自プロジェクト SR へリサンプルされる（追従なし）。
- テストベッド自動ロードのパスはコード内ハードコード（`DAW_AUTOLOAD` で上書き可、
  不要になったら `src/main/index.ts` から消す）。

---

## チャンネルストリップ / インサート実装計画（進行中 2026-09-06〜）

トラック毎の**内蔵チャンネルストリップ**（固定順 DSP）と、**着脱式インサート
プラグイン**の 2 系統を入れる。左ペイン（`#pane-left`、これまで空）を
「選択トラックの詳細」に使う。

### 全体設計

- **選択**: レーンの空き部分（`.lane-left` / `.lane-right` / ストリップ head）
  クリックでそのトラックを選択・ハイライト（`.lane.selected`）。左ペインに詳細。
- **内蔵チャンネルストリップ**（トラック毎・固定順、`gpu/channel-strip.ts` +
  `CHANNELSTRIP_WGSL`）:
  `gather → 入力トリム → サチュレーション(1ノブ + mode) + 微小デコリレーション allpass
   → HPF → アナログコンソール風 4-band EQ → コンプ → [インサート] →
   フェーダー/pan で master へ加算`
  - 再帰 IIR なのでシリアル処理（`@workgroup_size(1)`、L→R をリンク検波で
    コンプ・ステレオリンク）。係数は CPU で RBJ biquad 計算 → UBO。状態は
    トラック毎バッファ。
  - **サチュレーション（1ノブ + mode）**: `drive` 量 0..1 で `satMode` の
    どちらかを駆動。`drive` = 並列4バンドサチュレータ（SSL 的な前に出るグリット、
    セッション39で実聴合格）、`color` = トランス + Class-A 段（Neve 的な暖かい倍音、
    DC ブロック → LF ブルーム → HF プリエンファシス → 非対称 Class-A →
    出力ショルダ + 直通トップ）。
  - **個体差**: `ChannelStrip.vary` = 生成時 `Math.random()` から 1 回だけ作る
    極小の係数ディザ（ゲイン ±0.3% / バイアス / HF コーナー ±1.5% / マグニチュード
    フラット allpass ±0.03）。**利用者に露出しない**（seed フィールドも番号選択も
    reseed も無し）。単体では聞こえない差で、同じ音を 30 トラック重ねてもダンゴに
    ならないためだけのもの。TMT（US 10,725,727）の「回路 + 部品公差 + 利用者が
    チャンネル番号を選ぶ」構成とは別物。旧 nasal（honky ピーク + seed）は撤去。
- **インサートプラグイン**（着脱式、`Insert` 契約を流用）:
  - リバーブ = 既存 `ReverbInsert` を単体プラグインとして再利用（パラメータ UI）
  - ディレイ = `DelayInsert` + `DELAY_WGSL`（新規、ステレオ/FB/ダンプ/mix）
  - デジタル 5-band EQ = `Digital5EQ` + `EQ5_WGSL`（新規、クリーンな RBJ 5 バンド）
  - トラック毎ラック `Lane.inserts` と マスターラック `MasterBus.inserts`。
    トラックラックはチャンネルストリップの後・フェーダーの前で処理。

### mix 経路の改修（`master-bus.ts`）

現状: トラック毎に `MASTER_WGSL` を planar master へ直接 accumulate。
改修: 共有スクラッチ `[L|R]` を 1 本用意し、トラック毎に
`GATHER_WGSL`(トラック→スクラッチ) → strip.process → inserts → `MIXADD_WGSL`
(スクラッチ→master、gain/pan/masterGain、accumulate)。master inserts →
interleave は現状のまま。スクラッチはトラック間で使い回し（同一 encoder の
パス順で RMW 可視、既存 mix と同じ前提）。

### 残タスク（チェックリスト）

- [x] Phase A: 選択 + 左ペイン詳細スキャフォールド（フェーダー/pan/M/S を
      ストリップと双方向）
- [x] Phase B: mix 経路改修（`GATHER_WGSL` / `MIXADD_WGSL` / 共有スクラッチ）+
      `ChannelStrip`（`CHANNELSTRIP_WGSL` はトリム/drive/コンソール EQ/鼻音/コンプを
      **フル実装済み**、`gpu/channel-strip.ts` が RBJ 係数を CPU 計算）。左ペインに
      暫定 UI（Drive / HPF / Nasal スライダ、鼻音は pointerdown で reseed +
      `.nasal-active` ハイライト）。`typecheck` / `build` グリーン。**要実機確認**:
      24 トラック自動ロードで再生 → 音が出るか（経路改修の回帰）、Drive/Nasal が
      効くか、GPU 負荷。
- [x] Phase C: 左ペイン詳細フル UI — Input(Trim/Drive/HPF)・EQ(アナログコンソール風
      4-band、LF/HF はシェルフ⇔ベル切替、freq は対数スライダ)・Nasal(ロータリー
      ノブ、drag=深さ / press=個体係数リロール + `.nasal-active`)・Compressor
      (thresh/ratio/att/rel/makeup)。左ペイン幅 264px、縦スクロール。
- [x] Phase D: インサートプラグイン系統。`Lane.inserts: Insert[]` +
      マスター `MasterBus.inserts`。左ペインにラック UI（カード = bypass/▲▼/×
      + パラメータ、`+ Reverb / + Delay / + 5-band EQ`）。
      `gpu/effects/delay.ts` (`DELAY_WGSL`、ステレオ/FB/ダンプ/ping-pong、
      1 スレッド直列)、`gpu/effects/eq5.ts` (`EQ5_WGSL`、RBJ 5 バンド直列)、
      Reverb は既存 `ReverbInsert` を再利用。ミキサー MASTER ストリップ head
      クリックでマスターラックを編集。`typecheck` / `build` グリーン、app 起動 OK。
      **要実機確認**: 各 insert / strip モジュールが鳴るか、GPU 負荷、tail 挙動。
- [ ] Phase E: 実機テスト後の詰め — 負荷計測（strip は現状トラック毎に
      `@workgroup_size(1)` 直列 dispatch。重ければ連結スクラッチ + invocation=
      トラックの 1 dispatch バッチ版へ）、UI 微調整、セッションログ確定。

### 保留 / 判断ポイント

- チャンネルストリップはトラック毎に別 dispatch（シリアル）。24 トラックは
  実測で許容範囲の想定だが、超えるなら全トラック 1 dispatch のバッチ版へ
  （連結スクラッチ + 連結状態バッファ、invocation = トラック）。
- コンソール EQ は往年のアナログ卓相当のカーブを RBJ biquad で近似。厳密モデリングではない
  （特定製品のエミュレートではない）。

---

## セッションログ

> セッション開始時に末尾の最新エントリを読む。終了時に**末尾**へ新エントリを
> 追記する（先頭ではなく）。1 エントリ = 1 作業セッション。相対日付は絶対日付で。
>
> テンプレ:
> ```
> ## YYYY-MM-DD — <一行サマリ>
> **やったこと** / **今の状態 / 動くもの** / **次の一手** / **未解決** / **触ったファイル**
> ```

---

### 2026-09-05 — MVP スケルトン作成

- Electron + electron-vite + TypeScript 初期化。`install` / `typecheck` / `build` 通る。
- WebGPU デバイス初期化（`gpu/device.ts`）、GPU 常駐サンプルバッファ（`GpuTrack`）、
  WAV アップロード、GPU compute でのサイン波生成（`TONE_WGSL`）。
- GPU compute でピーク(min/max)縮約（`PEAKS_WGSL`, `SAMPLES_PER_PEAK=256`）、
  ピークバッファから直接の波形描画（`WAVE_WGSL`, line-list、ホイールで
  スクロール/ズーム、クリックでプレイヘッド）。
- 旧再生経路: `audio/engine.ts` が ~300ms 先読み → `postMessage` →
  `public/daw-worklet.js`（AudioWorkletProcessor）。※この後撤去。
- ハマり: `package.json` に `"type": "module"` を入れたら Electron が main を
  ESM ロードして `import ... from "electron"` で落ちた → 外して CJS 出力に戻す。

### 2026-09-05（2）— 方向性の確定と Phase 0 開始

- ユーザー合意: Web Audio 録再は使わない。オーディオの実体は GPU VRAM。
  パラレルトラック → GPGPU → ステレオマスター → ネイティブ出力（RtAudio →
  ゆくゆく ASIO）。出力は main、GPGPU は renderer。SR 基準 96 kHz。
- `ELECTRON_RUN_AS_NODE=1` がこの端末に設定されていて Electron が素の Node 起動に
  なる問題を `scripts/run.mjs`（変数削除して electron-vite 起動）で回避。
  `package.json` の dev/preview を `node scripts/run.mjs` に。
- `enable-features=Vulkan` を削除（Vulkan 無し環境で WebGPU がデバイスロスト）。
  `device.lost` は `destroyed` を無視。

### 2026-09-05（3）— Phase 0 実装、GPGPU→ネイティブ出力が鳴った

- Electron 33 → 37.10.3（`audify` prebuilt が napi-v10、33 では `require` が
  ハードクラッシュ）。`audify` 導入（install-scripts ブロック環境なので prebuilt
  を手動取得）。
- `src/main/audio-out.ts`（`NativeAudioOut`）: RtAudio WASAPI 出力、インターリーブ
  f32 ステレオのリングバッファ、`frameOutputCallback` で 1 デバイスブロックずつ。
  **start()=ストリーム open（受付開始、まだ pull しない）→ renderer が先読み分を
  送る → begin()=`rt.start()`** の 2 段構えで起動 underrun ゼロ。
- IPC `daw:audio:{devices,start,begin,stop,status,chunk}`。`audify.d.ts` + tsconfig
  `paths` で型差し替え。`wav.ts` をプレーナ ch 配列返しに、`GpuTrack` をプレーナ
  ステレオに作り替え。`master-bus.ts` + `MASTER_WGSL`。`scheduler.ts`
  （`PlaybackScheduler`、旧 engine.ts 撤去）: 先読み 200ms、status 由来のペーシング。
- `DAW_SELFTEST=1 npm run dev` で **GPU トーン → VRAM → GPGPU マスター → 読み戻し
  → WASAPI 出力 → スピーカー** をユーザー実機確認（「音が聞こえた」）。underrun=0。
- 既定出力は Antelope Zen Go Synergy Core（WASAPI, preferred 96kHz）。

### 2026-09-06 — インサート機構の原型 + GPU リバーブ

- `gpu/insert.ts`: 最小 `Insert` 契約（`process(enc, io)` が planar ステレオ
  ブロックを in place 変換、状態は insert 自身の GPU バッファ、`reset()`）。
- `MASTER_WGSL` を planar 出力に、`INTERLEAVE_WGSL` を新設。`MasterBus` を
  master mix(planar) → insert チェーン → interleave → 読み戻し を 1 エンコーダ /
  1 submit で。`inserts: Insert[]`、`resetInserts()`、`processed`。
- `gpu/effects/reverb.ts` + `REVERB_WGSL`: Freeverb（8 comb + 4 allpass / ch）。
  プロトタイプにつき 1 GPU スレッド/ch で直列（feedback ループは並列化不可）。
- Stop してもリバーブテイルを鳴らし切る: `scheduler.ts` の `tailing` /
  `tailDeadline` / `quietBlocks`。Stop 時に `scheduledFrame` をトラック終端へ
  ジャンプして 1 回の Stop でソース停止 + 自然減衰。

### 2026-09-06（2）— チューブ EQ insert（リバーブ前）

- `TUBE_WGSL` + `gpu/effects/tube.ts`: 1 ノブのチューブドライブ段（DC ブロック HP
  → HF プリエンファシス → drive + 非対称 tanh → HF ロールオフ → メイクアップ）。
  `preGain = 10^(drive²·33dB/20)` の drive² ニーで「一定ゲインから倍音が増える」。
- チェーン順 = `masterBus.inserts = [tube, reverb]`。UI に Tube トグル + drive
  スライダ。selftest を `?selftest&mode=<value>` に一般化。
- ✅ ユーザー実聴「合格 依頼どおり」。

### チェックポイント（commit `c51626b` 時点）

Phase 0 完了 + インサート機構の原型。`master mix(planar) → [Tube] → [Reverb] →
interleave → 読み戻し → RtAudio/WASAPI 出力`。全部 GPU で 1 エンコーダ/1 submit。
起動＆定常で underrun=0。実機（RTX 3060 Ti / Zen Go WASAPI 96k）でユーザー実聴合格。

### 2026-09-06（3）— DAW 骨格: マルチトラック + レーン UI（エフェクタ解除）

- **エフェクタ解除**: `main.ts` から Tube/Reverb の配線を全撤去。`MasterBus.inserts`
  は空のまま（機構・ファイル・WGSL は温存＝dormant、再配線は push し直すだけ）。
- **マルチトラック mix（GPU）**: `MASTER_WGSL` に `accumulate : u32` 追加。ホストが
  トラック毎に master シェーダを 1 パスずつ同じ planar バッファへ（track 0 = 書き、
  以降 = 加算）。`renderBlock(sources: MixSource[], …)`。トラック毎に専用 UBO プール。
- `PlaybackScheduler` を `getTracks: () => GpuTrack[]` に。`readyTracks()` /
  `sources()` / `totalFrames()`（= 最長トラック）。
- `state.ts`: `sourceLabel` 削除、`trackCount` 追加。`totalFrames` は「最長トラック」。
- `index.html` 全面改稿: トランスポートに ＋Add Track、上下左右の空ペイン、
  `.lane`（100px）= 左（トラック名）/ 中央 canvas / 右。`#wizard` モーダル。
  エメラルド配色。
- `main.ts`: `Lane { id, track, renderer, el, canvas }` を `lanes[]` で管理。
  `addLane()` が DOM + `GpuTrack` + `WaveformRenderer`（レーン毎 canvas/context）。
  1 本目追加時のみズーム fit。ホイール: 素 = 縦スクロール / Shift = 横 / Ctrl = ズーム。
- 波形色: `WAVE_WGSL` frag = 明エメラルド、clearValue = 暗エメラルド。

### 2026-09-06（4）— 修正: モーダル閉じ / プレイヘッド位置 / 固定 SR + 読込リサンプル

1. **モーダル**: `#wizard { display:flex }` が UA `[hidden]` を上書きしていた →
   `#wizard[hidden] { display:none }`。
2. **プレイヘッド / ズーム**: `refreshTotals()`（合計更新だけ）と `fitToProject()`
   （`framesPerPixel = totalFrames / waveViewportPx()`）に分離。トラック追加 /
   リサイズ（`userZoomed` でない時）で fit。波形とプレイヘッドが同じマッピングに。
3. **固定プロジェクト SR + 読込リサンプル**: 既定 192 kHz、SR セレクタはトラック
   投入でロック、SR 追従を撤去。`resample.ts`（CPU Catmull-Rom）新設、読込時に
   projSR へ変換してから `uploadChannels`。 ※この後 GPU 版へ置換。

### 2026-09-06（5）— ASIO 出力（Antelope Zen Go / 192 kHz）+ 192k のぶつぶつ対策

- **判明**: ASIO は audify 1.10.1 prebuilt に同梱（旧メモは誤り）。`RTAUDIO_SINT24`
  も実在。probe で Zen Go ASIO を `openStream(FLOAT32, 192000)` → OK
  （actualBlock=8192、latency≈9640fr）。ぶつぶつの主因は WASAPI 共有で 192k を
  要求 → デバイス mix 96k → RtAudio 内部リサンプル。
- `audio-out.ts` 全面改修: バックエンド自動選択 ASIO → WASAPI 排他（HOG） →
  WASAPI 共有。ストリーム format は FLOAT32、RtAudio がデバイス native へ変換。
  `AudioOutStatus.backend` 追加（トランスポートバー表示）。env override
  `DAW_AUDIO_API` / `DAW_AUDIO_DEVICE`。
- `scheduler.ts`: `BLOCK_FRAMES 4096→8192`、`TARGET_LOOKAHEAD_S 0.2→0.35`、
  `audioStart` の blockFrames を 0（ASIO はドライバのバッファ）。

### 2026-09-06（6）— GPU バンドリミット・リサンプラ（Catmull-Rom のオーバーシュート撲滅）

- **診断**（node 実測）: Catmull-Rom（4 点 3 次スプライン）はトランジェントで
  オーバーシュートし、ホットなマスターで **ピーク +1.0〜+1.25 dB 増加** → IF の
  メーター red。RMS は不変。
- `resample.ts`（CPU）削除 → **GPU ポリフェーズ FIR**: `gpu/resample-gpu.ts`
  （窓 sinc 係数表、64 tap × 512 phase、Blackman-Harris、カットオフ 0.94·Nyq、
  各 phase Σ=1 正規化）+ `RESAMPLE_WGSL`（`uploadChannels(planar, from, to)`、
  grid-stride）。`PEAKS_WGSL` も grid-stride 化。実測オーバーシュート 0 dB、
  DC 1.000000。
- `INTERLEAVE_WGSL` にマスター出力 ±1 クランプ（最終段）。
- selftest 拡張: `DAW_SELFTEST=resample` で 48k → GPU リサンプル → projSR を検証。

### 2026-09-06（7）— ユーザー実聴 OK + マスターフェーダー増設（既定 -1 dB）

- ✅ ユーザー実聴: 音切れ消滅、ヒリついた歪み感が減った。メーターの赤は許容範囲。
- 無害な RtAudio メッセージ（Stop 時の二重 closeStream、未接続ドライバ probe 失敗）を
  `BENIGN_RT` でフィルタして `[audio-out] (rtaudio, benign)` に降格。
- **マスターフェーダー**: -24〜+6 dB（0.5 刻み、既定 -1.0 dB、-24 で `−∞`）。
  `syncMaster()` が `MasterBus.masterGain`（線形）へ。ブロック単位のステップ変更。
  最初トランスポートに置いたら flex で潰れて不可視 → **右ペイン（`#pane-right`）に
  縦フェーダーの master strip として移設**。

### 2026-09-06（8）— 再生中 GPU 負荷: 波形再描画の dirty 化 + オーディオ経路の無駄取り

- 症状: 停止中は GPU メーターほぼ 0、再生すると ~20%（マスターフェーダー無関係、
  最初からの現象）。
- **波形**: `frame()` が毎 rAF で全レーンを無条件再描画していた。波形キャンバスは
  ピークデータ + タイムライン変形にしか依存しない（プレイヘッドは別 DOM）ので、
  **`viewDirty || lane.dirty` かつスクロール表示域内のレーンのみ**描画。→ 定常
  再生中は波形の GPU 描画 0。
- **scheduler**: `BLOCK_FRAMES 8192→32768`、`TARGET_LOOKAHEAD_S 0.35→0.5`、
  `MIN_TOPUP_S 0.15→0.25`。読み戻しサイクル ~23/s → ~6/s。pump tick 10ms→25ms。
- **master-bus**: readback 用 `Float32Array`・トラック UBO の `ArrayBuffer`・
  staging バッファ・interleave / per-track bindgroup を毎ブロック生成 → 使い回し
  （bindgroup は `channels[0]` キーでキャッシュ、`ensureBlock` でクリア。add-only 前提）。
- **audio-out**（main）: `onFrame` / `pushChunk` の要素ごとループ（〜16384）→
  バルク `.set`（ラップで 1 回分割）= memcpy 化。出力 / 無音バッファを使い回し。
- **VRAM が上限**: 16 トラック（長尺・192k）で GPU 演算 6〜19% だが専用 VRAM
  ~6.8/8 GB で飽和。原因は VRAM 常駐オーディオのサイズ。**ユーザー決定: 既定を
  96 kHz に**。192 kHz は大容量 VRAM 向けの選択肢として維持。100 トラックの本命
  （RAM 常駐 + VRAM 再生窓ストリーミング）は別途（「VRAM 上限」節）。
- 実測: 24 トラック / 96 kHz で GPU ~7%、専用 VRAM ~1.6 GB。ユーザー OK。

### 2026-09-06（9）— 複数ファイル選択 → パラ一括読込 + トラック名（ファイル名から）

- **IPC 分割**: `daw:openAudioDialog` を廃止 → `daw:openAudioFiles`
  （`multiSelections`、パス配列だけ）+ `daw:readAudioFile(path)`（1 ファイルの
  bytes、`.wav` チェック）。大きなステム束を一度に IPC/メモリに載せないため。
- `main.ts` に `loadFiles(paths)` ヘルパー: 1 つずつ順に read → decode →
  `addLane(トラック名)` → GPU リサンプル。進捗を `gpu-status` に `loading 3/12…`。
  decode 失敗は skip。全件後に refreshTotals / fitToProject / warmup を 1 回。
- **トラック名**: `.lane-name` を `<span class="lane-num">1</span>
  <span class="lane-title">kick</span>` に。title は basename から拡張子除去。
  長名は ellipsis + `title` 属性。ファイル名は `textContent` で設定（注入対策）。

### 2026-09-06（10）— md 1 本化 + テストベッド自動ロード

- **md 統合**: `docs/ARCHITECTURE.md` / `docs/SESSION.md` を廃止し、この
  `README.md` 1 本に集約（概要 → 現状 → 設計 → 落とし穴 → ファイルマップ →
  ロードマップ → セッションログ）。`CLAUDE.md` は不変条件と環境の落とし穴だけの
  短い版に整理し「詳細は README.md」を指す。メモリ `gpudaw-project` も更新。
- **テストベッド自動ロード**: 起動時（`?selftest` 以外）に main の `AUTOLOAD_DIR`
  （既定 `…\リファレンス音源\MoniBlue_AprilBlues`、`DAW_AUTOLOAD` で上書き / 空で
  無効）の WAV を `daw:autoloadWavs` で列挙 → `loadFiles()` で全部トラック化。
  当面のテストベッド、不要になったら `src/main/index.ts` から消す。
- **今の状態**: `typecheck` グリーン。ユーザーが起動して MoniBlue_AprilBlues の
  パラが自動で並ぶか要確認。
- **触ったファイル**: `src/main/index.ts`, `src/preload/index.ts`,
  `src/renderer/src/main.ts`, `README.md`, `CLAUDE.md`, 削除 `docs/*.md`,
  メモリ `gpudaw-project.md`

### 2026-09-06（11）— チャンネルストリップ + レーン高 50px

- **ミックスペイン**（`#pane-bottom`）を横スクロールのチャンネルストリップ列に。
  1 トラック = 1 ストリップ（`#strips` に `addLane` が生成）。中身: 番号+名前 /
  仮プラグイン枠（`fx`、処理なし）/ 縦フェーダー(-60〜+6dB) + 縦 VU バー /
  pan スライダ(-1..+1) / dB 数値 / M(mute)・S(solo)・R(rec-arm) ボタン。
  `--pane-vert 132→190px`、`--lane-h 100→50px`（`.lane-left` も詰めた）。
- **per-track mix**: `Lane.mix: {gainDb,pan,mute,solo,rec}`。`laneToSource(l)` が
  solo/mute を解決して `MixSource`（`gain` 線形 / `pan`）に。ミュート or
  ソロ対象外は `gain 0`（フィルタせず `MASTER_WGSL` が 0 倍）。
- **scheduler**: `PlaybackScheduler` を `getSources: () => MixSource[]` に変更
  （旧 `getTracks` / 共有 `this.mix` を撤去）。`ready()` が `channels[0] &&
  totalFrames>0` でフィルタ。`main` は `() => lanes.map(laneToSource)` を渡す。
- **メーター**: 読込時に `computeEnvelope()`（decoded サンプルから 20ms 窓の
  ピーク、時間インデックス）を `Lane.envelope` に。`frame()` で playhead 位置の
  envelope × フェーダー（post-fader、mute/solo 反映）を fast-attack/slow-release
  で均して VU バー高 + dB 表示。**画面内ストリップのみ DOM 更新**。GPU 読み戻し
  なしの安価な近似（デモトーン/selftest は envelope なし → 0）。R ボタンは
  状態のみ（録音経路は未実装）。プラグイン枠も表示のみ。
- **今の状態**: `typecheck`/`build` グリーン、起動クリーン。ユーザーが
  MoniBlue_AprilBlues 自動ロード → ストリップ表示・フェーダー/pan/M/S・メーター
  の挙動を要確認。
- **触ったファイル**: `src/renderer/index.html`, `src/renderer/src/main.ts`,
  `src/renderer/src/audio/scheduler.ts`

### 2026-09-06（12）— ストリップ微調整

- フェーダー領域拡大: `--pane-vert 190→280px`（波形エリアは縮む）、
  BrowserWindow `1400×860 → 1540×950`（+10%）。
- pan を `<input range>` → **ロータリーエンコーダ**（`.strip-knob`、縦ドラッグで
  ±1、`i` を `rotate(pan*135deg)`、dblclick で 0）。dB 数値の横に配置。
- dB / ピーク数値の書き込みを **1 Hz スロットル**（`meterTextAt`）。VU バーの
  高さ・色は毎フレーム。
- **ピーク数値**（`.strip-peak`、peak-hold）追加。クリックでリセット、
  0 dBFS 超で赤（`.over`）。
- VU バー: **固定色スケール**（`.strip-vu` に -54〜0 dBFS を緑→黄→橙→赤で
  マップした固定グラデ）を貼り、`> i` を上からのダークカバーにして
  `height = (1-norm)*100%` で縮める。→ 先端だけ色が変わる（バー全体が単色で
  変わらないので目が疲れない）。
- **触ったファイル**: `src/renderer/index.html`, `src/renderer/src/main.ts`,
  `src/main/index.ts`

### 2026-09-06（13）— ストリップ横詰め

- M/S/R を 1 行 → **2 列グリッド**（M S / R）。R が 1 段下・左。
- peak 数値を `.strip-row`（db + knob）から出して独立行に。
- `.strip` 幅 80 → 66px、padding も詰めた。

### 2026-09-06（14）— PAN ノブを M/S/R グリッドへ / dB 2 個並び

- pan ロータリーを小型化（16px）して **M/S/R グリッドの空き右下セル**に
  （M S / R ◯）。`.strip-row` 廃止。
- level dB と peak dB を **横並び**（`.strip-nums` flex）に。

### 2026-09-06（15）— フェーダー部を ~10% 拡大（可読性）

- チャンネルストリップだけ拡大（全体ズームではない）: `--pane-vert 280→312`、
  `.strip` 幅 66→74・font 9→11 系・fader 20→23・vu 9→11・knob 16→19・
  btn font 9→11。ウィンドウ高 950→990。

### 2026-09-06（16）— マスターフェーダーを mixer 右端に固定

- マスターを右ペインから **ミックスペイン右端の固定列 `#master-col`** へ移設。
  `#pane-bottom` を flex に、`#strips-scroll`（横スクロール）+ `#master-col`
  （`flex:none`、スクロールしない）。`#pane-right` は空プレースホルダに戻す。
- `#master` は `flex:1` でペイン高いっぱい。meter の可視カリング参照を
  `paneBottom` → `stripsScroll` に。
- **→ 次で撤回**: `#pane-right` が空 220px 残ってトラック域のバランスが崩れた
  ため、ユーザー指示で（16）を全戻し。master は右ペインに復帰。ミキサー右端
  固定はレイアウト設計を詰めてから再挑戦。

### 2026-09-06（17）— マスターストリップをチャンネルストリップ形状で mixer 右端に

- チャンネルストリップの見た目はそのまま。**マスターを `.strip.master` として
  `#pane-bottom` 右端に固定**（`#strips-scroll` が横スクロール、master strip は
  `flex:none` でスクロールしない）。`#pane-right` div は**削除**（`#workspace-mid`
  は `[pane-left][tracks-scroll]` になり波形域が横いっぱいに戻る）。
- master strip 構成 = head "MASTER" / fx "out"(飾り) / fader+VU / level・peak 数値 /
  `#master-val`(ゲイン dB)。**フェーダー accent を赤 `--rec`**、左ボーダー赤、
  bg 微赤で判別。
- master メーター: `scheduler` が readback ブロックのピーク（post master-gain、±1）
  を `masterBlockPeak` に持ち `metrics().masterPeak` で公開。`main` が VU バー
  （固定色スケール・カバー方式、チャンネルと同じ）+ 1Hz の level/peak 数値。
  peak クリックでリセット、0dB 超で赤。
- **触ったファイル**: `src/renderer/index.html`, `src/renderer/src/main.ts`,
  `src/renderer/src/audio/scheduler.ts`

### 2026-09-06（18）— 画面はみ出し修正（比率戻し）

- （15）でフェーダー部を上げすぎてウィンドウが画面外に出た。`--pane-vert
  312→244`、BrowserWindow `1540×990 → 1440×880`。まだ strip 内容がはみ出す
  なら `.strip` の gap / `.strip-fx` 高さ / padding を詰める。

### 2026-09-06（19）— ストリップ縦オーバーフローの根治

- （18）だけでは strip 内容がペイン高を超えて画面外に spill していた。原因は
  flex 高さ連鎖が非決定的（`#strips` が `min-height:100%`、`.strip` に明示高
  なし、head/fx/nums/btns が `flex:none` 未指定で `mid` を押し出す）。
- 修正: `.strip { height:100%; overflow:hidden }`、`mid` 以外を `flex:none`、
  `.strip-mid { flex:1 1 40px }` だけが伸縮、`#strips { height:100% }`、
  `#strips-scroll { min-height:0 }`。固定部を圧縮（fx 22→15、gap 4→3、
  padding 5→4、font 11→10、btn padding 3→2）。`#master-val` も `flex:none`。

### 2026-09-06（20）— +10%（オーバーフロー根治後）

- ウィンドウ 1440×880 → 1584×968、`--pane-vert` 244→268。（19）で縦連鎖を
  決定的にしたので安全に戻せる。

### 2026-09-06（21）— フェーダー部を変更前比 +20%

- `--pane-vert` 244→293（+20%）→ さらに +60px で **353**。ウィンドウ幅 1440→1728（+20%）。
  高さは 880→980（+11% に抑制、1080p 画面に収めるため）。波形域は縮む分を
  許容。

### 2026-09-06（22）— +60px + 下部コントロールを拡大

- `--pane-vert` 293 → **353**（+60px）。増えた縦を全部フェーダーに回さず、
  下の数値/ボタン域を拡大: `.strip-fx` 15→30、`.strip-nums` font 10→13、
  `.strip-btns` button font 10→13・padding 2→6、`.strip-knob` 19→26、
  head font 10→12、gap 3→5、strip 幅 74→78。`.strip-mid` は残りを吸う（fader）。

### 2026-09-06（23）— M/S/R ボタンを正方形に

- ボタンが縦長だったので `.strip-btns button { aspect-ratio: 1; padding: 0;
  flex center }` で正方形化。縮んだ分は `.strip-mid`（fader）が吸う。

### 2026-09-06（24）— フェーダーつまみを feder.png に

- `feder.png`（28×56 RGB、コンソール風フェーダーキャップ）を
  `src/renderer/public/feder.png` に置き（Vite が `/feder.png` で配信、
  build で `out/renderer/` へコピー、CSP `img-src 'self'` でOK）。
- `.strip-fader` を `-webkit-appearance: none` にして
  `::-webkit-slider-runnable-track`（4px の細線）+ `::-webkit-slider-thumb`
  （28×56 で png 背景）をカスタム。マスターはトラック線を赤に。
- 縦フェーダー（`writing-mode: vertical-lr`）は Chromium 132 のネイティブ対応。
  accent-color ベースの塗り表示は無くなる（キャップ位置で読む）。

### 2026-09-06（25）— つまみ中央寄せ + dB ゲージ

- feder.png つまみが右に寄っていたので `.strip-fader` width 30→24、
  つまみ 28×56→22×44、track `margin-left:10px` の 3px 線で中央に。
- `makeScale(min,max)`（main.ts）: `.strip-mid` の左に `.fader-scale` を prepend。
  +6/0/-12/-24/-48 にラベル+目盛、-6/-18/-36/-60 に目盛のみ。つまみ 44px の
  端インセットを `top: calc(22px + p*(100% - 44px))` で補正。master は -24..+6。

### 2026-09-06（26）— つまみ幅戻し + ゲージを控えめ・レール線

- つまみ幅を戻す: `.strip-fader` 24→28、つまみ 22×44→28×46、track
  `margin-left` 10→13。`makeScale` のインセット補正も 23/46 に。
- ゲージ: `.fader-scale` に `border-right` の縦線（スケール線）、数字 font 8→7・
  色 #59616f・`right:4px` でレールに寄せ、目盛 dash を線から右へ短く。
- `.strip` 78→80 / padding 5→4（scale+fader+vu が収まるよう）。

### 2026-09-06（27）— つまみを scale の前面へ（Z順）

- ユーザー指摘: つまみがレール線の裏に描画されていた。`.strip-fader`
  `position:relative; z-index:2`、`.fader-scale` `z-index:1;
  pointer-events:none`。
- scale を独立カラム＋border線 → **フェーダー自身の track をレールに**し、
  scale box を `margin-right:-17px` でフェーダー左半分へオーバーラップ、
  目盛 dash を `right:0`（=track 付近）から左へ、ラベルは右寄せ。

### 2026-09-06（28）— フェーダー列を再構成（rail + cap + gauge の重ね順）

- `.fader-wrap`（28px, position relative）で fader をラップ。`::before` が
  **明示的なレール線**（x13, 上下 28px インセット=半つまみ）。fader 自身の
  track は透明に。つまみ png を **28×56 に戻す**（native）。
- `.fader-scale` を `.fader-wrap` 内の **絶対配置**（left0..right14 = レール左）に。
  目盛はレールから左へ、ラベル右寄せ。`z-index`: rail 0 / gauge 1 / cap 2。
- `.strip-mid` を `justify-content: flex-start; padding-left: 18px`、
  `.strip-vu { margin-left: auto }` で VU を右端へ → つまみと VU の被り解消、
  つまみ+ゲージが左寄りに。
- `makeScale` インセット 28/56。

### 2026-09-06（29）— フェーダーキャップを独立 div 化（webkit slider 由来のズレ回避）

- 縦 `<input type=range>` + `direction:rtl` の thumb は横位置が右へずれて VU に
  被る。→ **キャップを `.fader-cap`（plain div, `left:0`, JS で `top` 設定）** に。
  input は透明・当たり判定のみ（thumb は transparent）。`faderTop(v,min,max)` が
  cap と目盛の共通マッピング。master も同様（syncMaster で cap 更新）。
- これで cap は必ず `.fader-wrap` 左端 = VU と分離。

### 2026-09-06（30）— dB ゲージをキャップの左へ退避

- キャップ（28px）がゲージ数字に被って読めなかった。`.fader-scale` を
  `left: -30px` で `.fader-wrap` の外＝`.strip-mid { padding-left: 34px }` の
  領域へ。数字は右寄せ、目盛 dash は `left: 100%` から右へ短く。
- `.strip` 幅 80→94px（左のゲージ帯ぶん）。

### 2026-09-06（31）— ミキサー列を左詰め + 右にリダクションメーター用スペース

- `[gauge][cap][vu]` を左詰めに。`.strip-vu` の `margin-left:auto` を撤去 →
  VU はフェーダー直後。`.strip-mid` の右 ~16px を空けて将来の
  gain-reduction メーター用に確保。
- `.strip-mid padding-left 34→22`、`.fader-scale left -30→-22 / width 26→20`、
  `.strip` 94→90px。

### 2026-09-06（32）— キャップ左端固定 / ゲージをキャップ右へ / M/S/R 縮小

- キャップに被らず数字を読めるよう、`.fader-scale` を**キャップの右**（`left:30px`、
  `.strip-mid { gap: 22px }` の隙間）へ。数字は左寄せ、目盛は数字の左。
- キャップは `.strip-mid { padding-left: 2px }` で**ほぼ左端**。VU はゲージの右、
  さらに右 ~19px を reduction メーター用に確保。
- M/S/R: `.strip-btns { width: 84%; margin: 0 auto }` + font 13→12 で ~10% 小さく。

### 2026-09-06（33）— ゲージ左寄せ / キャップ -10% / M/S/R -10%

- `.fader-scale left 30→20→15px` で dB 目盛をレール際まで詰めた。
- フェーダーキャップ（feder.png）を 10% 縮小: `.fader-cap` 28×56→25×50、
  `background-size` も 25×50、`faderTop()` のインセット/キャップ高を 28/56→25/50、
  レール（`.fader-wrap::before`）の上下インセットも 28→25 に追従。キャップ
  `left 0→3px` でレール中心に寄せた。
- M/S/R ボタンをさらに ~10% 縮小: `.strip-btns width 84→76%`。
- `typecheck` グリーン。
- **メモ**: フェーダー列は `.fader-wrap` 内に rail(`::before`) / gauge(absolute) /
  cap(absolute JS 配置) を重ね、cap 位置は CSS の目盛 `calc()` と手動で一致させる
  構造。1 パラメータ変えると 3〜4 箇所（cap サイズ / `faderTop` / rail インセット /
  scale left）を追従させる必要がありセッションログが伸びている。破綻ではないが、
  幾何の単一ソース（`--cap-h` var + gauge を通常フローの列に）へ寄せると軽くなる。
- **触ったファイル**: `src/renderer/index.html`, `src/renderer/src/main.ts`

### 2026-09-06（34）— フェーダー列を3カラム化（重ね順を廃止、目盛がキャップに隠れない）

- 問題: gauge を `.fader-wrap` 内に absolute で重ねていたため、通過する
  `.fader-cap`（z-index 上）が dB 数字を覆って読めなかった（24〜33 の往復の元凶）。
- **構造変更**: `.strip-mid` を重なりゼロの3カラム flex に。
  `[.fader-scale 22px][.fader-wrap 28px][.strip-vu 11px]` + 右に余白（将来の
  gain-reduction メーター）。gauge はもう絶対配置でなく**レール左の独立カラム**。
  cap だけが `.fader-wrap` 内で縦移動する。z-index の綱引きを撤去。
- `.fader-scale > b`: 右寄せ（`right:8px`）でレール際に数字、目盛 dash は数字の
  右→レール向き。font 6→8px、色 `var(--dim)` で可読性up。
- **縦マッピングを1本化**: `faderTop()` は「値→中心線 top」を返す1つだけ。cap に
  `transform: translateY(-50%)` を付け、tick と同じ式で中心が合う。両端で cap が
  カラム内に収まる（±25px = 半キャップ）。rail(`::before`) と cap を
  `left:50%` で厳密にレール中心へ。
- JS: `makeScale()` を `.fader-wrap` の prepend でなく **`.strip-mid` の兄弟**として
  `insertBefore`。channel / master 両方。
- `typecheck` グリーン。要 HMR リロード目視（MoniBlue 自動ロード → 各ストリップの
  目盛がキャップに隠れず読めるか、tick と cap の高さが一致するか）。
- **触ったファイル**: `src/renderer/index.html`, `src/renderer/src/main.ts`
- ✅ ユーザー実機確認「合格」、commit `3b6feef`。

### 2026-09-06（35）— マスターフェーダーをチャンネルフェーダーに揃える

- 赤い装飾を撤去して見た目を統一: `.strip.master` の `border-left: 2px solid rec`、
  `.strip.master .fader-wrap::before`（赤レール）、`.strip.master
  .strip-fader::-webkit-slider-runnable-track`（赤トラック）、`accent-color: rec`
  を全削除。レール色は base の `var(--line)` = チャンネルと同じに。赤は
  「MASTER」ラベル文字だけ残す。
- **稼働範囲を一致**: master を `min -24 → -60`（`makeScale(-60,6)` /
  `faderTop(dbv,-60,6)`）。ゲイン変換も `dbToLin()` に共通化（`<= -60` で −∞）。
  これで -1 dB 既定のキャップ位置がチャンネル 0 dB 近傍とほぼ同じ高さに。
- **フェーダー可動長を一致**: master ストリップは M/S/R が無く `#master-val` 1 行
  だったため `.strip-mid` がチャンネルより ~62px 高く、可動レンジがずれていた。
  `#master-val { min-height: 62px }`（= チャンネルの `.strip-btns` 実測高）を
  予約して `.strip-mid` の高さを 1:1 に。
- `typecheck` グリーン。
- **触ったファイル**: `src/renderer/index.html`, `src/renderer/src/main.ts`
- ✅ ユーザー実機確認「合格」、commit `092c916`。

### 2026-09-06（36）— セッションクローズ（コミット整理）

**やったこと**
- （33）〜（35）のフェーダー UI 修正をユーザー実機確認 → 全て「合格」。
- コミット整理: `3b6feef`（ミキサーストリップ + フェーダー3カラム化、未コミット
  分をまとめて）、`092c916`（マスターフェーダー統一）。
- ユーザーが誤って追加した重複ファイル `feder.png`（リポジトリ直下、
  `src/renderer/public/feder.png` とバイト同一）とそのコミット `65ec4af` を
  取り消し・削除。Vite が配信するのは `public/` 側だけ。

**今の状態 / 動くもの**
- ミキサー: チャンネルストリップ（gain/pan/mute/solo、VU、ピークホールド）+
  マスターストリップ（`#pane-bottom` 右端固定）。マスターフェーダーは
  チャンネルフェーダーと**レール・キャップ・dB 目盛・レンジ(-60..+6)・可動端**が
  完全一致。
- フェーダー列は `[.fader-scale][.fader-wrap(rail+cap)][.strip-vu]` の重なり無し
  3カラム。縦位置は `faderTop()` 1式（cap も tick も `translateY(-50%)` で中心
  合わせ）。
- `typecheck` グリーン。HEAD = `092c916`、作業ツリークリーン。

**次の一手**（ロードマップ節から）
- タイムルーラー（`#pane-top`）、レーン削除・並べ替え、クリップモデル。
- 100 トラック本命（RAM 常駐 + VRAM 再生窓ストリーミング、要不変条件改訂）。
- エフェクトチェーン再配線（`Insert` / `MasterBus.inserts` は温存済み）。

**未解決**
- feder.png の読み取りストライプが画像の縦センターにあるかは未検証（ズレていれば
  計算が正しくても見た目がずれる）。現状ユーザー目視では問題なし。
- フェーダー列の幾何がまだ複数箇所に散っている（`faderTop` の 25/50、
  `#master-val` の 62px、`.fader-scale` 幅など）。CSS 変数 1 本に寄せる案は保留。

**触ったファイル**: `src/renderer/index.html`, `src/renderer/src/main.ts`,
`README.md`（本ログ）

### 2026-09-06（37）— チャンネルストリップ + インサートプラグイン（Phase A〜D）

**やったこと**（詳細は「チャンネルストリップ / インサート実装計画」節）
- **Phase A**: レーンの空き部分（`.lane-left` / `.lane-right` / ストリップ head）
  クリックでトラック選択・ハイライト（`.lane.selected`）。左ペイン（`#pane-left`、
  264px・縦スクロール）に選択トラックの詳細を描画。フェーダー/pan/M/S は
  ミキサーストリップと双方向同期。初回トラック追加で自動選択。
- **Phase B**: mix 経路を改修。トラック毎に `GATHER_WGSL`（VRAM→共有スクラッチ
  `[L|R]`）→ 内蔵ストリップ → インサート → `MIXADD_WGSL`（gain/pan/masterGain で
  master planar へ加算）。旧 `MASTER_WGSL` は撤去。スクラッチはトラック間で
  使い回し。`gpu/channel-strip.ts`（`ChannelStrip implements Insert`）+
  `CHANNELSTRIP_WGSL`（`@workgroup_size(1)` 直列、状態 ≤64 f32 を private memory へ
  コピーして hot loop）: トリム → アナログ倍音 drive（tube 系 drive² ニー）→ HPF →
  アナログコンソール風 4-band EQ（RBJ biquad、0dB で恒等）→ 鼻音 → ステレオリンク・コンプ。
  `gpu/biquad.ts` に RBJ 係数計算を集約。
- **Phase C**: 左ペイン詳細フル UI。Input（Trim/Drive/HPF スライダ）、
  EQ — 4-band（アナログコンソール風、`EQ in` + LF/LMF/HMF/HF、LF/HF はベル⇔シェルフ、freq は
  対数スライダ、LMF/HMF は Q）、Nasal（ロータリーノブ `makeKnob`、drag=深さ /
  pointerdown=`ChannelStrip.reseed()` で個体乱数リロール + `.nasal-active`
  ハイライト）、Compressor（thresh/ratio/attack/release/makeup + `comp in`）。
  詳細フェーダーに VU（`frame()` が選択レーンをミラー）。
- **Phase D**: インサートプラグイン系統。`Lane.inserts: Insert[]` +
  マスター `MasterBus.inserts`。左ペインにラック UI（`buildInsertRack`：insert
  カード = 名前 / bypass / ▲▼ 並べ替え / × 削除 + `buildFxParams` のパラメータ、
  下に `+ Reverb / + Delay / + 5-band EQ`）。ミキサー MASTER ストリップ head
  クリックで `selectLane('master')` → マスターラックを編集。
  `gpu/effects/delay.ts`（`DELAY_WGSL`：循環ライン + ダンプ FB + wet/dry +
  ping-pong、1 スレッドで L/R 直列＝クロスフィードがレースにならない、
  ライン長 1.6s）。`gpu/effects/eq5.ts`（`EQ5_WGSL`：RBJ 5 バンド直列
  shelf/peak×3/shelf、`@workgroup_size(2)`）。Reverb は既存 `ReverbInsert` 再利用。
  `scheduler` は play 時に全トラックの strip + inserts を `reset()`、
  `hasActiveInsert()` はトラック insert も見て tail を鳴らし切る。

**今の状態 / 動くもの**
- `npm run typecheck` / `npm run build` グリーン（renderer 17 modules）。
  `npm run dev` で app 起動確認（GPU disk-cache エラーは既存の環境ノイズ）。
- デフォルトの内蔵ストリップは完全透過（flags=0 && trim=0 → dispatch skip）
  なので、autoload + Play の既存再生経路への回帰リスクは低い。

**次の一手 / 要実機確認**
- MoniBlue 自動ロード → Play で音が出るか（mix 経路改修の回帰）。
- レーン空き部分クリックで左ペインに詳細が出るか。EQ / Comp / Drive / Nasal /
  各インサート（Reverb/Delay/5band）が実際に鳴るか、音の傾向。
- 鼻音つまみ: いじるとハイライト + 個体差（同じソースを複数トラックに入れて
  分離が上がるか）。
- GPU 負荷: 内蔵ストリップはトラック毎 `@workgroup_size(1)` 直列 dispatch。
  多トラックでモジュールを盛ったとき重ければ、連結スクラッチ +
  invocation=トラックの 1 dispatch バッチ版へ（Phase E）。
- Stop 後のインサート tail（トラック reverb/delay）が鳴り切るか。

**未解決 / 判断ポイント**
- 内蔵ストリップの負荷は未計測（上記）。
- Delay の ping-pong は 1 スレッド直列で実装（正しいが GPU を遊ばせる）。
- コンソール EQ は往年のアナログ卓相当の周波数レンジ/カーブを RBJ で近似。厳密モデルではない
  （特定製品名は出さない）。
- 鼻音の「ドリフト」（超低速 LFO）は未実装（係数が静的なため）。個体乱数
  （freq/Q/gain/allpass/asym）+ 位相デコリレーションのみ。

**触ったファイル**: `src/renderer/index.html`, `src/renderer/src/main.ts`,
`src/renderer/src/gpu/shaders.ts`, `src/renderer/src/gpu/master-bus.ts`,
`src/renderer/src/gpu/channel-strip.ts`（新規）, `src/renderer/src/gpu/biquad.ts`（新規）,
`src/renderer/src/gpu/effects/delay.ts`（新規）, `src/renderer/src/gpu/effects/eq5.ts`（新規）,
`src/renderer/src/audio/scheduler.ts`, `README.md`（計画節 + 本ログ）

**フォローアップ（同セッション、実機フィードバック反映）**
- 選択できない不具合を修正: 選択ハンドラが波形（`.lane-center`）クリックを除外
  していた。委譲をやめてレーン／ストリップ各要素に直接 `pointerdown` を張り、
  **どこをクリックしても選択**（波形は選択＋シーク併走）。ハイライトも強化
  （行全体ティント + 枠線 + アクセントバー + トラック名アクセント色）。→ ✅ 合格。
- EQ / コンプの UI をロータリーエンコーダ化（`makeKnob` に label、`freqKnob`
  追加、`.knob-grid` 折返しレイアウト）。EQ 各バンド Freq(対数)/Gain(センター
  0dB)/Q、コンプ Thresh/Ratio/Attack/Release/Makeup。ダブルクリックで既定値へ。
  Input とインサートのパラメータはスライダーのまま。→ ✅ 見た目 OK（当面これで）。
- DSP そのもの（各 insert / strip モジュールが鳴るか、負荷）は引き続き実機確認中。

### 2026-09-06（38）— ミキサーストリップに Cubase 風インサートスロット + SSL 表記撤去

**やったこと**
- **インサートスロット列をミキサーストリップへ**: これまで飾りだった `.strip-fx`
  枠を、各チャンネルストリップ＋マスターストリップの**固定 8 スロットのラック**
  （`.strip-rack` / `.strip-slot`）に置換。スロット＝シグナルチェーン（配列順）。
  - 空きスロットクリック → 小ポップメニュー（`.fx-menu`、`openFxMenu()`、
    クリックアウェイで閉じる、位置は JS 計算）で Reverb / Delay / 5-band EQ を選択
    → `list.push()`。
  - 使用中スロット = `[● bypass][名前][▾]`。`●` で bypass トグル、`▾` で
    replace / remove メニュー、名前クリックで**そのトラックを選択して左詳細
    ペインの Inserts へスクロール**（`#td-inserts`）。
  - 実体は従来どおり `Lane.inserts: Insert[]` / `MasterBus.inserts`（packed 配列、
    scheduler がそのまま読む）。並べ替えは左ペインのカード ▲▼。スロット列と
    左ペインラックは `refreshInsertsUI(owner)` で相互同期。
  - **内蔵チャンネルストリップ（`ChannelStrip`）はスロット対象外**＝トラック一体
    のまま（`FX_KINDS` に入れない）。対象は Reverb / Delay / 5-band EQ のみ。
- **フェーダーエリア拡大**: `--pane-vert` 353 → 510（ラック分 +115px、加えて
  フェーダー可動長も 191→263px に拡大）。BrowserWindow 高 980 → 1064。
  波形域はその差ぶん縮む。
- **SSL / 4000G 表記を全撤去**（許諾なし）: UI ラベル `EQ — SSL 4000G` →
  `EQ — 4-band`、コード/README のコメント・記述を「アナログコンソール風」/
  「console-style」に置換。特定製品名は残さない。DSP は無変更（RBJ biquad の
  4 バンドのまま）。
- `npm run typecheck` / `npm run build` グリーン（renderer 17 modules）。
  `npm run dev` で app 起動確認（disk-cache / GPU exit_code=143 は timeout kill
  由来の既存ノイズ）。

**今の状態 / 動くもの**
- 各ストリップに 8 スロットのインサートラックが並ぶ。空き→メニューで挿入、
  使用中→bypass/replace/remove、名前クリックで左ペイン編集へ。マスターも同様
  （head クリックで選択、`#master-rack`）。
- 内蔵ストリップ（trim/drive/console EQ/nasal/comp）は従来位置（左詳細ペイン）
  のまま、スロットには出ない。

**次の一手 / 要実機確認**
- MoniBlue 自動ロード → 各ストリップに 8 スロット出るか、メニューから挿入 →
  Play で鳴るか、左ペインとスロットの同期。
- ウィンドウ高 1064px が 1080p で収まるか（収まらなければ `--pane-vert` を
  少し下げる）。
- スロット 8 個ぶんの縦を取ったのでフェーダー/ボタンの視認性。

**未解決 / 判断ポイント**
- スロットは packed 配列なので「空きスロット 3 をクリック」でも末尾追加になる
  （視覚上は次の空き位置に入る）。ギャップ許容にするなら scheduler 側で null
  スキップが要る。当面 packed + 左ペイン ▲▼ で十分と判断。
- 8 スロット固定。使用中 + 1 の動的表示や pre/post fader 分割は未対応。

**触ったファイル**: `src/renderer/index.html`, `src/renderer/src/main.ts`,
`src/main/index.ts`, `src/renderer/src/gpu/channel-strip.ts`,
`src/renderer/src/gpu/shaders.ts`, `src/renderer/src/gpu/effects/eq5.ts`,
`README.md`（計画節の SSL 表記 + 本ログ）

**フォローアップ**
- マスターフェーダー既定値を **-1 dB → -10 dB** に（ユーザー報告: マスターが赤に
  張り付く＝クリップ）。`index.html` の `#master` value + `#master-val` 表示、
  `main.ts` の `syncMaster()` コメント、README「現状」節。ヘッドルーム確保が目的で
  ミックス構造は無変更。
- **左ペインを全高化**（ユーザー要望: 縦が足りない）。レイアウトを再構成:
  `#workspace` を **flex row** にし、`[#pane-left（全高）][#workspace-main（縦: pane-top
  / workspace-mid / pane-bottom）]`。左ペインはルーラーとミキサーの境界を貫いて
  ウィンドウ全高（transport 直下〜最下部）。代償としてミキサー（`#pane-bottom`）と
  タイムルーラー（`#pane-top`）の幅が 264px 狭くなる（ミキサーは `#strips-scroll`
  が横スクロールするので許容）。JS からの参照 id は不変。`build` グリーン。
- **起動時にウィンドウを最大化**（ユーザー要望: スペースが足りない）。
  `src/main/index.ts` で `win.maximize()` を `ready-to-show` 前に呼ぶ。`width/height`
  1728×1064 は非最大化時のフォールバックとして残す（`fullscreen` ではなく最大化：
  タイトルバー / タスクバーは見える）。
- **内蔵ストリップのサチュレータ（Drive）を強化**（ユーザー: 効きが弱い / 変化が
  分からない）。`channel-strip.ts` の drive 係数を再調整: ニーを `d²` → `d^1.25`
  （下 70% がほぼ無音だったのを解消）、pre-gain スパン +24 dB → **+38 dB**、
  bias 0.08·d → 0.2·d（偶数次「温かみ」）、HF pre-emphasis 0.4·d → 0.5·d、
  makeup `pre^-0.55` → `pre^-0.5`（drive を上げると少し前に出る＝体感できる）。
  WGSL / struct / f[] インデックスは無変更、定数のみ。**要実機**: solo + Drive
  0.5〜0.7 でグラインドが分かるか、full で潰れすぎないか。
- **タイムルーラー（`#pane-top`）を実装**（プレースホルダ文字だった）。
  `#ruler-canvas`（2D）に適応刻み（`RULER_STEPS` から ~100px 間隔になる秒を選択）で
  major/minor ティック + `m:ss`（サブ秒ズームでは `m:ss.d`）ラベル + プレイヘッド
  マーカー（▲）。左ゲッター（`--lane-left` 幅）に `#ruler-tc` = ライブ
  `m:ss.mmm`。**クイックトランスポート**: ルーラーを pointerdown + ドラッグで
  プレイヘッドを移動（`setPointerCapture`、`rulerSeek()`）。
- **タイムグリッド overlay**（`#grid`、`#tracks` 内）。ルーラーの major ティックと
  同じ x に縦線（グレー `rgba(155,164,178,.32)`）を**波形の上**（`z-index:4`、
  プレイヘッドは `z-index:5`）にプールした `<i>` で配置。波形カラム
  `[LANE_LEFT, clientWidth-LANE_RIGHT]` にクリップ。ズーム/スクロール/リサイズ時
  のみ再構成（`gridSig`）。ルーラーも変化時のみ再描画（`rulerSig`、演奏中は
  playhead が毎フレーム動くので追従）。
  `frameToX()` を lane playhead / ルーラー / グリッドで共有して 1:1 整合。
- **クリックで再生位置ジャンプ**（ルーラー＆波形どちらも）。`PlaybackScheduler.seek(frame)`
  を追加: 停止中は playhead を移動するだけ、再生中は `finish()`（デバイスクローズ）→
  `start(f)` の**ハードロケート**（ジャンプ時に一瞬途切れる、インサート tail は
  クリア＝そこで Play したのと同じ）。ルーラーのドラッグ中は `scrubbing` フラグで
  `frame()` の `currentFrame()` 追従を抑止しプレビュー、pointerup で実 seek をコミット。
  ASIO は毎ロケートで `openStream` し直すので数百 ms のギャップは許容。

### 2026-09-06（39）— チャンネルストリップの Drive を「12AX7」に voicing 戻し

**やったこと**
- ユーザー報告「チャンネルストリップのサチュレータが効いていない。最初の検証の
  12AX7 サチュレータは良かったのに」。配線は生きている（gather → `ChannelStrip.process`
  → mix-add、`laneToSource` が `strip: l.dsp` を渡す）ので**ハード不具合ではなく
  voicing の劣化**が原因と判断。
- 合格版 `TubeInsert`（`TUBE_WGSL` / `effects/tube.ts`、commit `404df73`「真空管
  ドライブの検証」でユーザー実聴合格）と現行 `CHANNELSTRIP_WGSL` の drive 段を
  比較。WGSL の `driveStage` は数式上 `TubeInsert` と等価だが、`channel-strip.ts`
  の**係数の当て方**が違っていた:
  - バイアス（非対称 = 2 次倍音「温かみ」）が旧 `0.2·d` で **drive 低〜中では
    ほぼ 0** → 対称 tanh = 奇数次だけの「ジー」に。`TubeInsert` は
    `0.12 + 0.12·d`（**フロア 0.12**）。
  - HF プリエンファシス量が旧 `0.5·d` で低ノブ域は眠い。`TubeInsert` は
    `0.6 + 0.5·d`（**フロア 0.6**、常にシェイパーへ明るく入れる）。
  - コーナー類も違い（DC ブロック 8→22 Hz、emphasis 2000→1800、Miller
    11k→12k）、pre-gain スパン 38→30 dB、makeup `pre^-0.5`→`pre^-0.6`。
- `channel-strip.ts` の drive 係数のみ差し替え（**WGSL / struct / `f[]` インデックス
  は無変更**）。ニーは `d^1.25`→`d^1.15`（ノブ全域を使えるまま、セッション 38 の
  「下半分が無音」も回避）。`typecheck` グリーン。

**今の状態 / 動くもの**
- 内蔵ストリップ Drive を上げると、低〜中設定でも 2 次倍音の付いた真空管的な
  歪みになる（はず）。デフォルト `drive = 0` は従来どおり完全透過（FLAG_DRIVE
  off で dispatch skip）。

**次の一手 / 要実機確認**
- MoniBlue 自動ロード → 1 トラック solo → 左詳細ペイン Input の Drive を
  0.2 / 0.4 / 0.7 / 1.0 と上げて: (a) 低設定で「効いていない」感が消えたか、
  (b) 中設定で 12AX7 的な太い歪みか（fizz じゃないか）、(c) full で潰れすぎないか。
- 旧 `TubeInsert` と印象を突き合わせたい場合は一時的にインサートとして復活
  比較も可（`FX_KINDS` 未登録なので今は挿せない）。

**未解決 / 判断ポイント**
- 依然 voicing はユーザーの耳合わせ待ち。スパン 30 dB / バイアス係数 0.14 /
  emphasis 0.5 は仮。効きが強すぎ・弱すぎならこの 3 定数で調整。
- `CHANNELSTRIP_WGSL` は `@workgroup_size(1)` の単一スレッドでブロック
  （32768 フレーム）を直列処理 × トラック数。今回は無関係だが、モジュールを
  盛ると負荷の壁になり得る（Phase E のバッチ化候補）。

**触ったファイル**: `src/renderer/src/gpu/channel-strip.ts`, `README.md`（本ログ）

**フォローアップ（同セッション、実機フィードバック）**
- ユーザー: 「サチュレータは効くようになったが抜けが悪い。最初のはもっと
  ギラっと効いた」。tanh が作る倍音が出口で削られていた。修正（`channel-strip.ts`
  drive 係数のみ）: 出力 Miller LP を固定 12 kHz → **16→13 kHz（drive 連動、
  広めに）** で歪みの艶を通す。makeup を `pre^-0.6` → **`pre^-0.45`**（30 dB
  スパンだと `-0.6` は駆動信号を ~3 dB 引っ込めて recessed に聞こえていた）。
  プリエンファシス量フロア `0.6` → **`0.75`**（トップエンドのきらめき）。
- ユーザー: まだ薄い。「1 回路しか通っていないのが原因。せっかく GPGPU なので
  3 回路くらい特性を変えて重ねられないか（12k/8k/4k）」「1176 実機のような
  抜ける歪みが乗ってほしい」。
- **drive 段を 1 段 tanh → 3 段カスケードに全面刷新**（`CHANNELSTRIP_WGSL` +
  `channel-strip.ts`）。実機プリの トランス → FET/球ゲイン段 → 出力トランス /
  Class-A を模して、各段が自分の HF エンファシスコーナー（~4 / 8 / 12 kHz）を
  持つ:
  1. body（~4 kHz）: 弱い非対称ドライブ → 2 次
  2. grit（~8 kHz）: ドライブ強め・バイアス符号反転 → 2 次 + 3 次
  3. cut（~12 kHz）: 対称 + ハードショルダ整形 `x/(1+|x|)` をブレンド
     （`d3Steep`）→ 攻めた奇数次 =「抜ける」1176 的エッジ
  各段 pre-gain は knee `d^1.15` で +12/+11/+9 dB。makeup は合計 pre-gain の
  `^-0.4`（緩め、前に出る）。出力 Miller LP は 17→14 kHz と広く、非平滑成分を
  35% 混ぜて艶を残す。
- **UBO 構造体を作り替え**（`CS`、56 word / 224 B）。drive を 8→16 word に
  拡張、以降 hpf=19 / eq=24 / nasal=44 / comp=51 へシフト。WGSL 側は構造体
  定義と `driveStage` のみ変更（`chain()` の biquad はフィールド名参照なので
  オフセット追従は自動）。状態マップ（`s[]` の per-channel 24 word）は不変:
  drive は `s[b..b+2]` = 3 段エンファシス LP、`s[b+3]` = Miller LP。
- `typecheck` / `build`（renderer 17 modules）グリーン。**未実機**（WGSL
  コンパイルは実行時に判明するので要起動確認）。
- **要実機**: (a) 起動して strip パイプラインがコンパイルされるか（コンソール
  エラー無し）、(b) Drive 0.3 / 0.5 / 0.8 で「1176 を突っ込んだ」感の抜ける
  グリットか、薄くないか、(c) full で歪みすぎ / 耳痛くないか、(d) 多トラックに
  盛ったときの GPU 負荷（strip は今なお `@workgroup_size(1)` 直列 × 3 段 tanh、
  重ければ Phase E の 1-dispatch バッチ化）。
- 調整ポイント: 各段 dB スパン（12/11/9）、エンファシスコーナー（4k/8k/12k）、
  `d3Steep`（0.25 + 0.55·d）、makeup 指数 `-0.4`、Miller `17000 - 3000·d`。

**フォローアップ（3 段カスケードの実機フィードバック）**
- ユーザー: 「EQ と組み合わせてギリギリ実用範囲。ただし 8 kHz 付近が
  グサッと来ない。要は 1176 を通さなくて済むようにしたい」。
- 原因: stage 2 が広い HF シェルフ（`y + emph·(y - LP8k)`）で、"抜ける空気"
  にはなるが "刺さる" プレゼンスにならない。
- **stage 2 を「プレゼンス STAB」に作り替え**: 2 本の 1-pole LP の差
  （`LP10k - LP4.5k`、~6–7 kHz にピークのバンド）を `d2Emph·d2G` で強く増幅し、
  **ドライ信号（unity）に足してからハードショルダ整形**（stage 3 と同じ
  `q/(1+|q|)` を `d3Steep` でブレンド）。倍音がプレゼンス帯に集中して "グサッ" が
  出る。ドライ帯域レベルは ~unity のままなので `d2G` は makeup 計算に**入れない**
  （入れると出力が ~14 dB 落ちる）。makeup は stage 1・3 の広帯域ゲインのみ補償
  （`(d1G·d3G)^-0.42 · (1 - 0.15·d)`）。
- stage-2 の 2 本目の LP 状態は private array の空き `s[60]/s[61]` を使用
  （state マップ拡張なし）。UBO は `d2FcLo` を**構造体末尾に追記**（既存
  オフセット不変、`f[56]`）。
- `typecheck` / `build` グリーン。**未実機**（WGSL コンパイルは起動時判明）。
  調整: `f[9]` band 深さ（1.8 + 2.5·d）、`f[10]` band ドライブ（+10 dB）、
  バンドコーナー（10k / 4.5k）。
- **nasal について**: 「Nasal — track separation」で正しい。これは **サチュ
  レータではない** — トラック毎に個体乱数で決まる鼻づまり系レゾナンス（~530–
  1360 Hz のピーク）＋位相デコリレーション allpass ＋極小の非対称項で、
  同じ音を複数トラックに立てたときの相関を崩して分離を上げるためのもの。
  歪みの "グサッ" は drive 側の担当。

**フォローアップ（直列→並列マルチバンドに全面刷新）**
- ユーザー: 「使わない帯域（あとで EQ で削る低〜中域）が太るだけ。-7 LUFS で
  スネア/ボーカルが前に出る音じゃないとダメ。今のはマイルドすぎる」「3 段は
  直列？並列希望」。
- drive を **直列カスケード → 並列 4 バンドサチュレータ**に作り替え
  （`CHANNELSTRIP_WGSL` の `driveStage` + `shaper()` ヘルパ、`channel-strip.ts`
  の係数）:
  - 3 本の 1-pole クロスオーバーで low(<180Hz) / lo-mid(180–2.2k) /
    presence(2.2–7k) / air(>7k) に分割 → **各バンドを個別ドライブ＋対称
    ハードショルダ整形（奇数次）して総和**（テレスコーピングで無歪み時は
    完全再構成）。
  - **low バンドはほぼドライ**（`loMk` 0.18）→ 低〜中域が歪みで太らない。
  - presence/air を +22/+18 dB まで強めに、`Mk` を `1/gain × (1.5〜)` で
    小信号ユニティ＋前に出す係数。
  - 出力に **density ソフトクリップ**（`y/(1+|y|·density)`、Drive で最大
    +3 まで）＝クレストファクタを削って RMS を上げる →「前に出る」。
  - **makeup は Drive とともに 1.0 超へ**（`gain^-0.2 × (1 + 0.6·d)`）＝
    上げるほど突っ込む。ニー `d^0.9`（0.4 で噛む）。
- 状態マップ変更なし（`s[b..b+2]` = クロスオーバー LP、`s[b+3]` = 出力平滑）。
  UBO は drive 16 word を作り替えのみ（総 57 word / 228 B、hpf 以降のオフセット
  不変）。旧 `d2FcLo` は `_dpad2` に。
- `typecheck` / `build`（renderer 17 modules）グリーン。**未実機**（WGSL
  コンパイルは起動時判明）。
- **要実機**: (a) strip パイプラインがコンパイルされるか、(b) Drive 0.3〜0.7 で
  スネア/ボーカルが前に出るか・低域が濁らないか、(c) full で歪み崩壊しないか、
  (d) GPU 負荷（`@workgroup_size(1)` 直列、シェイパ 4 本 + クロスオーバー 3 本）。
- 調整: バンドコーナー（180/2200/7000）、各バンド dB（6/16/22/18）、`Mk` の
  push 係数、`density`（0.5 + 2.6·d）、`drMakeup` の `(1 + 0.6·d)`、`shHard`。
- ✅ **ユーザー実聴合格**（2026-09-06）: 「もっさりしたパラ音源がヨルシカ
  ぐらいの抜け感が出た」。並列 4 バンド版で一旦確定。以降の微調整は上記
  ノブで。未コミット（作業ツリーに `shaders.ts` / `channel-strip.ts` の
  drive 刷新 + `README.md` 本ログ）。

**このセッションの drive まとめ（次セッション用）**
- 内蔵ストリップの Drive は **並列 4 バンドサチュレータ**。低域ドライ、
  presence/air を強めに奇数次で歪ませ、出力 density クリップ + Drive 連動
  makeup で「前に出る」。`ChannelStrip`（`Insert` 実装）はトラック一体で
  スロットには出ない。
- 旧 `TubeInsert` / `TUBE_WGSL`（12AX7 単段、master insert 用）はコード上
  残置・未配線。並列版とは別物。
- UBO `CS` は 57 word。drive = word 3..18（+ `_dpad2` = word 56 は死に
  フィールド）。hpf=19 / eq=24+i·5 / nasal=44 / comp=51。状態 `s[]` は
  per-ch 24 word（drive は `s[b..b+3]`）+ 共有 48..59（60..63 空き）。

### 2026-09-06（40）— 細かい UI 調整

**やったこと**
- **キーボードトランスポート**: Space = 再生/停止トグル（`togglePlay()` に切り出し）、
  Enter = 曲頭へ（`scheduler.seek(0)`）。`INPUT/TEXTAREA/SELECT`/contentEditable に
  フォーカスがある時と `e.repeat` はスキップ。Space は `preventDefault`（フォーカス
  中ボタンのクリック・ページスクロール抑止）。
- **選択トラックのハイライトを明るく**（`index.html`）: `.lane.selected` の背景
  `rgba(77,163,255,.09)` → `.20`、`.lane-left`/`.lane-right` の背景 `#1a2735` →
  `#24384f`、nasal-active との重なり色も追従。
- **インサートスロット（プラグイン選択枠）を少し明るく**（`index.html`）:
  `.strip-rack` border `--line` → `#333b4b`・bg `#0e1116` → `#1a1f29`、
  `.strip-slot` bg `#161a22` → `#222735`・文字 `--dim` → `#9aa3b4`、
  `.filled` bg `#1b2735` → `#26374b`、slot-num/slot-add の opacity も上げ。
- **Delay / Reverb を単一 Dry↔Wet バランスに**: 別々の `Wet`/`Dry` スライダ →
  `mixRow()`（左ラベル "Dry"、右に "Wet NN%"、小さいほどドライ）。内部は
  線形クロスフェード `dry = 1 - wet`。両 insert の既定 `dry` を `1 - wet` に
  合わせた（delay 0.75 / reverb 0.68）。UI 構築時にも `p.dry = 1 - p.wet` で吸着。

**触ったファイル**: `src/renderer/src/main.ts`, `src/renderer/index.html`,
`src/renderer/src/gpu/effects/delay.ts`, `src/renderer/src/gpu/effects/reverb.ts`,
`README.md`（本ログ）

**要実機**: Space/Enter の挙動、選択ハイライトの見え方、スロットの視認性、
Delay/Reverb の Mix スライダが dry↔wet で効くか。

**フォローアップ**
- ユーザー: フェーダーのつまみ以外（空きレール）をトラック選択のつもりで
  クリックするとフェーダーが動いてしまう。→ `guardFaderRail(fader, cap)` を
  3 フェーダー（チャンネル / 左詳細 / マスター）に追加。`<input type=range>` の
  pointerdown が cap の矩形（±8px）の外なら `preventDefault()`（ネイティブ
  レンジのジャンプ抑止）。伝播はそのままなので `.strip` の pointerdown →
  `selectLane` は従来どおり発火。cap を掴んだ時だけフェーダーが動く。
- **5-band EQ プラグインの UI をロータリ化**（`buildFxParams` の `Eq5Insert`
  分岐）: Freq/Gain/Q スライダ 3 本 → チャンネルストリップ EQ と同じ
  `.eq-band` + `.knob-grid`（`freqKnob` + `makeKnob`×2）。Gain は
  min-18/max+18/**default 0**、Q も `makeKnob`（band 既定 0.7/1/1/1/0.7）、
  どちらもダブルクリックで既定へ。EQ5 の帯域既定はもともと全 band 0 dB
  ＝数学的に完全パススルー（`biquad()` の RBJ は 0 dB で恒等）なので、
  追加直後はフラット。未使用になった `freqRow()` を削除。

### 2026-09-06（41）— プロジェクト保存/読込 + 起動時に前回プロジェクトを復元

**やったこと**
- **プロジェクト永続化（全設定）**を実装。JSON 1 本に:
  - `sampleRate`
  - 各トラック: `title` / ソース（`path` の WAV、または `kind:'tone'` +
    `toneSeconds`）/ `mix`（gainDb·pan·mute·solo·rec）/ チャンネルストリップ
    （`bypass` + `seed` + `params` 全体）/ インサート列（`kind` +
    `bypass` + `params`。reverb·delay·eq5 を復元）
  - マスター: フェーダー dB + インサート列
  - タイムライン表示: `framesPerPixel` / `scrollFrames` / `playhead`
- **main**（`src/main/index.ts`）に IPC 追加。`app.getPath('userData')/project.json`
  を正本に:
  - `daw:project:load` … 正本を読む（無ければ null）
  - `daw:project:save` … 正本へ書く（Ctrl+S / 💾 Save ボタン）
  - `daw:project:export` … ダイアログで任意パスへ保存 + 正本も更新（Save As…）
  - `daw:project:import` … ダイアログで開く + 正本も更新（📂 Open）
  → export/import も正本を更新するので、**次回起動は常に「最後に触ったプロジェクト」**
    で立ち上がる。
- **preload**: `projectLoad` / `projectSave` / `projectExport` / `projectImport`。
- **renderer**（`src/renderer/src/main.ts`）:
  - `Lane` に `path` / `kind` / `toneSeconds` を追加。`addWavLane(path, title?)`
    ヘルパに WAV 読込→デコード→レーン生成→GPU リサンプルを集約（`loadFiles` /
    autoload / 復元で共用）。
  - `serializeProject()` / `restoreProject(p)` を追加。復元は
    再生停止 → 既存レーン破棄（DOM + `track.channels` / `peakBuffer` を destroy、
    `nextId` リセット）→ SR 適用 → トラック再構築（WAV は再読込、tone は再生成）→
    mix / strip / inserts 適用 → マスター → view → 選択復帰 → `warmup`。
  - `deepMerge` で `defaultStripParams()` に保存値を被せる（欠損フィールドに耐性）。
  - トランスポートに 💾 Save / Save As… / 📂 Open ボタン、Ctrl/⌘+S。
- **起動フロー変更**: `?selftest` 以外では **まず `projectLoad()`。あれば
  `restoreProject()` して autoload はスキップ**。無い時だけ従来の 24 トラック
  autoload（`DAW_AUTOLOAD` のフォルダ）にフォールバック。復元失敗時も autoload。

**今の状態 / 動くもの**
- `typecheck` / `build`（renderer 17 modules）グリーン。**未実機**。
- 保存前の初回起動は従来どおり MoniBlue_AprilBlues が autoload される。

**次の一手 / 要実機確認**
- 起動 → 何かいじる（フェーダー / EQ / インサート追加 / ズーム）→ 💾 Save →
  アプリ再起動 → **autoload されず、保存状態が復元される**か。
- Save As… で書き出したファイルを 📂 Open → その場で差し替わるか。
- tone トラック（GPU demo tone）を含むプロジェクトの往復。
- autoload に戻したい時は `%APPDATA%/gpudaw/project.json` を消す（暫定。将来
  「New / Reset project」ボタンを付けるか判断）。

**未解決 / 判断ポイント**
- クリップ/オフセットのモデルはまだ無いので、トラック = ソース WAV 全長。
  クリップ導入時に保存スキーマを v2 へ。
- 破棄時に `WaveformRenderer` の GPU リソースは解放していない（レーン毎 canvas
  context のみ）。頻繁な Open で少しずつ増える可能性。

**触ったファイル**: `src/main/index.ts`, `src/preload/index.ts`,
`src/renderer/index.html`, `src/renderer/src/main.ts`, `README.md`（本ログ +
ロードマップに Input Gain ノブ）

**フォローアップ（save failed 報告）**
- ユーザー: 「save failed とか出て保存できない」。原因はほぼ HMR の性質 —
  renderer だけホットリロードされて **preload / main の新 IPC が古いまま**
  （`window.daw.projectSave` が無い / `daw:project:save` ハンドラ未登録）。
  `%APPDATA%\gpudaw` の書き込み自体は可（node で確認済み）。
- 対策:
  - renderer: `typeof window.daw.projectSave !== 'function'` を検出して
    「restart `npm run dev`」と明示。serialize 失敗と IPC 失敗を分離表示、
    両方 `console.error` も出す。
  - main: `daw:project:save` / `export` を **throw せず `{ok:false,error}` を返す**
    （renderer がメッセージをそのまま表示）。書き込みは
    `mkdir(recursive)` → userData → Documents/gpudaw → app 直下の順に
    フォールバックし、成功パスをセッション中キャッシュ。stdout にログ。
  - 正本ファイル名を `project.json` → `gpudaw-project.json`（userData 直下）に。
- **要対応**: 次回は dev サーバを完全再起動してから保存を試す。

### 2026-09-07 — 内蔵ストリップ: nasal 撤去 → サチュレーション（1ノブ + drive/color）

**背景 / 判断**
- README のユーザーコードを GPGPU オーディオ処理まわりの公開特許と突き合わせて点検
  （軽いサーチ、正式 FTO ではない）。実質的な懸念は **旧 nasal 段のみ**:
  - Brainworx TMT（**US 10,725,727 B2**、生存）= 回路モデル + 部品公差レンジ +
    ランダム化 + （従属）チャンネル番号で N 個目のエミュを選択。nasal のコード自体は
    回路/部品モデルを持たず literal 侵害は薄いが、README/コメントの「アナログ
    コンソールのチャンネル**公差エミュ**」というフレーミングが TMT の売り文句と
    一致していて不利な証跡になり得る。
  - GPGPU アーキ全体（GPU Audio Inc. **US 12,026,518 B2** の依存グラフ GPU
    スケジューラ等）は、今の単純ブロック先読みスケジューラでは各クレームに
    読み込まれない。Freeverb / ポリフェーズ FIR / RBJ biquad / コンプ / ディレイ /
    並列サチュはいずれも公知・パブリックドメイン。→ 詳細は会話ログ。
- ユーザー方針: nasal はネーミングも音も意図と違うので撤去。本来欲しいのは
  「全トラックに 1176/1073 を通すような 1 ノブのサチュレーション」。個体差は
  残すが **利用者が選ぶのではなく乱数を埋め込む**点で TMT と差別化。

**やったこと**
- **nasal 段を全撤去**（`seed` / `reseed()` / `mulberry32` / honky レゾナンス /
  `.nasal-active` / 保存スキーマの `strip.seed`）。
- **サチュレーション段に置換**（`CHANNELSTRIP_WGSL` + `channel-strip.ts`）。1 ノブ
  `drive`(0..1) + `satMode`:
  - `drive` mode = 既存の並列 4 バンドサチュレータ。HF グリットを **わずかに**強化
    （airG +1 dB、shHard フロア 0.45→0.48、outFc 15k→16.5k）。
  - `color` mode = 新規 `colorStage`（トランス + Class-A、1073 系）: DC ブロック →
    LF ブルーム（`tanh` で低域を軽く飽和して戻す＝重心・2 次）→ HF プリエンファシス
    → 非対称 Class-A（bias=2 次 / tanh=3 次）→ 出力ショルダ + 半分直通トップ
    （「ぎらつき」保持）→ makeup。`drive=0` で完全透過（FLAG_DRIVE off で dispatch
    skip）。
  - **個体差** `ChannelStrip.vary`: 生成時 `Math.random()` から 1 回だけ作る
    { gain ±0.3% / bias ±0.002 / HF corner ±1.5% / allpass ±0.03 }。両モードの
    係数を微妙にずらす + `satVary()` = マグニチュードフラットな 1 次 allpass を
    サチュ経路の最後に常時。**永続化しない・UI に出さない・reseed 無し**。
    単体では不可聴、30 トラック重ねてもダンゴにならないためだけ。
- **UI**（`main.ts`）: 左詳細ペインの「Nasal」節 → **「Saturation」節**（`Drive`/`Color`
  トグル + 1 ノブ + ヒント）。Input 節から Drive スライダを撤去（Trim/HPF のみ）。
- **UBO `CS` = 61 word**（旧 57 + 末尾に 4 追記、既存オフセット不変）:
  trim=2 / drive=3..18（`_dpad2`=56 は死にフィールド）/ hpf=19 / eq=24+i·5 /
  **color=44..50（旧 nasal 枠）+ 57..60** / comp=51..55。
  状態 `s[]`（per-ch 24 + 共有 48..）: drive `s[b..b+3]`、**color `s[48+ch*4..+3]`
  = dc/bloom/emph/out**、**satVary allpass z = s[56]/s[57]**、comp s[58..59]、
  s[60..63] 空き。
- 保存スキーマ: `strip.seed` 削除。旧プロジェクトの `params.drive`（量）はそのまま
  引き継ぎ、`satMode` は `applyStripParams` で `'drive'` に既定（＝従来挙動）。
  旧 `params.nasal` は無視。

**今の状態 / 動くもの**
- `npm run typecheck` / `npm run build`（renderer 17 modules）グリーン。
  **未実機**（WGSL コンパイルは起動時判明 — `colorStage` / `satVary` / 61-word
  struct が通るか要確認）。

**次の一手 / 要実機確認**
- 起動 → strip パイプラインがコンパイルされるか（コンソールエラー無し）。
- 1 トラック solo → Saturation を Drive / Color で切替、0.3 / 0.5 / 0.8:
  (a) Drive はハイが少しギラつくようになったか（前の合格版から離れすぎてないか）、
  (b) Color は 1073 的な暖かい倍音 + トップの艶が出るか、
  (c) full で歪み崩壊・耳痛が無いか。
- 同じステムを 20〜30 トラックに立てて Saturation を軽くかけ、単体では違いが
  分からず・重ねてもダンゴにならないか（`vary` の効き）。
- GPU 負荷（strip は今なお `@workgroup_size(1)` 直列 × トラック数）。

**未解決 / 判断ポイント**
- voicing 定数は全て仮・耳合わせ待ち（下記フォローアップの値）。
- `vary` は永続化しないのでプロジェクト再読込ごとに個体差が振り直される
  （不可聴前提なので許容。再現性が要るならレーン id ハッシュ由来へ）。
- `COL_DC_A` は fs 非スケールの固定 const（12 Hz 目標、44.1–192k で 6–24 Hz、
  不可聴）。

**触ったファイル**: `src/renderer/src/gpu/shaders.ts`,
`src/renderer/src/gpu/channel-strip.ts`, `src/renderer/src/gpu/master-bus.ts`,
`src/renderer/src/main.ts`, `src/renderer/index.html`, `README.md`（計画節 + 本ログ）

**フォローアップ（同セッション、実機フィードバック前の voicing 調整）**
- ユーザー: 方向性 OK。要望 → (1) Drive/Color どちらを選択中か**ハイライト**で
  分かるように、(2) 既定を **Color** に、(3) **Drive をもっと overdrive 感**・Color
  と明確に区別（最大で音がつぶれても可）、(4) **Color は今の最大がセンター位置**
  くらい・最大は「やや破綻」で**えぐく**効く。
- **UI**: モードボタンに `.sat-mode` クラス + `.td-btns button.sat-mode.on` =
  accent 塗り（`index.html`）。`defaultStripParams().satMode` を `'color'` に。
  `applyStripParams` は保存 params に `satMode` キーが**無い**（= 2026-09-07 以前）
  ときだけ `'drive'` に固定 → 旧プロジェクトは従来音、新規トラックだけ Color 既定。
- **Drive voicing**（`channel-strip.ts` 定数のみ）: knee `d^0.9→d^0.8`、
  shHard `min(0.94,0.48+0.5d)→min(0.97,0.52+0.55d)`、density `0.5+2.6d→0.6+3.6d`、
  drMakeup 係数 `1+0.6d→1+0.95d`、バンドゲイン lo `g6→g8` / lo-mid（body）
  `g16→g21` / presence `g22→g26` / air `g19→g22`、outFc `16.5k→17k`。
- **Color voicing**（同）: knee `d^1.2→d^0.68`（センター前倒し）、drive span
  `22→34 dB`、bias `0.1+0.18ck→0.12+0.32ck`、bloom `0.5ck→0.85ck`、emph
  `0.45+0.6ck→0.5+0.95ck`、shoulder `0.22+0.35ck→0.28+0.55ck`、outA
  `26k-9k·ck→26k-11k·ck`、makeup を `1/colG·(1+0.6ck)` → **`((1-ck)/colG +
  0.5ck)·(1+0.3ck)`**（スラム時は出力ピークが colG に依らず ~1 になるので
  純 `1/colG` だと最大設定が埋もれる。固定レベルへブレンド）。
- `typecheck` / `build` グリーン。**未実機**（WGSL 無変更なので構造リスクは初回と同じ、
  コンパイル可否 + 上記 voicing の当たりを実機確認）。

**フォローアップ（実機フィードバック 2）**
- ✅ ユーザー: 「効き方は素晴らしい。音楽制作に使えるレベル」。
- **Color の makeup を数値レベルマッチに**（`channel-strip.ts`）: ゲインを上げると
  出力音量もかなり連動して上がっていた。`((1-ck)/colG + 0.5ck)·(1+0.3ck)` は
  センター→最大で持ち上がる形だったのが原因。→ **公称レベル（~-16 dBFS RMS）の
  テスト正弦を同じ Class-A カーブに通して出力 RMS を正規化** + `(1 - 0.12·ck)` で
  ノブを上げるほど ~1 dB 下がるように。レベル飽和する非線形は `1/colG`（最大が
  埋もれる）でも固定レベル（跳ねる）でもなく RMS マッチが正しい。CPU 側 64 点
  ループ、WGSL 無変更。
- **ミキサーストリップに選択ハイライト追加**（別タスク）: `selectLane` が
  `l.strip.el` にも `.selected` を付与。`index.html` に
  `.strip.selected`（全体を少し明るく `#1a2231`）/ `.strip.selected .strip-mid`
  （フェーダー域を accent 12% ティント）/ 名前を accent 色。どのトラックを選んで
  いるかミキサーで分かるように。

**フォローアップ（実機フィードバック 3）**
- ✅ Color 合格。vol 抑止を **`(1 - 0.12·ck)` → `(1 - 0.2·ck)`**（最大で
  RMS マッチ + さらに ~2 dB 下げ ＝ フェーダーを触らずに済む）。
- Drive「歪みをもっと深く」: knee `d^0.8→d^0.7`、バンドゲイン再増量
  （lo `g8→g12` / body `g21→g26` / presence `g26→g32` / air `g22→g27`）、
  shHard `0.52+0.55d→0.58+0.55d`（cap 0.97→0.98）、density `0.6+3.6d→0.6+4.4d`。
  WGSL `driveStage` も生の倍音を通すように: density mix `0.85→0.92`、
  出力スムージング mix **`0.3→0.15`**（HF タムを弱め、エッジを残す）。

**フォローアップ（実機フィードバック 4 — Drive アルゴリズム総取っ替え）**
- ✅ Color 完成（vol 抑止 `1-0.2·ck` で確定）。
- Drive: 並列マルチバンド exciter は「1176 RADIO 全部押し」＝歪みそのもの
  ＋バイト、というユーザーの狙いに対して**トポロジが違う**と判断。
  **12AX7 トライオード grit + フィードバック FET コンプ**に全面刷新。
  - `CHANNELSTRIP_WGSL` の `driveStage` を書き直し。1 サンプル毎（直列）:
    pre-gain → HF プリエンファシス（~1.8k、明るくささくれ）→ 非対称トライオード
    クリップ（bias=2次 / tanh=奇数次）→ **前サンプル出力を検波するフィードバック
    FET コンプ**（極端レシオ 3:1〜20:1、超高速アタック ~0.4ms でトランジェントの
    頭が抜ける＝バイト、スラムするほど速くなるプログラム依存リリース
    180ms↔40ms）→ DC ブロック → サージ用ソフトクリップ。`shaper()` ヘルパ削除。
  - UBO word 3..18 を drive 用に総取っ替え（`dPre / dEmphA / dEmph / dTriG /
    dBias / dBiasT / dThr / dRatioInv / dAtt / dRelSlow / dRelFast / dMakeup /
    dDensity` + pad）。state `s[b..b+3]` = prevOut(feedback) / env / emphLP /
    dcLP（旧 crossover LP を転用）。hpf=19 以降は不変。
  - `dMakeup` は数値マッチ（テスト正弦を triode + 定常 GR + サージに通して RMS
    正規化、`(1+0.1·k)` でキック/ベースが少し前に出る）。
  - フィードバック検波はユーザー選択。係数は発振しない範囲に寄せた（レシオ上限
    20:1、dRelFast 40ms）。強いポンプ＝全部押しキャラは意図通り。行き過ぎたら
    `dThr` / `dRelFast` / レシオで調整。
- `typecheck` / `build` グリーン。**未実機**（driveStage 書き換え — コンパイル可否 +
  フィードバックループの挙動 + voicing を実機確認）。

**フォローアップ（実機フィードバック 5）**
- ✅ Drive「音楽的に使えるものになっている」。Color 比で vol が上がるので抑止を
  数ラウンド調整。`dMakeup` 末尾トリム `(1 + 0.1·k)` → … → `(1 - 0.76·k)` まで
  下げたが「12 時で A/B するとまだ大きい」が残る。
- **原因判明**: WGSL の検波器が **メイクアップ後の出力** をタップしている
  ＝フィードバックループが dMakeup の変更を約半分補償する（だから 1 ラウンド
  約 3 dB しか減らなかった）。
- **対策**: `driveStage` の feedback タップ（`s[b] = y`）**より後** に 1:1 の
  最終トリム `P.dOut` を追加（`return y * P.dOut`）。ループの外なので素直に
  スケールする。UBO `_dp0`(word 16) を `dOut` に転用。`channel-strip.ts` で
  `dMakeup` の `(1 - 0.76·k)` は据え置き。今後の Color↔Drive 音量合わせは
  **`dOut` だけ**動かせば 1:1 で効く。
- `dOut` は `1 - 0.4·k` では「12 時でまだ大きい」→ **`1 - 0.6·√k`** に
  （音量超過はドライブが効いている間ほぼ一定 dB なので sqrt で早く立ち上げて
  頭打ち。≈ -5 dB @ 12 時 / -8 dB @ フル）。
- **最終的に「ゲインカーブの問題」と判明**: `k = d^0.85`（序盤を強める曲線）が
  逆で、10 時ぶんの歪みが 12 時で出ていた。実機で 2 段階に寝かせた:
  `d^0.85` → `d^1.35` → **`d^2.1`**（毎回「今の 10 時が 12 時に来る」ように）。
  下半分をほぼ寝かせ、フル=1 は不変。`k` は drive の全パラメータを駆動するので
  これ 1 個でノブ対キャラの傾きが決まる。dOut(`1 - 0.6·√k`)は据え置き。
- `typecheck` / `build` グリーン。

**フォローアップ（実機フィードバック 7 — 量感 OK、ヘッドルームリミッター追加）**
- ✅ Drive の量感 OK「プロスペックになった」。歪みは良いがトランジェントが
  伸び切っている → 「もう 1 個 12AX7 を通した」ように頭を打ちたい。
- **`softTop()` 追加**（`shaders.ts`）: 閾値 `t` 以下は素通し、超えた分だけ tanh
  ニー（`t` で傾き 1、漸近 1.0）で丸める headroom リミッター。`driveStage` の
  **feedback タップより後・`dOut` より前**に挿入（ループの外なので現在の効き感は
  不変、出力トランジェントだけ頭打ち）。
- UBO `_dp1`(word 17) を `dLimT` に転用。`f[17] = 0.92 - 0.35·k`（post-surge 信号は
  低〜中 Drive で ~1.5 まで伸びるが、surge 自体がフル付近で ~0.65 に頭打ちするので、
  閾値を k で下げて全域でトランジェントを叩く）。
- `typecheck` / `build` グリーン。**未実機**（`softTop` のコンパイル + 頭打ちの
  当たりを実機確認。効き過ぎたら `dLimT` の傾き 0.35 を下げる）。

### 2026-09-07（2）— インサートプラグイン「Awaker Enhancer」（サラサラ高域 + トランジェント）

**依頼**
- Waves Vitamin 系の、高域をサラサラ（＝ぎらつかない）させつつ抜けてくる
  エンハンサー／エキサイター。トランジェントも強調できるように。

**やったこと**
- **新インサート `AwakerInsert`**（`gpu/effects/awaker.ts` + `AWAKER_WGSL`、
  表示名は「Awaker Enhancer」/ スロット短縮 "Awaker"、内部 `kind:'awaker'` は保存
  互換のため据置）。`Insert` 契約そのままなので scheduler / 保存経路は無改修。
  `FX_KINDS` に追加（スロット / ラック UI に自動で出る）。
- **設計（パラレル・エキサイター）**: ドライは無加工で素通し、生成した「艶」バスを
  上に足すだけ（`out = dry + Amount·wet`）。ソースの位相を保つので「抜ける」感が
  出て濁らない。`@workgroup_size(2)`、ch 毎 1 スレッド、ブロック直列
  （tube/reverb と同じ 1-pole IIR + エンベロープ）。
  - DC ブロック → クロスオーバー（`Freq` の 1-pole で HF 帯を分離）→ HF
    プリエンファシス → **3 次までしか出ない cubic ソフトシェイパ**
    （`shape(u)=a-a³/3`、tanh と違い級数が有限＝フィズを撒かない＝サラサラ）
    ＋ bias で 2 次倍音 → **ポスト LP**（`Tone` warm=低コーナー＝絹、bright=
    伸ばす）→ HF 帯の fast/slow エンベロープ差で **トランジェント時だけゲイン
    リフト**（`Punch`、瞬時アタック / release 2ms、上限 1..4 倍）。
  - wet = 生成倍音 + ブロードバンド HF リフト（`hi·shelfAmt`）、`Punch` 単独でも
    効くよう `hi·(tGain-1)·transThru` の空気帯トランジェント項を別途加算。
  - wet バスに `softTop`（閾値 0.7）を通してからドライに加算＝ドライのダイナミクス
    には触れずエンハンス量だけ頭打ち。
- **パラメータ（5、ロータリーノブ = EQ / チャンネルストリップと同じ `makeKnob`、
  ダブルクリックで既定へ）**:
  `Air`（HF 倍音ドライブ + 艶、メインノブ / drive² ニー）、`Freq`（1–12 kHz、
  対数、分離コーナー、既定 4k）、`Tone`（0..1、倍音の warm↔bright）、`Punch`（0..1、
  トランジェントリフト、air=0 でも効く）、`Amount`（0..1、wet ブレンド、dry は
  常にフル）。既定 `air .4 / freq 4k / tone .5 / punch .3 / amount .8`。
  **`air=0 && punch=0` は dispatch skip（完全透過）**。
- UBO `AW` = 20 word（u32×2 + f32×18）、96 B バッファ。状態 `st` = ch 毎 8 f32
  （dc x1/y1・xoverLP・emphLP・postLP・envFast・envSlow）、64 B。全係数は
  CPU で毎ブロック生成（SR キャッシュ無し）。
- 保存: `serializeInsert` / `deserializeInsert` に `kind:'awaker'`（params 丸ごと）。

**今の状態 / 動くもの**
- `npm run typecheck` / `npm run build`（renderer **18** modules）グリーン。
  **未実機**（WGSL コンパイルは起動時判明 — `AWAKER_WGSL` の `shape` / `softTop` /
  20-word struct が通るか要確認）。

**次の一手 / 要実機確認**
- 起動 → スロットまたは左ペインのラックから Awaker を挿入 → Play で
  パイプラインがコンパイルされるか（コンソールエラー無し）。
- 1 トラック solo、`Air` 0.3 / 0.5 / 0.8 で: (a) 高域が「サラサラ」＝ぎらつかず
  滑らかに増えるか、(b) full で耳に刺さらないか、(c) `Tone` を回して warm↔bright
  が効くか。
- `Punch` 0.4〜0.7: スネア / ピック / 子音のアタックが前に出て「抜けてくる」か。
  `Air=0` でも `Punch` 単独で HF トランジェントが立つか。
- ドライを保つ設計なので位相・低域は不変のはず（要確認）。GPU 負荷
  （`@workgroup_size(1)` ではなく `(2)` だがトラック毎 dispatch、シェイパ 1 本 +
  1-pole ×4 + envelope ×2）。

**未解決 / 判断ポイント**
- voicing 定数は全部仮（`preGain` span 4.5、`bias` 0.05+0.3·air、`postA` コーナー
  6.5k+10.5k·tone、`fastA` 2ms / `slowA` 90ms、`punchAmt` 3.5·punch、
  `transThru` 1.1·punch、`limT` 0.7）。実機で耳合わせ。
- **エイリアシング**: cubic は 3 次だけとはいえ 96 kHz で 20 kHz の 3 倍音 =
  60 kHz → 36 kHz に折返す。ポスト LP（`Tone` warm 寄りで ~6.5 kHz）が潰す前提。
  オーバーサンプリングは prototype 方針に反するので未実装。刺さるようなら
  `postA` の下限コーナーを下げる or `preGain` span を絞る。
- `Amount` と `Air` はどちらも「量」で機能が重なる。エキサイターの慣習に寄せて
  Air=倍音生成量 / Amount=バス全体ブレンドにしたが、UI で紛らわしければ
  Amount を撤去して Air 一本にする案。

**触ったファイル**: `src/renderer/src/gpu/shaders.ts`,
`src/renderer/src/gpu/effects/awaker.ts`（新規）, `src/renderer/src/main.ts`,
`README.md`（本ログ）

**フォローアップ（同セッション）**
- Awaker Enhancer の UI をスライダ 5 本 → **ロータリーノブ**（`makeKnob` /
  `.knob-grid`、EQ・チャンネルストリップと同じ、ダブルクリックで既定へ）。
  `Freq` は対数マッピング（1–12 kHz）。commit `eaae9b5` / `a36f5b7`。
- 表示名の変遷（ユーザー指示で 2 転 3 転）: `Awaker` → `Awake Enhancer` →
  **最終 `Awaker Enhancer`**（スロット短縮 "Awaker"）。UI ラベル（`FX_KINDS`）
  のみ、クラス / ファイル / WGSL / 保存 `kind:'awaker'` は据置。

### 2026-09-07（3）— アプリ名を gpudaw → Awaker DAW over GPU にリネーム

**やったこと**（表示名はユーザー指示で `Awake` → 最終 **`Awaker DAW over GPU`**）
- `package.json`: `name` `gpudaw`→`awaker`、`productName: "Awaker DAW over GPU"`。
- `src/main/index.ts`: `app.setName('awaker')` を起動時に呼ぶ → 表示名に依らず
  userData を **`%APPDATA%/awaker`** に固定（`getName()` が productName を優先して
  スペース入りフォルダになるのを回避、今後の表示名変更でも config が動かない）。
- `src/renderer/index.html`: `<title>` → `Awaker DAW over GPU`（ウィンドウタイトル）。
- `src/main/index.ts`: プロジェクトダイアログ表記（`Awaker project` /
  `project.awaker.json`）。正本ファイル名 `PROJECT_BASENAME`
  `gpudaw-project.json` → **`awaker-project.json`**。`candidateProjectPaths()` は
  新パス + **旧 `%APPDATA%/gpudaw/gpudaw-project.json` を read フォールバック**
  （旧セッションが初回起動でも自動復元。次の Save で新パスへ移る）。
- `README.md`: 見出し `# Awaker DAW over GPU`、本ログ。
- **内部識別子は据置**: `gpudaw-device`（`gpu/device.ts` の GPUDevice label）、
  `gpudaw-out`（`audio-out.ts` のストリーム label）、`audify.d.ts` のコメント。
  ユーザーに見えないので変えない。

**今の状態 / 動くもの**
- `npm run typecheck` / `npm run build`（renderer 18 modules）グリーン。
- 初回起動時、旧 `%APPDATA%\gpudaw\gpudaw-project.json` があればフォールバックで
  読めるはず。読めなければ 📂 Open で旧ファイルを開いて Save → 新パスに移行。

**触ったファイル**: `package.json`, `src/renderer/index.html`,
`src/main/index.ts`, `README.md`（本ログ）

### 2026-09-07（4）— チャンネルストリップをバッチ dispatch 化（全トラック saturation で音切れ）

**症状**
- 24 トラック全部（MoniBlue_AprilBlues 自動ロード）で strip の saturator を 12 時
  （`drive` ≈ 0.26–0.42、`satMode:'drive'`）にしたら再生が音切れ。`nvidia-smi`
  GPU-Util 100%、専用 VRAM は 1.9 GB で余裕 → 演算が律速。

**原因**
- `CHANNELSTRIP_WGSL` が `@compute @workgroup_size(1)` の 1 スレッド。ブロック
  32768 フレームを 1 サンプルずつ直列（triode `tanh`×2 + フィードバック FET コンプの
  `pow` + DC ブロック + surge + HPF biquad + EQ biquad×4 + コンプ）。これを
  `master-bus` がトラック毎に別 compute パスで dispatch。
- `ChannelStrip.process()` は透過時（`drive 0` かつ `trim 0`）に**丸ごと dispatch
  スキップ**していた。全トラックに saturation を乗せた瞬間、24 本の「1 レーン ×
  32768 サンプル直列」が同一エンコーダに並び ~6 回/秒 → ≈79 万反復/ブロックを
  実質 1 SM レーンで。読み戻しが ring に間に合わず underrun。
- README の Phase E / 保留メモが予告していたボトルネックそのもの（「24 は許容
  想定、超えるなら全トラック 1 dispatch のバッチ版へ」）。

**やったこと（バッチ版へ）**
- `CHANNELSTRIP_WGSL`: `@workgroup_size(32)`、**invocation `i` = トラック `i`**。
  bindings を storage 配列化 — `Pall : array<CS>`（per-track params、stride 256B）/
  `sig`（全トラックの `[L|R]` スライス、stride `2*blockFrames`）/ `st`（トラック毎
  64 f32）/ `B : Batch{trackCount, blockFrames}`。`P` / `s` は `Pall[t]` /
  `st[t*64..]` を private にコピー（ヘルパは `P.xxx` を無改変で読む）。CS の word0
  を `blockFrames` → `active`（host が透過/bypass スロットを 0 に）。サンプルループ
  は再帰 IIR ゆえトラック内は直列のまま、トラック間が並列に。
- `channel-strip.ts`: `ChannelStrip` を **パラメータ + 係数ホルダ**に縮小
  （`implements Insert` / GPU バッファ / pipeline / `process` / `reset` を撤去）。
  `wouldProcess()` と `writeCoeffs(u, f, wordBase, fs)` を追加（旧 `process` の係数
  計算をそのまま共有バッファへ）。新 **`StripBank`**: batched pipeline + params/state
  storage バッファ（トラック数で伸長）+ `Batch` UBO を所有。`process(enc, bigSig,
  strips[], blockFrames, sr)` が 1 dispatch。`reset()` で state 全ゼロ（comp gain=1）。
- `master-bus.ts`: mix ループを **(1) 全トラック gather → `big` の各スライス →
  (2) `StripBank.process` 1 発 → (3) トラック毎に `big` スライスを `scratch` へ
  `copyBufferToBuffer` → inserts → mix-add** に再構成。gather は `big` のスライスを
  `{buffer, offset:i*regionBytes, size}` でバインド（gather WGSL 無改変、
  `blockFrames % 32 === 0` 前提を assert）。inserts / mix-add は `scratch` 前提の
  まま無改変。`big` はトラック数で伸長（`ensureBig`）。`resetStrips()` 追加。
- `scheduler.ts`: `start()` の per-source `s.strip?.reset()` を
  `masterBus.resetStrips()` に置換（strip state は `StripBank` に集約）。

**ハマり（同セッション、実機で発覚）**
- 初回起動で**全トラック無音**。原因: WGSL 構造体フィールド名 `active` が**予約語**
  → `CHANNELSTRIP_WGSL` が丸ごとコンパイル失敗 → invalid pipeline を参照する
  コマンドバッファが全部 invalid → `submit` 却下 → チャンク 0 → 無音。
  `active` → `slotOn` にリネームで解消。
- あわせて **CS 構造体のストライドバグ**も修正（61 word = 244 B → `array<CS>`
  ストライド 244 でトラック1以降がズレる。`_tail0..2` で 64 word / 256 B に padding、
  ホストの `STRIP_WORDS=64` と一致）。
**デバッグ支援（この無音の切り分け用に追加。ユーザー方針: 用が済んだら撤去する）**
撤去対象 4 点（commit `95a64ae` で追加）:
1. `src/main/index.ts` — `win.webContents.on('console-message', …)`: renderer の
   console warn/error をターミナル stdout へミラー（`[renderer:error] …` /
   `[renderer:warn] …`）。detached DevTools が見落とされやすいので暫定で。
2. `src/renderer/src/main.ts` 冒頭 — `window.addEventListener('unhandledrejection', …)`:
   `void scheduler.start()` 等が握り潰す reject を `console.error` に出す。
3. `src/renderer/src/gpu/channel-strip.ts` `StripBank.getPipeline` — `module.getCompilationInfo()`
   を `void .then()` で出力（`[strip-bank WGSL error] …`）。他シェーダには無い処理。
4. `src/renderer/src/gpu/master-bus.ts` — `stripBank.process` の try/catch +
   `stripFailLogged` フラグ（strip 失敗時にドライで通す保険）。これは残す価値あり
   かもだが、他ステージに合わせるなら外す。
撤去してもバッチ化本体（`StripBank` / `CHANNELSTRIP_WGSL` / mix ループ再構成）は
無関係。

**今の状態 / 動くもの**
- `npm run typecheck` / `npm run build`（renderer 18 modules）グリーン。
- ✅ **ユーザー実機: 音出た + 24 トラック全部 saturator 12 時で音切れしない。
  GPU-Util 100% → 7%**（RTX 3060 Ti、96 kHz）。saturation 無しの素の 24 トラック
  再生と同じ水準 = strip ステージが負荷にほぼ乗らなくなった。経路再構成の回帰なし。

**次の一手 / 要実機確認**
- Drive / Color 両モード、EQ / comp 併用、inserts（19/20 の delay+reverb）の
  tail 挙動は未個別確認（音切れ無し・回帰無しは確認済み）。
- 100 トラック相当までスケールするか（`big` = N×32768×2×4B、100 で 26 MB）。

**未解決 / 判断ポイント**
- inserts も `@workgroup_size(1/2)` の per-track dispatch のまま（今は 2 トラック
  のみ使用なので後回し）。多用され出したら同様のバッチ化が要る。
- step 3 の `copyBufferToBuffer`（スライス → `scratch`）は inserts の WGSL を
  無改変に保つための割り切り。inserts 無しトラックでは無駄コピー（~256 KB/block、
  帯域の 0.01% 未満）。重くなるなら mix-add を `big` スライス直バインドへ。
- private `array<f32,64>`/invocation が register spill する可能性（機能は不変、
  1→32 レーンで差し引き大幅増）。効かなければ `@workgroup_size` を調整。

**触ったファイル**: `src/renderer/src/gpu/shaders.ts`,
`src/renderer/src/gpu/channel-strip.ts`, `src/renderer/src/gpu/master-bus.ts`,
`src/renderer/src/audio/scheduler.ts`, `src/main/index.ts`（console ミラー）,
`src/renderer/src/main.ts`（unhandledrejection）, `README.md`（本ログ）

### 2026-09-07（5）— インサートプラグインをフローティングウィンドウ化（Pro Tools 風）

**依頼**: チャンネルストリップ以外のプラグイン（Reverb / Delay / 5-band EQ /
Awaker Enhancer）を一般的な DAW のようにウィンドウ表示に。ユーザー指定:
フローティング複数対応だが通常は 1 個、Pro Tools のように**ピン止めした
ウィンドウだけ残り、他は単一（開くたび差し替え）**。左詳細ペインの Inserts
カードラックは撤去、代わりに**左ペインにスロット列**を付ける。開くのは
シングルクリック。「Inserts」の見出しで挿入の有無が分かるように。

**やったこと**（`main.ts` + `index.html`、GPU 経路・scheduler・保存は無改修）
- **フローティングプラグインウィンドウ** (`main.ts` 新セクション):
  `plugWins: Map<Insert, PlugWin>`。`openPlugWin(fx, owner)` は既存なら前面化、
  無ければ**先に未ピンを全部閉じてから**新規を未ピンで開く。タイトルバー
  `[名前][●bypass][📌pin][×]`、ドラッグ移動、クリックで z 前面化、カスケード配置。
  本体は既存 `buildFxParams(body, fx)` を流用（ノブ/スライダはグローバル CSS
  そのまま）。`.plug-win` は `position:fixed` の非モーダル（背景操作可）。
  `closePlugWin` / `closeUnpinnedPlugWins` / `closeAllPlugWins`。
- **`buildInsertRack`（左ペインのカードラック）を削除** → `buildDetailSlots()`:
  `section('Inserts · n/8')` + ミキサーと同じ `fillRack` のスロット列。
  挿入が 1 個以上なら見出しに `.has-fx`（accent 色）。master ビューも同形。
- **`fillRack` のスロット名クリック**: 旧「左ペインへスクロール」→ `openPlugWin`。
  ▾メニューに **Move up / Move down** を追加（旧カードラックの ▲▼ の代替、
  `openFxMenu` に `onUp`/`onDown`）。差し替え・削除時は該当ウィンドウも閉じる。
- **CSS**: `.plug-win` 一式、`#pane-left .strip-slot` を左ペイン用に拡大（20px）、
  `.td-section.has-fx > h4 { color: accent }`。旧 `.td-rack` / `.fx-card` /
  `.fx-bar` / `.fx-name` / `.fx-body` / `.fx-add` の死んだ CSS を撤去。
- 保存フォーマット・`serializeInsert` 系は無変更。project 再読込時に
  `closeAllPlugWins()`。

**今の状態 / 動くもの**
- `npm run typecheck` / `npm run build`（renderer 18 modules）グリーン。
- ✅ **ユーザー実機**: ウィンドウが出る／閉じる、📌ピンで開きっぱなし可、
  未ピンは単一で開くたび差し替え、を確認。5-band EQ もはみ出さず
  ウィンドウが縦に伸びるだけで問題なし。

**次の一手 / 要実機確認**
- ウィンドウのサイズ・位置記憶は無し（毎回カスケード）。要るなら次で。

**未解決 / 判断ポイント**
- ウィンドウの位置/サイズはセッション内も記憶しない（カスケードのみ）。
- スロットのドラッグ&ドロップ並べ替えは未対応（▾メニューの Move up/down のみ）。
- `.plug-win` 幅は 300px 固定。EQ-5 など縦長プラグインはスクロールなし
  （画面外に出たらタイトルバーで引き戻す前提）。

**触ったファイル**: `src/renderer/src/main.ts`, `src/renderer/index.html`,
`README.md`（本ログ）

**フォローアップ（同セッション — 視認性）**
- ユーザー実機フィードバック「やや視認性が悪い」→ 以下を調整:
  - **Reverb / Delay もロータリーノブ化**（`buildFxParams`）。Reverb = Room/Damp/
    Mix(Wet%)、Delay = Time(対数 1–1500ms)/FB/Damp/Mix + Ping-pong チェック。
    スライダの `mixRow` は不要になり削除（`sliderRow` は Input Trim/HPF で継続使用）。
  - **全ロータリーに目盛り**（`makeKnob`）: 時計の 2 時間刻み（8/10/12/2/4 時、
    270° スイープ内）に 5 本、12 時が中央 major。`.knob > b` を JS で
    `rotate(a)+translateY(-27px)` 配置。EQ / チャンネルストリップ / Awaker の
    ノブにも共通で乗る。
  - `.knob-grid` の gap を広げ（16px 12px）、`.knob-cell` 幅 52→58（目盛りぶん）。
  - **プラグインウィンドウ**: 幅 244→300px、body padding 10→18px、背景 `var(--panel)`
    →`#1c212b`（少し明るく）、タイトルバー `#1b2029`→`#313847`（明るいトーン）＋
    ボタン/名前のコントラスト増。

**フォローアップ 2（同セッション — ノブとウィンドウが同化）**
- 「ロータリーとウィンドウの色が同じ」「文字も同化」→
  - `.knob` を明るく（グラデ `#4c5568→#262d3a`、border `#59647a`、
    raised 用 box-shadow）。目盛り minor `#7a8397` / major `#c4ccd8`。
  - `.knob-val` を `--dim`→`--text`、`.knob-label` を `#98a1b2` に。
  - `.plug-win-body` 内で `.eq-band-h` `#eef1f6` / `.td-check` `#c4ccd8` /
    `.eq-band` border `#3d4557`。
- `typecheck` / `build` グリーン。**要実機確認**（ノブ目盛りは 12 時＋2h 刻み、
  Delay の対数 Time、ノブ/文字のコントラスト）。

**フォローアップ 3（同セッション）**
- 左詳細ペインの **Inserts スロットラックを一番上へ**（`#td-head` 直下、
  fader より前）。`renderDetail` で `buildDetailSlots` の呼び出し位置を移動
  しただけ。信号ルーティング（strip → inserts → fader）は不変。
- プラグインウィンドウ: body padding 18→27px（+50%）、幅 300→330px
  （4 ノブが 1 段に収まるよう）、`.plug-win-body` に `min-height: 108px`
  （Reverb 3 ノブと Delay 4 ノブ+ping-pong が同じ箱サイズになるように）。

**フォローアップ 4（同セッション — Cubase 風の余白）**
- 参考: Cubase MonoDelay のスクショ。「余白がもっとがっつり欲しい」。
- `openPlugWin` が `buildFxParams` を **`.plug-panel`**（インセットの制御盤）で
  ラップ。3 層の深度: window `#1c212b` → `.plug-win-body` `#161b23`(margin 14px)
  → `.plug-panel` `#10141b`(border + padding 30/28px + `min-height:150px`)。
- ウィンドウ幅 330→404px（4 ノブ + gap 26/22px を 1 段に）。ノブ gap は
  `.plug-panel .knob-grid` にスコープ（左詳細ペインの `.knob-grid` は不変）。
- Ping-pong チェックはパネル内で中央寄せ。`min-height:150` で Reverb=Delay の
  箱サイズも維持。
- ウィンドウのタイトルを `プラグイン名 - トラック名`（master は `- MASTER`）に。
  `ownerLabel(owner)` を追加。
- Reverb / Delay のパネルを約 2 倍の縦（スカスカ可）: `openPlugWin` が
  `.plug-panel-tall` を付与、`min-height:150→300px` ＋ flex center。EQ-5 /
  Awaker は据え置き（内容ドリブン）。
- ✅ **ユーザー実機**: フォローアップ 1〜4 まとめて「いい感じになった」。
  ロータリー化・目盛り（12 時＋2h）・コントラスト・Cubase 風インセット・
  タイトルのトラック名・Reverb/Delay の縦 2 倍、いずれも OK。

**フォローアップ 5（同セッション — 左詳細ペインのチャンネルストリップ改装）**
- Input（Trim / HPF）を `sliderRow` → **ロータリーノブ**（`.knob-grid`）。
  `sliderRow` はこれで全廃 → 関数削除。
- Pan を range スライダ → **ロータリーノブ**。`makeKnob` に `bind(set)` を追加
  （外部＝ミキサーストリップのノブから位置だけ流し込む、`onInput` は撃たない）。
  `detailApi.setPan` はこの setter を呼ぶだけに。
- **fader / pan / Mute / Solo を 1 セクションに統合**（`.td-section.td-channel`）:
  `#td-fader-mid` の右に `.td-fader-side`（Pan ノブ → Mute/Solo 縦積み
  `.td-btns-vert`）。旧「pan」セクション廃止。
- フェーダー高さは `#td-fader-mid { height: 360px }`（flex 全高 → 240px →
  「1.5 倍欲しい」で 360px に着地、✅ OK）。`.td-fader-side`:
  `margin-left: 14px`（フェーダーから離す）、`justify-content: flex-end`
  （Pan ノブ・Mute/Solo をフェーダー下端に揃える）。
- **Input セクションを廃止し、Trim / HPF をフェーダー右の `.td-fader-side` へ**
  （ユーザー「配置が気に入らん、フェーダーの右に割り付け」「ロータリーは縦」）。
  side 列は上から `.td-in-box`（Trim + HPF、枠線付きの箱 + "Input" キャプション）
  → Pan → Mute/Solo の縦 1 列（`gap:10px`、`justify-content:flex-end` で下端
  揃え、`margin-left:26px` でフェーダーから離す）。`.td-in-grid` CSS は撤去。
- `.td-in-box { margin-bottom: auto }` で Input 箱だけ上寄せ（Pan / Mute/Solo は
  下端のまま）。
- 左ペインのインサートスロット高さ 20→24→29→**20px（当初に戻す）**、
  スロット名の font-size 10→**12px** は維持。
- フェーダーエリア `#td-fader-mid` は 240→…→580→**464px**（当初比では拡大、
  580 から 20% 減）。
- **エフェクト ON でパネルを明るく**: EQ / Saturation / Compressor の
  `.td-section` に `.fx-on`（bg `#16202c` + 左に accent のインセット線）を
  トグル。EQ=`sp.eqOn` / Sat=`sp.drive>0.001` / Comp=`cp.on`、チェック・
  ノブ操作で即時更新。
- ✅ **ユーザー実機**: 「最高、めちゃいい感じ」。
- 左ペインのセクション順を Saturation → EQ に（`insertBefore(satSec, eqSec)`）。
  実 DSP 順（trim → saturation → HPF → EQ → comp）とも一致。
- **ミキサーストリップのインサートスロットが小さすぎて操作不能**（スクショ指摘）
  → `.strip-slot` 高さ 13→18→**22px** / font 8→10→**12px**、`.slot-byp`・
  `.slot-caret` 10×11→15×16→**18×19px** / font 8→10→**12px**、`.slot-num` 幅
  8→10→**12px**、`.slot-add`（＋）12→**14px**（2 段階で +20% ずつ）。
  名前が切れにくいよう `.strip-slot` の `gap:3→0` / `padding:0 3px→0 1px`
  （●/▾ を端まで寄せて `.slot-name` の幅を稼ぐ）。左ペイン側 override は不変。
- **全ロータリー 20% 縮小**: `.knob { transform: scale(0.8); margin: -4px -5px }`
  （見た目だけ縮小、46px の当たり判定は維持）。目盛り・インジケータも比例縮小、
  JS 変更なし。
- Saturation セクション: `nHint`（"Drive = … · Color = …" 説明文）を削除、
  `.td-hint` CSS も撤去。Drive/Color ボタンに `margin-bottom:14px`（ノブと離す）。
- 左詳細ペインの `.td-fader-side` に **Rec ボタン**（Solo の下）を追加。
  押すと赤（`.td-btns button.on.r { color: var(--rec) }`）。`mkBtn` を
  `'mute'|'solo'|'rec'` 対応に、ミキサーストリップの R と双方向同期
  （`toggle()` の rec 除外を撤去、`syncButtons` に rec 追加）。録音経路は未実装
  なので状態のみ。
- `typecheck` / `build` グリーン（JS バンドル −1KB、sliderRow 削除）。
- ✅ **ユーザー実機（最終）**: 「製品レベルのクオリティになってきた」「すばらしい」。
  左詳細ペインのチャンネルストリップ改装 + ミキサースロット拡大 + Rec ボタン、
  一通り合格。ここでコミット。

**触ったファイル（フォローアップ 5 全体）**: `src/renderer/src/main.ts`
（Input/Pan ロータリー化、`makeKnob` に `bind`、fader-side 列統合、`buildDetailSlots`、
Saturation↔EQ 順、`.fx-on` トグル、Rec ボタン、`sliderRow`/`buildInsertRack`/
`mixRow` 削除）、`src/renderer/index.html`（`.plug-win`/`.plug-panel`、`.knob`
目盛り＋scale、`.td-fader-*`、`.td-in-box`、`.td-section.fx-on`、`.strip-slot`
拡大）、`README.md`（本ログ）

### 2026-09-07（6）— マスター専用プラグイン: Bus Comp + Maximizer（LUFS メーター）

**依頼**
- マスター用に SSL G-bus コンプ系のバスコンプ（**明るめの倍音**が付加される）と
  マキシマイザ。マキシマイザに **LUFS メーター**（きつければ一旦 dB でも可）。
- 思いつきメモ: 各トラックにも VU メーター → ロードマップに記載（実装はしない）。

**やったこと**
- **`BusCompInsert`**（`gpu/effects/buscomp.ts` + `BUSCOMP_WGSL`、表示名 "Bus Comp" /
  スロット短縮 "BusComp"）。ステレオリンク feed-forward・ソフトニー・`@workgroup_size(1)`
  （検波が L/R リンクなので直列）。パラメータ = Thresh / Ratio(2·4·10 ステップ) /
  Attack(0.1–30ms ステップ) / Release(100/300/600/1200ms・**Auto**=プログラム依存の
  fast/slow ブレンド) / Makeup / **Drive**(0..1) / Mix(パラレルコンプ)。
  - **明るめの倍音** = GR/makeup 後に `bright()`: HF プリエンファシス → 非対称
    ソフトクリップ（bias=2 次 / tanh=奇数）→ DC ブロック → **焼き込みブライト
    ハイシェルフ**（最大 +1.6 dB @ 8k、Drive 連動）。`Drive=0` で完全透過。
  - 係数は CPU で毎ブロック生成、状態は 16 f32（検波 env + per-ch emph/dc LP +
    シェルフ biquad）。`mix<=0` で dispatch skip。
- **`MaximizerInsert`**（`gpu/effects/maximizer.ts` + `MAXIMIZER_WGSL`、"Maximizer" /
  "Maxim"）。ルックアヘッド brickwall リミッター: 信号を `lookahead`(~1.5ms) 遅延
  ラインに通し、ステレオリンクのゲイン包絡（低速リリースのピークホールド →
  アタック平滑）をピーク前に落とす → シーリングでハードクランプ（保険）。
  パラメータ = Gain(0..24dB) / Ceiling(-3..0dB) / Release(1..1000ms 対数)。
  **ルックアヘッド ~1.5ms は未補償**（プロトタイプ、README ロードマップにも波形/
  transport とのズレは書かず。実害なし）。delay.ts と同じ configure(sr) パターン。
- **LUFS メーター**（`scheduler.ts`）。マスター読み戻し（全チェーン後のインター
  リーブ済みステレオ）から CPU で算出:
  - K 特性 = **BS.1770-4 正規**（初版は RBJ 近似 → 中高域が甘くラウドネスが
    ~1〜2 dB 低く出たため libebur128 の解析式に差し替え。下部フォローアップ参照）。
  - 100ms サブブロックで K 特性後の `L²+R²` を積分 → 30 個のリングで Momentary
    (400ms=直近4) / Short-term(3s=直近30) / セッション最大 ST。
    `LUFS = -0.691 + 10·log10(平均パワー)`。`start()` でリセット。
  - **Integrated**（BS.1770-4 ゲーティング）: 100ms 毎に 400ms ゲーティングブロック
    （75% オーバーラップ）を収集。収集時に**絶対ゲート -70 LUFS**、`integratedLufs()`
    で**相対ゲート（平均 -10 LU）**を掛けて残りを平均。全ブロックを保持する必要が
    あるので `lufsGate: number[]` に push（10 分再生で ~6000 要素 = 48 KB、`start()`
    でクリア）。二重パスは O(n) なので `lufsGate.length` が伸びた時だけ再計算
    （`lufsICache`）。
  - `metrics()` に `lufsM / lufsS / lufsI / lufsMax`。`lufsI` / `lufsMax` は停止後も
    値を残す（テイク全体の指標なので）。`meterBlock()` を通常再生 + tail 両ループで
    呼ぶ（先読みぶん最大 ~1 ブロック先行、既存 masterPeak と同じ）。
- **UI**（`main.ts` + `index.html`）:
  - `FX_KINDS` に `masterOnly` フラグ。`openFxMenu` が `owner` を受け取り
    master 以外のラックメニューでは Bus Comp / Maximizer を出さない。
  - `buildFxParams` に両プラグインのロータリーノブ UI（ステップノブは index を
    値にして `fmt`/`onInput` で丸め）。Maximizer 窓には `.lufs-meter`
    （**Momentary / Short-term / Integrated / Maximum** の 4 行、項目名フル表記、
    Integrated を accent 色で強調）。`lufsReadout` モジュール変数を窓生成時にセット、
    `closePlugWin` / `closeAllPlugWins` でクリア。`frame()` が毎フレーム更新。
  - マスターストリップに `#master-lufs`（Short-term 表示、dB/peak 数値の下）。
  - `serializeInsert` / `deserializeInsert` に `kind:'buscomp'` / `'maximizer'`。
- `npm run typecheck` / `npm run build`（renderer **20** modules）グリーン。**未実機**
  （WGSL コンパイルは起動時判明 — `BUSCOMP_WGSL` の 96B struct / `log` / `pow`、
  `MAXIMIZER_WGSL` の循環ラインが通るか要確認）。

**次の一手 / 要実機確認**
- 起動 → MASTER ストリップ head クリック（または左詳細ペイン Inserts）→ スロット
  メニューに Bus Comp / Maximizer が出るか、トラック側には**出ない**か。
- Bus Comp を挿す → Play: (a) コンプがかかるか（GR 感）、(b) Drive 0.3〜0.7 で
  「明るめの倍音」が乗るか・眠くならないか、(c) Ratio/Attack/Release ステップの
  切り替わり、(d) Auto リリースの追従、(e) Mix でパラレルになるか。
- Maximizer を挿す → Gain を上げる: (a) シーリングを超えないか（brickwall）、
  (b) ポンピング/歪みの質、(c) Release の効き。LUFS メーター（Maximizer 窓の
  Momentary / Short-term / Integrated / Maximum + マスターストリップの Short-term）
  が妥当な値か（-14 LUFS 前後を狙って Integrated が合うか。市販曲や既知 LUFS の
  リファレンスと突き合わせて K 特性近似の誤差を確認）。
- Bus Comp は `@workgroup_size(1)` 直列 × マスター 1 パス。tube/reverb と同水準の
  想定だが GPU 負荷を確認。Maximizer の遅延ライン込みで音切れが出ないか。

**未解決 / 判断ポイント**
- voicing 定数は全部仮（Bus Comp: knee 6dB / emph 3.5k / driveG 1+1.6d / shelf
  +1.6d @ 8k / outTrim。Maximizer: lookahead 1.5ms / atk = 1-exp(-5/LA) /
  rel 平滑 20ms 固定 / holdRel = Release ノブ）。実機で耳合わせ。
- LUFS の K 特性は BS.1770-4 正規係数（libebur128 の解析式、SR 非依存）に更新済み。
  Integrated はゲーティング（絶対 -70 / 相対 -10 LU）実装済み。LRA（Loudness
  Range）は未。`lufsGate` は無制限に伸びる（長時間再生でメモリ増、実用上は
  問題ないが cap するなら別途）。表示値には暫定 `LUFS_CALIB_DB = +2 dB`（仮）が
  乗っている — リファレンス音源で検証して確定させる。
- Maximizer のルックアヘッドは未補償（マスター全体が ~1.5ms 遅延）。

**触ったファイル**: `src/renderer/src/gpu/shaders.ts`（`BUSCOMP_WGSL` / `MAXIMIZER_WGSL`）、
`src/renderer/src/gpu/effects/buscomp.ts`（新規）、`src/renderer/src/gpu/effects/maximizer.ts`（新規）、
`src/renderer/src/audio/scheduler.ts`（LUFS メーター）、`src/renderer/src/main.ts`
（`FX_KINDS` masterOnly、`openFxMenu` owner、`buildFxParams` 2 分岐、`lufsReadout`、
serialize/deserialize、`frame()` LUFS 更新）、`src/renderer/index.html`
（`#master-lufs` + `.lufs-meter` / `.strip-lufs` CSS）、`README.md`（ファイルマップ /
現状 / ロードマップに per-track VU メモ / 本ログ）

**フォローアップ（LUFS が ~3 dB 低い → K 特性を正規係数へ）**
- ユーザー実機: 「LUFS 数値が 3 dB ほど低い。商用の -7 前後まで上げると耳が痛い」
  （＝メーターを信じて上げすぎる）。
- 原因: 初版の K 特性 stage 1 に **RBJ ハイシェルフ（Q=0.707, +4 dB @ 1.68k）** を
  使っていた。RBJ シェルフは遷移が緩く、2〜8 kHz（音楽のエネルギーが集中する帯域）
  で BS.1770 正規 pre-filter より 1〜2 dB 持ち上げが甘い → ラウドネスが低く出る。
- 対策: `configureLufs()` を **libebur128 の解析式**（`K = tan(π·f0/fs)` ベース、
  stage 1 = 高域シェルビングブースト `Vh=10^(G/20)` / `Vb=Vh^0.49967`、stage 2 =
  RLB 高域通過）に差し替え。f0 / G / Q は libebur128 の定数そのまま。48 kHz で
  正規係数と bit-exact 近く、他レートでも解析的に正しい。`biquad` import 削除。
- 96 kHz で検算: 高域プラトー +3.9998 dB / DC +0.11 dB / Nyquist ゲイン一致。
- それでも開発機では商用マスター比でまだ低め → **暫定の一律 +2 dB 校正
  `LUFS_CALIB_DB = 2.0`**（`scheduler.ts`）を全表示値（Momentary / Short-term /
  Integrated / Maximum）に加算。フィルタ演算は正確なので、これは表示合わせの
  仮値。**正確なリファレンス音源（既知 LUFS）で検証したら調整 or 0 に戻す**。
  ゲート判定（絶対 -70）は生パワーのまま（-70 近辺は無音同然で影響なし）。
- 画面表記: Maximizer 窓の "LUFS" 見出しに `· almost`（警告色 + tooltip）、
  マスターストリップは `≈LUFS`（tooltip に「+2 dB 仮校正、リファレンス検証待ち」）。
- `typecheck` / `build` グリーン。**要実機再確認**: リファレンス曲（既知 LUFS）と
  突き合わせて `LUFS_CALIB_DB` を確定（0〜数 dB のどこかに落ち着くはず）。

### 2026-09-08 — オーディオ編集機能 Phase 1（非破壊クリップモデル）実装 + 検証

承認済み計画書: `C:\Users\****\.claude\plans\pure-booping-tower.md`（2 フェーズ）。
**Phase 1 = 非破壊クリップモデル + 再生 + 表示**（編集 UI は Phase 2）。

**データモデル（`edit/model.ts` 新規）**
- `AudioSource` = `GpuTrack` ラッパ（id/name/path/kind/envelope/refCount）。モジュール
  レジストリ（`registerSource`/`getSource`/`retainSource`/`releaseSource`/`destroySource`/
  `clearSourceRegistry`/`sourceList`）。複数クリップが 1 ソースを共有、`refCount` 管理。
- `Clip`（sourceId/startFrame/srcOffset/lengthFrames/fadeIn/fadeOut/fade*Shape/gainDb）。
  `makeClip`/`clipEnd`/`laneEnd`、`framesPerBeat`/`gridStepFrames`/`snapFrame`、`FADE_SHAPE_CODE`。
- `state.ts`: `bpm`(120)/`timeSigNum`(4)/`timeSigDen`(4)/`gridMode`('off')/`editTool`('select')
  + `GridMode`/`EditTool` 型（UI 配線は Phase 2）。

**GPU 再生パス**
- `GATHER_WGSL` → **`CLIPGATHER_WGSL`**: 1 クリップの重なり範囲だけをレーンの `[L|R]`
  スライスへ**加算**、`fadeShape()` でフェードエンベロープ乗算、`arrayLength(&outP)/2u`
  = blockFrames。struct P 64B。
- `master-bus.ts`: `MixSource` = `{ clips: LaneClip[], mix, strip, inserts }`。`renderBlock`
  step 1 を「レーン毎に `enc.clearBuffer(bigスライス)` → 重なるクリップ毎に `CLIPGATHER`
  を 1 dispatch」に。`big` usage に `COPY_DST` 追加。MIXADD 用 per-lane UBO 書き込みは
  step 3 へ移動（`blockFrames`/`accumulate`/`gain`/`pan*`/`masterGain` のみ、
  未使用の `startFrame`/`totalFrames`/`channelCount` は 0 のまま）。**step 2〜5
  （StripBank / inserts / mix-add / interleave / readback）は無改修**。
  回帰ケース（全長 1 クリップ・gain 1・fade 0）は旧 gather とビット等価。
- `scheduler.ts`: `ready()` = クリップ 1 個以上のレーン、`totalFrames()` = 全レーンの
  `max(startFrame+lengthFrames)`。

**描画**
- `waveform-renderer.ts`: `draw(clips: PeakClip[], state)`。クリップ毎にソース
  `peakBuffer` のスライスを描画（`WAVE_WGSL` View に `pxOffset` 追加、`firstPeak` は
  ソース bucket 基点）。`viewUbos` プール。
- **右ペイン行クリック → 波形ハイライト**（ユーザー依頼）: `WAVE_WGSL` に塗りつぶし
  パイプライン（`bgvs`/`bgfs`、triangle-list、View に `clipLeftPx`/`clipRightPx` 追加）。
  ピック中のクリップは**淡いミント地 + ほぼ黒の波形**。`main.ts` の `audioPick`
  （非永続、`src:ID` / `clip:laneId:clipId`）+ `pickAudio()` が全レーンを dirty に。
  両パイプラインで 1 バインドグループ共有 → 明示 `bindGroupLayout`。VIEW_UBO は 32B 据置。

**main.ts / UI**
- `Lane.track` 廃止 → `Lane.clips: Clip[]`（`path`/`kind`/`toneSeconds`/`envelope` は
  AudioSource へ）。新ヘルパ: `importWavSource`/`makeToneSource`/`addClipToLane`/
  `resolveLaneClips`/`resolvePeakClips`/`laneMeterLevel`/`renderAudioList`/`laneById`/
  `clipIsPicked`/`pickAudio`。
- 永続化 **v2**（`sources[]` + `tracks[].clips[]` + `bpm`/`timeSig`/`gridMode`）。
  **v1 マイグレーション**: `!p.sources` で判定 → 旧トラック 1 本 = 1 ソース + 全長
  クリップ 1 個。saved source id → fresh id を `srcMap` で再マップ。
- `index.html`: `#workspace-mid` 内に `#pane-right`（Sources / Clips リスト、`#audio-list`）。
  リスト行をレーンへ D&D（`src:` / `clip:` payload、ドロップ位置 `snapFrame`）。
- `README.md`: 冒頭再開手順に **ntfy 通知ルール**追記。

**検証済み**
- `npm run typecheck` / `npm run build`（renderer 22 modules）グリーン。
- 実機（`npm run dev`）: 旧 v1 プロジェクト（`%APPDATA%\gpudaw\gpudaw-project.json`）
  自動復元 → 例外なし・WGSL コンパイル OK・ASIO 96k オープン・`[project] saved`
  → reload OK（v2 往復）。右ペイン Sources 表示 OK。波形ハイライト見た目 OK（ユーザー確認）。
- **ユーザー実機の残確認**: Play の音の回帰（従来と同一か）、GPU 負荷、行→レーン D&D、
  autoload セット（MoniBlue_AprilBlues）での多トラック挙動。

**未解決 / 注意**
- クリップ bind group をブロック毎に再生成（~6 回/秒、当面許容。多クリップで重ければ
  `${srcCh0}|${slot}` キャッシュ）。
- `laneMeterLevel` はプレイヘッド下クリップのソース envelope を見る簡易実装。
- v1 で WAV 読込失敗時、旧はレーン skip → 新は空レーンが残る（クラッシュ無し）。
- `p.gridMode` は未検証キャスト。不正値だと `gridStepFrames()` が undefined（Phase 1 は
  常に 'off' なので実害無し、Phase 2 でガード）。
- `.claude/settings.json` 未作成。

**次**: Phase 2 — ツールパレット（選択/はさみ/範囲/消しゴム）、移動・分割・トリム、
カット/コピー/ペースト、パラメトリックフェード + 角ハンドル、レーン並べ替え、
ルーラ BPM/拍子 + 音楽グリッド + `snapFrame` 全操作配線、右ペインのコピー/リネーム/
未使用ソース削除。

### 2026-09-08（2）— Phase 2 増分1: 編集ツール + Edit メニュー + Undo

**操作モデル**（ユーザー方針）: ツールは「選択・マーキング」だけ。カット/コピー/
ペースト/削除/分割は**別コマンド**（ネイティブ Edit メニュー + ショートカット）。
`split` だけは性質上クリックで即実行。

**ツールパレット**（トランスポート、アイコン + キャプション、キー 1–3）
- `⬍ Select` / `✂ Split` / `▨ Range`。`erase` ツールは廃止（削除は選択 + Delete）。
- `#tracks[data-tool]` でカーソル切替。

**クリップ 2D オーバーレイ**: 各レーンの `.lane-center` に `<canvas class="lane-fx">`
（`pointer-events:none`, z-index 1、波形の上）。`drawLaneFx()` が枠線 / 選択塗り /
フェード斜線 / クリップ名 / 角ハンドル / 範囲の青帯を描く。`frame()` の
可視レーン再描画ループ内で波形描画の直後に呼ぶ。

**Select ツール**（`onEditPointerDown` → `hitTestClip`）
- 本体クリック = 選択（Shift 追加/解除）、空クリック = 選択解除（seek は生きる）
- 本体ドラッグ = 移動（`snapFrame`、単一選択なら縦で別レーンへ `laneAtClientY`）
- 左右端（`HANDLE_PX` 7）ドラッグ = トリム（`trimClipLeft`/`trimClipRight`、ソース範囲でクランプ）
- 上角付近ドラッグ = フェードイン/アウト長（`clampFades`、`CLIPGATHER` のエンベロープで再生時に反映）
- ドラッグは最初の pointermove で `pushUndo()`（バレクリックは履歴に積まない）

**Split**: `separateClipsAt(lane, cutFrames[])`。ツール/`✂` はクリック位置、
`Ctrl+E` は Range があれば範囲両端で全クリップ分離（"separate at selection"）、
無ければ playhead。分割断片は `numberSplitPair` で `base_01` / `base_02` … と個体採番
（`clipBaseName` で既存 `_NN` を剥がす、全レーン走査で空き番号）。

**Edit メニュー**（`src/main/index.ts` `buildMenu`、IPC `daw:edit <op>` →
preload `onEditCommand` → renderer `runEditOp`）
- Undo `Ctrl+Z` / Redo `Ctrl+Shift+Z`・`Ctrl+Y` / Cut `Ctrl+X` / Copy `Ctrl+C` /
  Paste `Ctrl+V` / Delete / Split `Ctrl+E` / Select All `Ctrl+A` / Deselect `Ctrl+Shift+A`
- テキスト入力フォーカス中は cut/copy/paste/selectAll/undo/redo が `document.execCommand`
  に落ちる（`activeElement` 判定）。View メニューに reload / devtools / zoom も。
- クリップボード = `{ span, entries[] }`。範囲コピー = 範囲 ∩ 各クリップのトリム済み複製、
  クリップ選択コピー = 単一レーン（最初の選択クリップのレーン）。ペースト = playhead に
  **上書き**（`clearRange` してから挿入、アクティブレーン = 選択トラック）。
- 削除 / 範囲クリア = Slip（ギャップ残す。内包=消去 / straddle=トリム / 中抜き=2分割）。

**Undo/Redo**: 全レーンの `clips[]` + 選択 + 範囲をスナップショット（最大120段、
`snapshot`/`applySnapshot`/`pushUndo`/`undo`/`redo`/`resetHistory`）。各編集 op の
先頭で `pushUndo`（no-op ガード付き）。プロジェクト読込で `resetHistory`。
→ Undo を安全にするため **`releaseSource` は VRAM を破棄しなくなった**（refCount を
減らすだけ。実破棄は将来の「未使用ソース削除」か `clearSourceRegistry`）。

**右ペイン**: Clips セクションを Sources の**上**へ（編集で触るのはクリップ）。
見出し sticky + 境界線。Clips 行 = `T<laneId> · <ソース名> · 長さ`、編集選択中は `.sel`。

**検証**: `npm run typecheck` / `build` グリーン、HMR 反映、renderer エラーなし。
ユーザー実機で右ペイン Clips 表示・Range→Split・個体採番を確認。

**未検証 / 次の増分**:
- フェード曲線 shape 切替 UI（`fadeInShape`/`fadeOutShape` は eqpow 固定）
- レーン並べ替え、右ペインのリネーム/コピー/未使用ソース削除、ルーラ BPM/拍子 +
  音楽グリッド + `snapFrame` 全操作配線
- 複数レーンをまたぐコピー/ペースト（今は単一レーン）
- 移動ドラッグの pointer capture 無し（window リスナ、実用上は可）
- 素のドラッグイン クリップは未採番（分割時のみ `_NN`）

### 2026-09-08（3）— 真空管 EQ プラグイン（Pultec EQP-1A 風）

**依頼**（ロードマップ外・単発）: プラグインに真空管 EQ 風を。バッファ回路に 12AX7
を 1 個、Low/LMF/HMF/HF… を通し、出力段にまた 12AX7、入力ゲインと出力 Vol も。
`tube.ts` の 12AX7 シミュを参考に。→ 確認の結果「要するに EQP-1 が欲しい」。

**やったこと**
- **`TubeEqInsert`**（`gpu/effects/tubeeq.ts` + `TUBEEQ_WGSL`、表示 "Tube EQ" /
  スロット短縮 "TubeEQ"）。トラック・マスター両方のラックに出る（`masterOnly` 無し）。
- 信号経路（`@workgroup_size(2)`、ch 毎 1 スレッド直列）:
  `入力 12AX7 バッファ（Input Gain で駆動）→ パッシブ・プログラム EQ（RBJ biquad ×4）
   → 出力 12AX7 メイクアップ段 → Output Vol`。
  両 triode は `tube.ts` モデル（DC ブロック → HF プリエンファシス → 非対称 tanh
  ＝ bias で 2 次・tanh で奇数次 → Miller ロールオフ）。
- **EQ セクション**（EQP-1A 準拠）:
  - **Low**: ローシェルフ Boost + ローシェルフ Atten を同時に持てる。Atten シェルフ
    は Boost の ~1.5 oct 上にコーナーを置き、両方上げると「最低域のバンプ + 低中域の
    ディップ」という Pultec 特有カーブになる。周波数スイッチ 20/30/60/100 Hz。
  - **HF Boost**: ピーキング。Bandwidth ノブで Sharp(Q≈2.6)↔Broad(Q≈0.55)。
    周波数スイッチ 3/4/5/8/10/12/16 kHz。
  - **HF Atten**: ハイシェルフカット。周波数スイッチ 5/10/20 kHz。
  - Boost/Atten は実機同様 0..10 ダイヤル（0 = フラット＝biquad は数学的パススルー）。
    周波数は連続スイープではなくフロントパネルのステップ切替（ノブで index 選択）。
- **個体差**: `TubeEqInsert.vary` = 生成時 `Math.random()` から 1 回だけ作る極小の
  係数ディザ（triode ゲイン ±0.4% / bias / HF コーナー ±1.5%）。**利用者に露出しない**
  （seed・番号選択・reseed 無し）。同じ EQ を多数トラックに挿しても音が団子に
  ならないためだけ。`ChannelStrip.vary` と同じ方針。
- UI（`main.ts` `buildFxParams` に分岐）: `eq-band` セクション ×4（GAIN / LOW /
  HF BOOST / HF ATTEN）、ロータリーノブ。周波数はステップノブ（index→Hz を `fmt`）。
  `serializeInsert` / `deserializeInsert` に `kind:'tubeeq'`。`FX_KINDS` に追加。
- 既定値は全ダイヤル 0・Input/Output 0 dB。この状態でも入力 12AX7 が常時
  ~1.1x で薄く効く（バッファ管は常にイン回路、という想定）。通常レベルはほぼ
  透過、ホットなピークだけソフトクリップ。

**バッファレイアウト**（`tubeeq.ts` ↔ `TUBEEQ_WGSL`）
- UBO 160 B（`struct TE` は全スカラー、EQ5 と同じ書式）。float index: 2..8 入力
  triode 7 個 / 9..28 biquad ×4（各 b0,b1,b2,a1,a2）/ 29..36 出力 triode 7 個 +
  outVol。
- state 256 B = 64 f32。ch 毎 base = ch*32: 0..3 入力 triode / 4..19 biquad ×4
  （x1,x2,y1,y2）/ 20..23 出力 triode。`reset()` で全 0。

**検証済み**: `npm run typecheck` / `npm run build`（renderer グリーン、バンドルに
`Tube EQ` 文字列確認）。**未実機** — WGSL コンパイルは起動時判明。

**要実機確認**
- 起動 → トラック or MASTER のスロットメニューに **Tube EQ** が出るか。挿して Play:
  - Low Boost + Atten を両方 5〜8 → 最低域が持ち上がり低中域が軽く凹む Pultec カーブか。
  - HF Boost + Bandwidth を Sharp↔Broad で可変、周波数スイッチの切替。
  - HF Atten でハイがシェルビングで落ちるか。
  - Input Gain を +6〜+12 dB → EQ 前で 12AX7 が歪む（倍音・密度）、Output で戻せるか。
  - GPU 負荷（`@workgroup_size(1)` 直列 ×2ch、tube/eq5 と同水準の想定）、テイル無し。
- 既定（全 0）でバイパスとの音量差がほぼ無いか（入力管の常時色付けが強すぎないか）。

**未解決 / 判断ポイント**
- voicing 定数は全部仮: Low Boost 0..13.5 dB / Low Atten 0..17 dB / HF Boost 0..16 dB
  / HF Atten 0..16 dB、Atten シェルフのコーナー = Boost 周波数 ×2.8、入力管
  preGain = 1.1·10^(InputGain/20)、出力管 preGain 1.06 固定。実機で耳合わせ。
- パッシブ網のロス（実機 EQP-1A は ~-16 dB を出力アンプで回復）は再現せず、biquad
  を 0 dB パススルーにして「フラットで素通り」を優先。Output はメイクアップというより
  トリム。
- Bandwidth は RBJ ピークの Q を動かすだけ（実機の bridged-T ではない）。
- Low の Boost/Atten を独立 2 biquad にしているので、両方最大だと位相回りが実機より
  多いかもしれない。

**触ったファイル**: `src/renderer/src/gpu/shaders.ts`（`TUBEEQ_WGSL` 追加）、
`src/renderer/src/gpu/effects/tubeeq.ts`（新規）、`src/renderer/src/main.ts`
（import / `FX_KINDS` / `buildFxParams` 分岐 / serialize・deserialize）、
`README.md`（ファイルマップ / 本ログ）

---

## 2026-10-03 — 内蔵 MCP サーバー（AI 回帰）+ 録音機能

**やったこと**
- 保存機能の点検: フェーダー / パン / M·S·R / ストリップ全項目 / 全インサート param+bypass /
  マスター / クリップは保存される。未保存: 選択・編集ツール・プラグイン窓状態・Undo 履歴・
  WAV 実体（パス参照のみ。欠損は無警告でクリップが消える）・`TubeInsert`（メニュー未登録で
  到達不能）。コードは未変更。
- **録音**（上の信号フロー節の「録音」参照）。トランスポートに `● Rec`、トラック詳細の
  Rec ボタン横に入力セレクト（In 1..8 モノ / 1-2,3-4… ステレオ）。`lane.recIn` を
  プロジェクトに保存（`SzTrack.recIn`、旧ファイルは In 1 モノ）。実機 Zen Go（ASIO）で
  入力 2ch オープン・録音・クリップ化まで確認。
- **MCP サーバー**（`src/main/mcp.ts`、opt-in `DAW_MCP=1` / `npm run dev:mcp`）:
  依存追加なしの手書き Streamable-HTTP（JSON 応答）。127.0.0.1 のみ、`Origin` 付き拒否、
  `application/json` 必須。ツール: state_get / project_get·load·save_file·load_file /
  tracks_list / track_add_tone·wav / track_set / strip_set / insert_add·set·remove /
  master_set / transport(play·stop·seek·record_start·record_stop) / wait / **bounce** /
  ui_query·click / screenshot / logs / audio_devices / app_reload。renderer 側ハンドラは
  `src/renderer/src/mcp-tools.ts`（UI と同じコード経路を叩く）。
- **bounce**（`PlaybackScheduler.bounce`）: デバイス無しでマスター全経路（clip→strip→insert→
  master chain）をオフライン描画し、peak/RMS/DC/クリップ数/LUFS/0.5s 輪郭を返す。24 トラック
  5 秒 ≈ 1.3 s。`insert_set` は未知の param 名をエラーにする（typo 検出）。
- 録音の回帰用に **合成入力**（`record_start` の `synthetic:true`: L 220 Hz / R 330 Hz, 0.5）。
- `disable-renderer-backgrounding` 等 + `backgroundThrottling:false`: ウィンドウが隠れていると
  rAF / タイマーが間引かれプレイヘッド停止・underrun になっていたのを解消（無人 MCP 実行で顕在化）。

**検証（実機）**: 合成入力でモノ/ステレオ録音 → bounce の peak/RMS が期待どおり、保存→
`project_load_file` 後の bounce が**完全一致**（WAV 再デコードまで含め往復 OK）。Zen Go ASIO
デュプレックスで実入力 2ch、underrun 0。

**既知の制約 / 次の一手**
- **入出力レイテンシ補正なし**: take は転送位置に置くだけ（ASIO 往復ぶん後ろにずれる）。
  `getStreamLatency` で startFrame を前倒しするオフセットを入れる。
- 録音中は VRAM のみ（クラッシュで全損）。長時間用に逐次ディスク書き出し（main で追記）を検討。
- パンチイン/アウト・ループ録音・カウントイン・入力メーターは未実装。再生中の Rec 開始は不可。
- bounce の LUFS は `LUFS_CALIB_DB`(+2) 込みの表示値。ハッシュ比較は不可（ストリップ/Tube EQ の
  インスタンス毎ランダム微変動のため）。回帰は数値の許容差で比較する。
- MCP 未実装: トラック削除、クリップ編集（移動/トリム/フェード）、テンポ/グリッド設定。
- 保存の穴（上記）: WAV 欠損の警告、editTool・プラグイン窓の保存は未対応。

**触ったファイル**: `src/main/{mcp.ts(新規),audio-out.ts,index.ts}`、`src/preload/index.ts`、
`src/renderer/src/{mcp-tools.ts(新規),audio/recorder.ts(新規),audio/scheduler.ts,gpu/track.ts,main.ts}`、
`src/renderer/index.html`、`scripts/run.mjs`、`package.json`、`.mcp.json`(新規)、`README.md`
