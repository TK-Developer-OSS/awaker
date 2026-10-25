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
- **テストベッド自動ロード**（当面）: `DAW_AUTOLOAD=<dir>` を指定すると、保存済み
  プロジェクトが無い起動時にそのフォルダの WAV を全部トラックとして読み込む。
  未設定 / 空なら無効（既定）。`?selftest` 起動時は自動ロードしない。
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

## 設計方針（既存の公開特許との重複を避けるため。変更時は要相談）

- **GPU 側にスケジューラを作らない**: 依存グラフ / 優先度キュー / 依存カウンタ式の
  GPU 内スケジューリングは入れない。スケジューリングは renderer の先読み
  （1 ブロック = 1 submit + 読み戻し）に留める。
- **個体差は埋め込み乱数のみ**: `ChannelStrip.vary` / `TubeEq` の per-instance dither は
  生成時に一度だけ作り、非表示・非永続。シード / 再抽選 / チャンネル番号選択の UI を
  足さない。コード・UI・文書に tolerance / component 系の表現を持ち込まない。
- **LF ブルーム（低域飽和）は固定量**: 入力ヘッドルームや再生系の限界に連動させない。
  「bass extension / 小型スピーカ補償」といった用途表現を避ける。
- **マキシマイザは単段・サンプル逐次**: 先行する遅いゲイン段（二段化）や、ブロック内の
  後方→前方 2 パスでゲイン輪郭を作る実装にしない。
- **バスコンプ Auto リリース**: 単一検出器 + リリース係数の補間のまま。速い / 遅い 2 本の
  検出信号の差分でリリースを切り替える実装にしない。
- **IR / コンボリューション**: IR の周波数ビンを閾値で間引く（ゼロ化する）最適化を入れない。分割 FFT 畳み込み
  （均一 / 不均一パーティション）は満了済みの手法なので使ってよい。
- **物理モデリング**: 弦（Karplus-Strong / 導波管）・管・モーダルは基礎特許が満了。既存製品の再現（名称・モデル構造の
  模倣）を目指さず、汎用の弦 / 管 / モーダルとして実装する。
- **FM シンセ**: FM 合成の基本特許（Chowning / Stanford）は 1995 年に満了。プリセットは全て新規に作り、既存機のパッチデータ・
  名称（DX など）を使わない。
- **「センド」は予約語**: 本物のトラック間接続（補助バス送り / ルーティング）のために取ってある。ライン入力や
  ライブ経路の機能名・UI 文言・コード上の名前に使わない（今は「Line」「live」と呼ぶ）。センド自体は未実装。
- **EarlySynth は独立した完成品（凍結）**: 最初の FM シンセの音を 1 つの楽器として固定したもの（kind `earlysynth`）。
  コードは `gpu/instruments/earlysynth/`（types / presets / earlysynth）と専用シェーダー `EARLYSYNTH_WGSL`（`FM_WGSL` の
  バイト単位の複製）で**完全に独立**しており、FM Synth（kind `fm`、`gpu/instruments/fm*.ts` + `FM_WGSL`）を改良しても影響しない。
  EarlySynth を編集しない。改良は FM Synth か新しいインストゥルメント側に入れる。`node scripts/golden-earlysynth.mjs`
  （`dev:mcp` 起動中）が基準値（`tests/golden/earlysynth.json`）との差を検出する。意図した変更の時だけ `--update`。
  注意: このスクリプトは起動中アプリのプロジェクトを置き換える。
- **設定は Options ファイルへ**: UI の持続設定は `localStorage` ではなく Options（固定名 `awaker-options.json`、Electron の
  userData = `%APPDATA%\awaker\`）に入れる。機能ごとに `OptionSection` を書いて `ui/options.ts` の `SECTIONS` に 1 行足すだけ。
  既存の `localStorage` 設定（ライブ遅延 / Rec offset / MIDI 出力遅延）は、いずれ Options へ移す。
- **ユーザーが使っているアプリでテストしない**: 自動操作のテストは、ユーザーの画面と Options / プロジェクトのファイルを
  書き換える。使用中のウィンドウに対しては、読み取りだけにする（破壊的な確認は、事前に知らせてから）。
- **名称**: 他社製品名・商標（SSL / Neve / Pultec / 1176 / "Differential Envelope" 等）を
  UI・コメント・文書に使わない。デバイス検出用の正規表現（`ZEN_RE` / `isNano`）は除く。

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

**取り込みの宿題**（2026-10-09 追加）

- [ ] **Cubase のバイナリ形式（`.cpr`）を直接読めるか調べる** — ユーザーの Cubase Elements 14 には DAWproject 書き出しが
      無い（Pro 限定の見込み）ため。DAWproject の読み込みはそのまま残す。`.cpr` は非公開のバイナリで、リバースエンジニアリングや
      ライセンス面の確認が要る。後回し（代替: WAV ステム + MIDI の一括取り込み）。

**公開準備のタスク**（2026-10-09 追加。機能ではなく「出し方」の宿題）

- [ ] **公開用の「Claude Code カスタマイズ用 md」を用意する（スキルファイルの代わり）** —
      `CLAUDE.md` / `DEVELOP.md` は作者の環境に特化しすぎていて（自分用のパス・ASIO 機器名・
      作業ログ・メモリ参照・個人的な運用ルール）そのままは公開できない。公開版では、
      **他の人が自分の Claude Code に載せてカスタマイズしやすい汎用の md**（`SKILL.md` 相当）を別に作る。
  - 形式の候補: Claude Code のスキル形式（`.claude/skills/<名前>/SKILL.md`、先頭に `name` /
    `description` の frontmatter）。リポジトリの規約を読ませる `CLAUDE.md` の雛形も別に添える
    （どちらを置くか、置き場所、日本語 / 英語は未決）。
  - 入れる内容（作者環境に依存しない部分だけ）: プロジェクト概要、コマンド（`dev` / `dev:mcp` / `typecheck` /
    `test` / `build`）、設計の不変条件（VRAM が正、GPU 経路、main / renderer の役割分担、WGSL は
    `shaders.ts` に集約）、拡張のしかた（インストゥルメント / Options セクション / MCP ツール /
    インサートの足し方）、テストの流れ、特許・商標に配慮した設計方針（一般化したもの）。
  - 入れない内容: 作者のパス、機器名（Zen Go / Antelope など）、セッションログ、個人メモ、
    「この端末では〜」系の環境の落とし穴（`ELECTRON_RUN_AS_NODE` のように**誰にでも当てはまる**ものだけ残す）。
  - 公開時の載せ替えで**除外するもの**（現時点）: `task.md`（特許調査メモ）、`CLAUDE.md`、`DEVELOP.md`
    （公開版に置き換える）。git 履歴は載せ替え用に別で作る（現リポジトリの履歴は公開に使わない）。

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
- テストベッド自動ロードは `DAW_AUTOLOAD=<dir>` 指定時のみ有効（既定は無効。
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

- [ ] **Options 画面のレイアウト崩れ**（2026-10-11、TK 報告）: 古いマシン（Core i5-3420 世代）で zip を展開して起動したところ、音は正常に出たが、オプションの表示のレイアウトが崩れている。
      未調査: 画面解像度 / DPI スケーリング / ウィンドウ幅 / GPU（古い内蔵 GPU）のどれが効いているか。再現条件（解像度・スケール）と崩れ方のスクリーンショットを取って直す。

- [x] **GPU ランプ: ソフトウェア描画（SwiftShader / WARP）では消灯**（2026-10-11、TK 報告）: 古いマシン（i5-3420 世代）では WebGPU が Google SwiftShader（CPU 実装）で動いていた。動作はするが GPU は使っておらず、遅い。バグ扱いで、使用はそのまま可、ランプは緑ではなく消灯（灰色）にする。
      `gpu/software-adapter.ts`（`isSoftwareAdapter`、テスト `tests/software-adapter.test.ts`）+ `main.ts` の `setGpuLamp('off', …)` + CSS `.lamp.off`。ツールチップに「software rendering (no GPU in use)」。実機（SwiftShader のマシン）での表示確認は未了。

- [ ] **iCON（Digital）との同期がずれている**（2026-10-11、TK 報告）: コントロールサーフェス（`control/mcu.ts`、Mackie Control プロトコル）側と、アプリの状態の同期が外れている。
      未調査: どの量が外れるか（フェーダー / ミュート・ソロ / 選択 / トランスポート / バンク）、どのタイミング（起動直後・プロジェクト読み込み後・再接続後）、再現手順。確認してから直す。

- [ ] **再生してもカウンタ（時計）が進まない**（2026-10-11、TK 報告。発生した PC・状況は未確認）: 音は出るが、時計（`clock` / `clockBars`）とプレイヘッドが動かない。
      経路: `frame()`（rAF）→ `scheduler.currentFrame()` = `startFrame + playedNow()`。`playedNow()` は `engineLive()`（`state.playing && started`）のときだけ進み、main の `daw:audio:status`（`playedFrames`）を補間する。
      疑う点: ① `frame()` の描画 try/catch が `render stopped` でループごと止めている（GPU ランプが赤 / ステータスに `render stopped`）② SwiftShader（CPU 描画）で rAF が極端に遅い ③ `daw:audio:status` が届いていない（`playedFrames` が増えない）④ `state.playing` が立っていない。
      次: 発生した PC、GPU ランプの色、ステータス行の文言、DevTools（`DAW_DEVTOOLS=1`）の `[gpu]` / `[audio]` ログを確認。
      **関連（2026-10-11、TK: 「フェーダーも同期しない」）**: コントロールサーフェスへの送信（`mcuTick()`）も、時計と同じ `frame()` の末尾にある。時計とフェーダー同期の両方が止まるなら、共通の原因は `frame()` ループが回っていないこと（描画エラーで停止 / rAF が来ない）の可能性が高い。上の iCON 同期の項と合わせて見る。

- [ ] **ライブ経路が、画面操作（マウス / スクロール）でプチプチ途切れる**（2026-10-25、TK 報告。**いまは棚上げ**）: VST ホスト PoC（`main/vst-bridge.ts`）の音をライブ経路で鳴らしている最中に、マウスを動かすと音が途切れる。ライン入力のライブ経路と共通の弱点と思われる。
      **測定（同日）**: Python ホスト側は健全（27717 ブロック中、予算 5.33 ms の超過は 2 回、最大 6.8 ms）。GPU 側が悪い: 1 ブロック（512 フレーム）の処理が平均 3.5 ms（予算の約 66%）だが、突発的に 13〜57 ms（ログ `[live] slow block` が 108 行）、ドロップ 116 ブロック、遅延 19 ブロック、往復の最大 89 ms、自動の着地遅延が 20 → 55 ms まで伸びた。出力のアンダーランは 0。
      **見立て（未検証）**: ① 画面の描画（波形・スクロール）と同じ GPU / メインスレッドの順番待ち。計算量ではなく待ち（スケジューリング）なので、GPU を速くしても突発の待ちは消えにくい ② 平均 3.5 ms の中身は、1 ブロックごとの小さなディスパッチ / submit / 読み戻しの固定費が大きい可能性。
      **次**: (a) ライブ中は波形などの再描画を間引く（`frame()` の dirty 化を強める）— まず、描画を止めた状態でマウスを動かして、ドロップが消えるか確認して原因を確定する (b) ライブのブロックを 512 → 1024 にして予算を 2 倍にする（遅延は約 5 ms 増える）(c) 1 ブロックの submit をまとめる。
      併せて: 出力デバイス（ASIO）のコールバックが黙って止まる事象があった（同日、YouTube 再生が始まった頃）。モニターを開き直すと復帰した。止まりを検知して状態に出す見張りが要る（PoC では PowerShell の外付けで代用した）。
      **追加の計測（2026-10-25、同日）— 原因はほぼ確定: GPU の省電力（クロック低下）**: 25 秒ごとに、ブロック数 / ドロップを測った。ライブ用トラック選択中（左ペインのメーターが毎フレーム動く）はドロップ 1673 / 1506（約 4700 ブロック中の 32〜36%）、別トラック選択中（メーターの動きなし）は 1066 / 828（18〜23%）。メーターの再描画で約 13〜15 ポイント悪化するが、メーターなしでも 2 割前後を捨てている。
      このとき `live_info` の GPU 処理は平均 6.6 ms（予算 5.33 ms、以前の測定は平均 3.5 ms）、最大 112 ms。`nvidia-smi` で 1 秒ごとに見ると、使用率 18〜50% なのにクロックは **210〜465 MHz（P8 / P5、最大 2100 MHz）**、スロットル理由は `Idle: Active`。軽く断続的な負荷（5.3 ms ごとの 3〜6 ms）をドライバが「アイドル」とみなしてクロックを落とし、1 ブロックの処理時間が約 2 倍になってドロップする。
      **次**: (a) NVIDIA コントロールパネル → 3D 設定 → プログラム設定 → Electron（Awaker）の「電源管理モード」を「パフォーマンス最大化を優先」にして再測定する（効けば根本対策の確認になる）(b) 一時的に `nvidia-smi -lgc 1500,2100`（管理者権限）でクロックを固定して再測定（戻すのは `-rgc`）(c) 恒久策: ライブ中だけ、ごく小さな計算を連続で投げて GPU をアイドルにさせない「キープウォーム」（電力を食うので任意の設定にする）(d) 描画の間引き（上の (a)）は別途効く。
      **電源管理を「最大パフォーマンス」にして再測定（2026-10-25）**: クロックは P0 / 1695 MHz に固定され、GPU 使用率は 3〜6%。それでもライブ用トラック 1 本で 30 秒に 472 / 5755 ブロック（8.2%）を捨てた。GPU 処理は平均 5.13 ms（予算 5.33 ms）、最大 33.9 ms、往復 19.8 ms、自動着地遅延は上限の 80 ms。→ **クロックは主因ではなかった**（使用率 3% なので計算も主因ではない）。1 ブロックあたり約 5 ms が、書き込み / submit / 読み戻し（`mapAsync`）の往復とレンダラ主スレッドの JS で消えており、512 フレーム（96 kHz で 5.33 ms）の予算にほぼ余裕がない。最大 34 ms の突発で落ちる。ホスト側（Python）の往復は平均 0.4 ms と無関係。
      **結論**: ライブ経路（512 フレームの小ブロック往復）に、シーケンスの再生を載せる設計が合っていない。**VST 音源は、通常の再生経路（先読み 0.5 秒・大きいブロック）の音源として扱うのが筋**: ホストを時間より先回りで実時間の約 18 倍の速さでレンダリングさせ、レーンのバッファに書く（GPU 内蔵音源と同じ「ノート → 先読みレンダリング」の形）。ライブ経路は、鍵盤のライブ演奏だけに使い、ブロックを 1024〜2048 に広げて遅延と引き換えに安定させる。
      **ブロックの大きさ × レーン数の測定（2026-10-25、GPU は電源管理=最大パフォーマンス、P0 固定、各 20〜25 秒、`monitor` の `block` 引数で切り替え）**:
      初期ストリップ（サチュレーション・EQ なし）: 1 本 — 512: 捨て 1.7% / 1024: 0% / 2048: 0%。2 本 — 512: 5.0% / 1024: 0% / 2048: 0%。4 本 — 512: 7.1% / 1024: 0% / 2048: 0%（1 ブロックの処理は 1 本 3.6〜4.2 ms → 4 本 4.5〜5.3 ms。レーンが 1 本増えて約 0.45 ms で、**固定費（往復の待ち）が大半**）。
      重いストリップ（サチュレーション + 4 バンド EQ + コンプ + HPF + リバーブ + EQ5 のインサート）× 4 本 + 画面操作（トラック選択の連打）: 512: **捨て 50.7%**（処理 10.9 ms）/ 1024: 5.5%・遅延 127（処理 10.1 ms ≒ 予算 10.67 ms で余裕なし）/ **2048: 0%・遅延 1**（処理 11.4 ms、予算 21.3 ms）。重いレーンは 1 本あたり約 1.7 ms の計算が乗る。
      **評価**: 「4 本を最低限通す」は、**ブロック 2048（着地遅延 約 40 ms）なら通る**（重いストリップ + 画面操作でも）。1024 は余裕がなく、512 は無理。ライブ演奏用の低遅延（1024 以下）にするなら、リファクタが要る: ① ライブ経路を専用 Worker + 専用の WebGPU デバイスに分離（画面描画の主スレッドから切り離す）② レーンごとの dispatch を 1 バッチにまとめる（再生経路にある全トラックバッチ版の流用）③ ステージングバッファのプール / submit の削減で固定費（約 3.5〜4 ms）を縮める。
      **実施（2026-10-25）— 読み戻しの重ね合わせ（パイプライン化）**: 原因は「1 ブロックごとに `await mapAsync` で読み戻しの完了を待ってから次へ進む」ため、処理できる数が 1 ブロックの往復時間（約 4〜5 ms）で頭打ちになっていたこと（GPU の計算は数 ms）。`MasterBus.renderBlock` の読み戻しバッファ（音声 + ピーク）をプールから借りる形にし、結果は共有の `out` ではなくブロックごとの新しい配列にした。`LiveBus.drain` は最大 `LIVE_DEPTH`（3）ブロックを同時に走らせる（GPU のキューが提出順を保つので、ストリップ / インサートの状態は順序どおり進む。結果はフレーム番号つきなので完了順も問わない）。
      **効果（同条件の再測定）**: 軽いストリップ 1・2・4 本 × ブロック 512 / 1024 / 2048 はすべて捨て 0%（以前の 512 は 1.7 / 5.0 / 7.1%）。重いストリップ 4 本 + 画面操作は 512: 50.7% → 3.2〜3.4%、1024: 5.5%（遅延 127）→ **0%**（遅延 2〜3）、2048: 0%。通常の再生（再生経路も同じ `MasterBus`）は、アンダーラン 0・メーター正常で退行なし。
      併せて: ライブ経路の既定ブロックを **1024** にして、「Line input」に Block の選択（512 / 1024 / 2048）を足した（`awaker.liveBlock` に保存）。自動の着地遅延は、遅延ブロックが 8 秒出なければ 2 秒ごとに 2.5 ms ずつ戻す（以前は広がる一方で、80〜96 ms に張り付いた）。
      **残り**: 画面操作の最大 60〜70 ms の突発（トラック選択の連打で詳細ペインを作り直す負荷）で、自動の着地遅延が 86 ms まで広がる。ライブ経路を専用 Worker（専用 WebGPU デバイス）に分ければ根治できるが、ストリップ / インサートの GPU 資源とパラメータの同期の作り直しが要る大工事。まずは実際の操作（マウス移動・スクロール）で足りるかを実機で確認する。

**VST インストルメント対応（2026-10-25 追加。方式・測定の詳細は末尾のセッションログ 2026-10-25）**

- [ ] **本物の VST ホスト（別プロセスの exe）を作る** — C++ + VST3 SDK（JUCE は AGPL / 商用でライセンスが合わないので使わない）。プロトコルは `main/vst-bridge.ts` のもの（PoC の Python ホストは `pedalboard` = GPLv3 で、リポジトリに入れない）。この PC には MSVC / CMake / Rust が無い（Python と Node のみ）ので、ビルド環境の用意が先。**BFD Player は PoC のホストでは、処理の最初の呼び出しで `BFDPlayer.vst3` 内のアクセス違反で落ちる**（ブロックの大きさ・レート・状態・チャンネル数・エディタを開いたあと、どれでも同じ）。バス（多出力）の設定を自前で制御する本物のホストで再挑戦する。
- [ ] **プラグインの state の保存と復元をプロジェクトに入れる** — Vital は不要。Komplete Kontrol（Kontakt の音源）は保存した状態（1179 バイト）から音源が復元されず（20 秒待っても無音）、窓で音源を選んだ同じプロセスの中でだけ鳴った。BFD は状態（478 KB）は保存できたが、処理で落ちる。サンプラー系は、エディタ（画面）を開く操作と一体で読み込まれる作りの可能性。本物のホストで、エディタを常駐させる / プリセットのパスを渡すなどを試す。
- [ ] **シーケンスの再生を「先読みレンダリング」で通常の再生経路に載せる**（ライブ経路は鍵盤の演奏用）— ホストを時間より先回りで実時間の約 18 倍の速さでレンダリングさせ、レーンのバッファに書く（GPU の内蔵音源と同じ形）。MIDI トラックの Out に「VST host」の仮想ポートを足し、トランスポートと同期させる。ノートオフの欠落対策（下）が前提。
- [ ] **安全装置**: ブリッジの停止時・ホストの切断時に、全ノートオフとサウンドオフ（CC123 / CC120）を必ず送る（2026-10-25: 繰り返し演奏を暴走させたとき、止めるのに、ループ・ホスト・トランスポートを個別に落とした）。出力デバイス（ASIO）のコールバックが黙って止まる事象の見張り（上のライブ経路のタスクを参照）。
- [ ] **リターン用の仮想オーディオ I/F 路線（TK 提案 2026-10-25。VST ホスト路線と併存させる）** — スタンドアロンの音源（BFD / Komplete Kontrol など）の出力を仮想インターフェース（VB-CABLE / Voicemeeter など）に向け、Awaker の入力として戻す。**必要なもの**: 入力デバイスの選択と複数デバイスの同時使用（今は Zen Go の ASIO 入力しか読めず、選択 UI も無い。WASAPI 入力）、2 つのクロックのずれの補正（ドリフト）、遅延の補正。**制約**: サンプル精度の同期は不可、リアルタイムのみ（バウンスの数値回帰に載らない）、プラグインの状態はプロジェクトに入らない、VB-CABLE は 1 本（ステレオ）なので音源ごとに分けるには複数のケーブルが要る。**Antelope のループバックは却下**（Windows 側にも同じ音が鳴り、二重再生になる）。メリット: プラグイン互換性の問題（BFD が落ちる等）を、ホストの実装から切り離せる。
      **仮想 I/F を自作できるか（TK の問い、2026-10-25）**: 作れるが重い。① WDM のオーディオドライバ（カーネルモード）は、Windows のドライバ署名（Microsoft の証明書 / 認証）が要り、実用にするハードルが高い ② ASIO の仮想ドライバはユーザーモードの DLL（COM + レジストリ登録）で書けるが、相手のアプリがその DLL を読み込む形で、ASIO の仕様（Steinberg の SDK）に依存し、本体に Steinberg のコードを入れない方針（add-on 分離、2026-10-11）と衝突する。**現実的なのは既存の仮想ケーブル（VB-CABLE / Voicemeeter など）を使い、Awaker に「入力デバイスの選択 + WASAPI 入力 + ドリフト補正」を足す形**。自作ドライバは、その路線で足りないと分かってから検討する。
- [ ] 画面（「VST host (PoC)」の節）の続き: ホストのメーター、音源の自動起動、プラグインの GUI（別窓）、保存と復元の操作。
- [ ] 自動の着地遅延が戻るのが遅い（遅延ブロックが 8 秒出なければ、2 秒ごとに 2.5 ms。86 ms から戻るのに約 70 秒）。

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
  （`DAW_AUTOLOAD=<dir>` 指定時のみ。未設定 / 空なら無効）の WAV を `daw:autoloadWavs` で列挙 → `loadFiles()` で全部トラック化。
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

---

## 2026-10-03 — 外部コントローラ対応の第一歩: iCON P1-Nano（MCU モード）

**やったこと**: `src/renderer/src/control/mcu.ts`（Mackie Control ドライバ、Web MIDI）を新規。
アクティブトラック（選択レーン）にモーターフェーダー追従、7seg タイムコード（hhh mm ss ff@30）、
アサインメント表示=トラック番号、LCD にトラック名 + dB、SEL/MUTE/SOLO/REC・PLAY/STOP の LED、
トランスポート（PLAY/STOP/REC/REW=頭出し/FF=終端）、BANK ◀▶ でアクティブトラック移動。
`main.ts` の boot() で既存 UI 経路（strip の fader input / M·S·R の click）へ結線、`frame()` で `mcuTick()`。
`src/main/index.ts` に `midi`/`midiSysex` の権限ハンドラ（再起動が必要）。
**設計メモ**: audify に RtMidi は入っていないため Web MIDI を採用（制御面のみ。オーディオ I/O は main のまま）。
**未確認**: 実機未接続（ポート名は /p1-?nano|platform ?nano|icon/i で照合）。LCD の SysEx デバイス ID(0x14)・
7seg の桁配置は実機で要確認。マスター/ジョグ/V-Pot は未対応。

---

## 2026-10-08 — dev 版リリース準備

**やったこと**: `README.md` → `DEVELOP.md` にリネーム（公開向け `README.md` を新規）。全ソース / LICENSE / NOTICE /
package.json の署名を `TK-Developer-OSS <tk.oss.developer@gmail.com>` に統一。コメント中の他社製品名・
商標を汎用名へ置換（SSL→SL、Pultec→Tube、EQP-1A→EQ1、Neve→NV、1176→76 等。`homage` 表記も削除）。
デバイス検出の正規表現（`ZEN_RE` / `isNano`）は機能上必要なので維持。特許の簡易調査を行い、
現行コードに抵触の恐れが高いものは見つからず。回避のための設計方針を上記「設計方針」節に記録。
**確認**: `typecheck` / `build` グリーン。実機再生は未確認（今回は文言・メタデータのみの変更）。
**注意**: 過去ログ中の旧名称（Pultec 等）は当時の記録のためそのまま。

---

## 2026-10-08（2）— DAWproject 取り込み（Cubase 14+ → Awaker）

**方針**: 主フローは「Cubase で土台を作り、Awaker で仕上げる」。編集系（MIDI 編集 / ピアノロール / SMF /
MIDI 入出力 / MCU 拡張 / DAWproject 書き出し）は後回し。読み込みの確度と仕上げ機能を優先する。
**やったこと**: `src/main/zip.ts`（zip リーダ、zlib）、`daw:dawproject:open`（WAV を userData/dawproject/ に展開）、
`src/renderer/src/project/dawproject-import.ts`（XML → テンポ/拍子/トラック/音量/パン/ミュート/ソロ/クリップ/フェード/
MIDI ノート）。結果は `restoreProject` に流す（通常の Open と同じ経路）。UI は「⇪ Import DAWproject」、
MCP は `dawproject_import {path}`。MIDI は `midi/model.ts` にデータとして保持・保存するのみ（表示/編集なし）。
**確認**: 仕様どおりの合成ファイルで end-to-end（位置/オフセット/フェード/パン/音量/テンポ/拍子・bounce）。
**未確認**: Cubase 実機の書き出しファイル（ワープ・音声形式・グループの書かれ方）。取り込めない物は警告に出す
（プラグイン / センド / オートメーション / タイムストレッチ / テンポ変化 / WAV 以外）。

---

## 2026-10-08（3）— インストルメントトラック + 簡易 GPU シンセ

**方針**: MIDI トラックを拡張して「インストルメントトラック」にした。MIDI（ノート）は `midi/model.ts` のデータで、
`MidiTrack.instrument = {kind, params}` を持つと、対応する**オーディオレーン**（`Lane.inst`）が作られ、
そのレーンの音は GPGPU インストルメントが **VRAM 上に直接レンダリング**する（CPU 側にサンプル配列なし）。
レンダ結果は通常のオーディオソース（`AudioSource.kind='inst'`）なので、ストリップ / インサート / ミックスは
そのまま効く。保存はノートとパラメータだけ（`SzTrack.instrumentOf` = midiTracks の添字、クリップは持たない）。
読み込み時に再レンダリングする。ノート / パラメータ / テンポが変わると 150ms デバウンスで再レンダ（署名一致ならスキップ）。
**インストルメント契約**: `gpu/instrument.ts`（`Instrument.render(notes, sr, GpuTrack)` / `registerInstrument`）。
GPGPU インストルメントを足す時はこれを実装して登録する。パラメータは素の JSON。
**簡易シンセ**: `gpu/instruments/synth.ts` + `SYNTH_WGSL` / `SYNTH_FILTER_WGSL`。ワークグループ=256 フレーム、
重なるノートを共有メモリに集めて各スレッドが和を取る。ボイスは状態なし（位相は u32 固定小数点の
`経過フレーム×増分` ＝ 長い音でも厳密）。2 オシレータ（±デチューン、L/R に spread）+ サブ、saw/square は PolyBLEP、
ADSR は解析式、最後に TPT SVF ローパス（再帰なので 1 スレッド直列・1M フレーム単位で分割）。
UI は詳細ペインの「Synth」節。MCP: `midi_track_add`（ノート配列から作成）/ `instrument_set`。
**DAWproject**: ノートトラックは自動でインストルメントレーン（シンセ）になる。音声+ノート両方を宣言するトラックは
クリップ内容で判定。
**確認（実機・MCP）**: A4=440.0Hz ぴったり + 3 倍音（tanh）、ADSR 比（サステイン 0.705）とリリース、C-E-G 和音の
ピーク周波数、保存→再読込で同じ音、DAWproject（合成ファイル）のノートトラックが鳴る。300 ノート / 60 秒の追加は即時返却。
**未実施**: ノート編集 UI（ピアノロール）、実機での聴感確認、ライブ演奏（ブロック描画の駆動は未対応だが
シェーダは `base` オフセット対応済み）、ボイス上限は 1 ブロックあたり 96（超過分は無音）。

---

## 2026-10-08（4）— MIDI 周りの一括対応（ピアノロール / SMF / MIDI 入出力 / MCU 拡張 / DAWproject 書き出し）

**やったこと**
- **ピアノロール**（`midi/piano-roll.ts` + `midi/roll-logic.ts`）: 追加 / 移動 / 右端リサイズ / Shift 複数選択・範囲選択 /
  ベロシティ帯 / Delete・右クリック削除 / スナップ / ズーム。インストルメントレーンのダブルクリックか「♪ Piano roll…」で開く。
  ポインタ操作は `pointer()` に集約し、MCP の `pianoroll` ツールで同じ経路を再現できる（テスト用）。
  編集は `midiChanged()` → 150ms デバウンスでシンセを再レンダリング。Undo は未対応。
- **SMF**（`midi/smf.ts`）: 読み込み（format 0/1、ランニングステータス、format 0 はチャンネルで分割）と書き出し
  （format 1、480 ppq）。ツールバーの Import MIDI / Export MIDI、MCP `midi_import` / `midi_export`。テンポ変化は無視（最初の値）。
- **MIDI 入出力**（`midi/io.ts` + `midi/io-logic.ts`、Web MIDI）: 外部シンセへの出力（20ms ポンプ、先読み 150ms、
  Out delay でオーディオ遅延に合わせる）、キーボードからのノート録音（R で武装 + 入力ポート設定 + Rec。イベント時刻で位置決め）。
  詳細ペインの「MIDI I/O」。MIDI のみの録音は `scheduler.startRecord(..., [], {synthetic:true})` でトランスポートだけ走らせる。
- **MCU 拡張**（`control/mcu.ts`）: V-Pot=パン（押下で中央、LED リング）、ジョグ=再生位置（16 分音符単位）、
  マスターフェーダー（ch9 ピッチベンド + モーター追従）。**既存バグ修正**: `dbToPos` が 0 dB 未満で NaN を返し、
  モーターフェーダーが負のゲインに追従していなかった。
- **DAWproject 書き出し**（`project/dawproject-export.ts` + main の `daw:dawproject:save`）: オーディオトラック（元 WAV をそのまま
  同梱、元のサンプルレート）、インストルメントレーンは MIDI ノートとして、音量 / パン / ミュート / ソロ / テンポ / 拍子 / マスター。
  GPU 生成ソース（デモトーン）は float WAV にレンダリング。**公式 Project.xsd で検証済み**（初版の `contentType="audio mixer"` は
  スキーマ違反だったので修正）。書き出さないもの: ストリップ / インサート / クリップゲイン / シンセパラメータ。
- **テスト**: `npm test`（`scripts/test.mjs` が esbuild で tests/*.test.ts をバンドルして Node で実行）。SMF / ピアノロール計算 /
  MIDI スケジューリングと録音 / MCU 値変換 / zip / DAWproject の往復。GPU やハードは不要な範囲のみ。

**確認の範囲（重要）**
- 実アプリ（MCP 経由）で確認: SMF 往復、ピアノロールの全操作、DAWproject の取り込み→書き出し→再取り込み、シンセ音の周波数・エンベロープ。
- **ハード未確認**: MIDI の外部出力 / キーボード録音 / MCU の V-Pot・ジョグ・マスターフェーダー（この PC に MIDI 機器なし。ロジックは
  単体テスト済みだが実機のタイミングは未確認）。
- **Cubase 実ファイル未確認**: 取り込みは仕様と合成ファイルで確認。実際の Cubase 14 の書き出しでの挙動は未確認。
- XSD 検証の手順: `Project.xsd`（bitwig/dawproject）を取得し、xmllint 系ツールで書き出した project.xml を検証する
  （今回は xmllint-wasm を作業ディレクトリに入れて実施。プロジェクトの依存には入れていない）。

**次の候補**: ノート Undo / コピペ / クオンタイズ、インストルメントの追加（IR コンボリューション、物理モデル。
`gpu/instrument.ts` の契約に沿って登録する）、テンポ変化の取り込み、ライブ演奏用のブロック描画。

---

## 2026-10-08（5）— ドラムマシン + ハンドパーカッション（GPGPU インストルメント `drums`）

**やったこと**: `gpu/instruments/drums.ts` + `DRUMS_WGSL`。アナログ風ドラム（キック / スネア / クラップ / ハイハット C・O /
タム 3 種 / リム / カウベル / クラベ / シンバル）+ ハンドパーカッション（ジャンベ 低・中・スラップ、ギロ 短・長、
ボンゴ 高・低、コンガ ミュート・オープン・ロー）の 22 ボイス。サンプルではなく**解析式合成**（キックは指数ピッチ
スイープの位相を閉形式で積分、ノイズは補間付きの区間ハッシュ＝帯域制限、ハットは 6 つの方形波のコム HP、ギロは
リッジのパルス列）。シンセと同じく状態なしでノート列から VRAM にレンダリングする。クローズドハットがオープンハットを
チョーク（2ms フェード）。キーは GM 準拠（36 キック / 38 スネア / 39 クラップ / 42,46 ハット …）+ 独自（ジャンベ 52-54、
ギロ 73-74、ボンゴ 60-61、コンガ 62-64）。GM のエイリアス（35, 40, 43, 44, 47, 50, 51, 57, 59）も受ける。
**ステップシーケンサー**（`midi/step-grid.ts` + `midi/step-logic.ts`）: 1 行 = 1 ボイス、16 ステップ/小節、小節ページ、
クリックで追加/削除・Shift=アクセント・右クリック=ゴースト、プリセット 5 種（Basic beat / Four on the floor / Trap /
Latin percussion / Djembe groove）。ピアノロールと同じクリップを編集する（鍵盤の列にはドラム名が出る）。
ツールバーの「+ Drums」、ドラムレーンのダブルクリックで開く。MIDI チャンネル 10 のトラックは SMF / DAWproject 取り込みで
自動的にドラムになる。DAWproject 書き出しはトラックの MIDI チャンネルを書く（ドラム = 9）。
MCP: `drum_pattern_add`、`midi_track_add` の `instrument: 'drums'`。
**確認（実機・MCP）**: 全 22 ボイスが有限値で鳴り（クリップなし）、基音・長さ・明るさの大小関係が期待どおり
（キック基音 58Hz、オープンハット > クローズドハット、ジャンベ低 < 中、コンガ低 < ミュート、ボンゴ高 > 低、タム低 < 中 < 高）。
チョーク動作、保存→再読込で同じ音、SMF 往復でドラムに戻る、DAWproject 往復。バグ修正: カウベルの高域エイリアシング。
**未実施**: 聴感の調整（音色は数値でのみ確認）、スウィング / 小節ごとのパターン、ドラムのパラメータ（キットのチューニング）の
ボイス別ノブ、シンセ側のノート Undo。
**名称**: UI / コメントは「Drum Machine」。製品名・商標は使わない（設計方針参照）。

---

## 2026-10-08（6）— FM シンセ（GPGPU インストルメント `fm`、4 オペレーター、ドライ）

**方針**: エレクトロポップで困らない表現力 + **トランジェント重視**。エフェクト（コーラス / ディレイ / リバーブ）は
内蔵せず、トラックのインサート（将来はセンド）で足す前提。**注意: この DAW にセンドはまだ無い**（トラックごとのインサート 8 スロット +
マスターのみ）。センドが要るなら別途実装が必要。
**やったこと**: `gpu/instruments/fm.ts` + `fm-types.ts` + `fm-presets.ts` + `FM_WGSL`。ステートレス（経過時間の閉形式）。
オペレーター 4 つ、接続は**行列**（`mod[i][j]` = j→i、j>i のみ。`out[i]` = 出力ミックス）なのでアルゴリズムは JSON で書け、
オペレーター数は `FM_OPS` と配列長で将来 6 に拡張できる。各オペレーター: 比率 / ファイン(ct) / 固定 Hz / レベル / ベロシティ感度 /
ADSR（指数減衰、アタック最短 0.3ms）。モジュレーターのレベル = 位相偏移 `level×8 rad`、ベロシティ感度で強く弾くほど明るくなる。
トランジェント: ノート頭の帯域制限ノイズ「クリック」、ピッチパンチ（`f·(1+a·e^{-t/τ})` の位相積分を閉形式、位相は u32 固定小数点
+ 有界な f32 項）、1 オペレーターの自己フィードバック（固定小数点 3 反復の近似）。マクロ: Index / Click / Punch / Atk× / Rel× / Gain。
**プリセット 18 種**（全て新規）: Punch Bass / Pluck Bass / Rubber Bass / Hollow Bass / Electric Piano / FM Keys / Glass Pluck /
Marimba / Bell / Clav / Pop Pluck / Arp Bleep / Brass Stab / Synth Brass / Saw Lead / Square Lead / Soft Pad / Organ。
UI: 「+ FM」、詳細ペインの「FM synth」（プリセット選択 + マクロ）。MCP: `midi_track_add` の `instrument:'fm'`、
`instrument_set {track, params:{preset:'Bell', ...}}`（preset を先に読み込み、他のキーで上書き）、`instrument_presets`（一覧と
パラメータの説明）。オペレーター単位の編集は params JSON（AI / MCP 経由）。
**確認（実機・MCP）**: 18 プリセットを C2 / C4 で鳴らして数値確認 — 有限・クリップなし・ピーク 0.4〜0.64、立ち上がり
（パーカッシブ系は 6ms 以内、低音は正弦波の 1/4 周期の物理下限があるため 10ms 以内）、低音の基音 70Hz、ベルの重心 2.8kHz vs
パンチベース 78Hz、プラックは 12dB 以上減衰、サステイン系は保持。保存→再読込で同じ音、未知のプリセットは拒否。
**未実施**: 聴感の調整（音色は数値でのみ確認）、オペレーター単位の UI、LFO / ポルタメント / モノ動作、ベロシティ以外の
キースケーリング、プリセットの追加（ダンス系 / ローファイ系など方向性が決まれば足す）。

---

## 2026-10-08（7）— ライン入力（ストリップ + インサートを通したリアルタイム入力）と録音のタイムアライメント

**方針**: ストリップの入力に「ライン入力」を追加。先読み 0.5 秒の再生経路はそのままに、**別の小ブロック経路（ライブ経路）**で
入力を GPU のストリップ + インサートに通して出力へ返す。時間は**フレーム番号で整合**させ、到着時刻には依存させない。
「センド」という語は本物のトラック接続用に予約（上記設計方針）。
**構成**:
- main（`audio-out.ts` + `live-ring.ts`）: 入力デバイスの各ブロックを ~256 フレームにまとめて renderer へ（`daw:live:in`。録音用の 8k バッチとは別）。
  renderer から処理済みブロックが「出力フレーム位置」付きで戻る（`daw:live:out`）。出力コールバックが**そのフレームに到達した時**、
  再生リングのブロックに**加算**する（`LiveRing.write/take`）。間に合わなかったブロックは**ずらさず捨てる**（未来側の部分は残す）。
- renderer（`audio/live-bus.ts`）: `LiveBus` が 512 フレーム分を貯め、各ライブレーンのチャンネルを VRAM の小バッファへ上げ、
  **専用の `MasterBus` インスタンス**に「1 ブロック長のクリップ」として流す（ストリップ → インサート → フェーダー / パン → マスターフェーダー）。
  マスターのインサートは掛からない（再生ストリームの状態を持つため）。ライブレーンはクリップを持たず、再生経路の `ready()` から自動的に外れる。
- 遅延: 入力位置 + `latencyMs` に着地。自動 = 1 ブロック + 15 ms（96k で約 20 ms）、遅延ブロックが出たら 1 秒に 1 回 5 ms ずつ広げる
  （最大 +60 ms）。手動指定も可（UI の Live latency）。総モニター遅延 = デバイス入力遅延 + 着地遅延 + デバイス出力遅延。
- 開始前に **ウォームアップ**（無音を処理時間が落ち着くまで最大 1.2 秒）: コールド GPU は最初の約 20 ブロックが 3〜4 倍遅く、
  これが無いと起動直後にキューが溢れて落ちる。
- トランスポートの Play / Rec / Stop ではデバイスを開き直す（その瞬間は途切れる）。Monitor が ON なら停止後に再開する。
  Monitor ボタン = 停止中もデバイスを開いてモニターするスイッチ（ASIO を占有するので自動にはしない）。
- **録音のタイムアライメント**: テイクを（ドライバ報告の入出力遅延の合計 + Rec offset）だけ前へずらして配置し、0 より前に出る頭は
  クリップの `srcOffset` でトリム（`Take.skip`）。Rec offset はループバックで測った値を入れる想定（測定ツールは未実装）。
**UI**: ツールバーの「+ Line」「Monitor」、詳細ペインの「Line input」（入力ch / ステレオ、モニター ON/OFF、Live latency、Rec offset、
往復時間・GPU 時間・late / dropped の表示）。プロジェクト保存は `SzTrack.live` + `recIn`。MCP: `live_lane_add` / `monitor`
（`synthetic: 'impulse'` で合成インパルス入力、`latencyMs`）/ `live_info`。
**確認（実機 = この PC の ASIO、MCP）**: 合成インパルス（4800 フレームごと）が出力で入力位置 + 着地遅延ちょうどに着地
（**誤差 0 フレーム**、再生中の同時実行でも 0、遅延ブロック 0、再生側アンダーラン 0）。GPU は 1 ブロック平均 3.4 ms
（ストリップ飽和 + リバーブ + ディレイ + EQ5 で 7.7 ms 以内）、往復平均 4 ms。コールドスタート 2 回とも late 0 / dropped 0。
録音補正: ドライバ報告 799 フレーム（8.3 ms）ぶん前へ、0 から録ると頭 799 フレームをトリム。保存→再読込で live が残る。
**未確認 / 未実装**: 実機の物理入力でのループバック整合（合成入力で経路全体の整合は確認済み。実入力が流れること自体は ASIO で確認）、
Rec offset の自動測定、WASAPI での挙動、マスターインサートのライブ経路への適用、ブロック 256 以下（この GPU では 1 ブロック約 3.4 ms
で、96k の 256 フレーム = 2.7 ms の予算を超えるため 512 が下限）、センド（トラック間接続）。

---

## 2026-10-08（8）— EarlySynth（凍結）とインストゥルメントの差し替え

**EarlySynth**: 最初の FM シンセの現状を「EarlySynth」（kind `earlysynth`）として固定した。実用の改良とは別に、
このシンセの音を残す。保存データの `fm` は別名として読まれる（`normalizeInstrumentKind`）ので、既存プロジェクトの音は変わらない。
凍結の裏付け: `scripts/golden-earlysynth.mjs` が全 18 プリセットを 2 種類のベロシティで GPU 経由で書き出し、ピーク / RMS / 積算ラウドネスを
基準値（`tests/golden/earlysynth.json`、許容 ±0.05 dB）と比べる。基準値を壊した複製で、ずれを検出して終了コード 1 になることを確認済み。
**差し替え**: トラックの音源（インストゥルメント）だけを入れ替えられる。ノート・ストリップ・インサート・フェーダーは残る。
詳細ペイン上部の「Instrument」ピッカー（Simple Synth / EarlySynth / Drum Machine）。離れる側のパラメータはセッション中だけ覚え、
戻すと元の音になる（ビット単位で一致を確認）。MCP: `instrument_swap {track, kind}`（旧名 `fm` も可）。
**次**: 「実シンセ」は新しい kind として作る（EarlySynth の fm.ts / FM_WGSL を元にコピーして育てる）。ピッカーに自動で並ぶ。
**反省**: レンダラのコードを直すと動作中のアプリが再読み込みされ、未保存の編集が消える。作業前に `project_get` で退避する
（今回は退避して復元した）。

### 2026-10-08（8）の訂正 — EarlySynth と FM Synth を別コードに分離

上の（8）では EarlySynth を fm.ts のリネームとして固定していたが、「FM シンセ自体は改良を進め、今のシュールな音は別に取っておく」
という意図に合わせて**コードごと分離**した。
- **EarlySynth**（`earlysynth/`、`EARLYSYNTH_WGSL`、kind `earlysynth`、UI「+ EarlySynth」）= 凍結。曲のインストゥルメント 4 トラックはこれ。
- **FM Synth**（`fm*.ts`、`FM_WGSL`、kind `fm`、UI「+ FM」）= 改良用。今は EarlySynth と同じ音（複製の起点）で、ここから育てる。
- 旧 `fm` → `earlysynth` の別名は撤去（`fm` は再び FM Synth 自身）。保存済みの `fm` は無かったので移行は不要（曲のトラックは
  `earlysynth` に固定して復元した）。
- 検証（実機・MCP）: 基準値スクリプトが独立コピーで「18 プリセット × 2 ベロシティ 一致」、FM Synth のパラメータを大きく変えても
  EarlySynth は動かない、FM Synth は変わる。ピッカーの 4 つ（Simple Synth / EarlySynth / FM Synth / Drum Machine）で相互に差し替え可。
- MCP: `instrument_presets` は `{earlysynth, fm, drumPatterns}` を返す。`midi_track_add instrument` は `synth | earlysynth | fm | drums`。

---

## 2026-10-09 — フェーダーのつまみを SVG に置き換え（出自をはっきりさせる）

`src/renderer/public/feder.png`（28×56 の小さな写真由来ビットマップ）を廃止し、**ベクターでゼロから描いた `feder.svg`**
（28×56 ユニット、同じ 1:2。表示は従来どおり 25×50 px、`index.html` の CSS の `url('/feder.svg')`）に置き換えた。
写真・ラスターデータは含まない（図形とグラデーションだけ）。ヘッダーにコピーライトと SPDX を入れ、Git の履歴で作成の経緯が残る。
古い PNG は履歴には残るが、ツリーからは外した。原本の写真はスマホ側にあるとのこと（ここには置かない）。

---

## 2026-10-09（2）— Options パネル（設定をファイルに保存、起動時に自動で読み込み）

**要件**: 設定はファイルに保存でき、ファイル名は固定。OK で保存し、以後は自動で読み込む。今後も項目が増える。
**構成**:
- `ui/options-model.ts`（純粋・テスト済み）: `OptionSection`（id / title / fields / defaults / apply / preview）、値の検証・補完
  （欠けた項目は標準値、範囲外は丸め、選択肢にない値は標準値、**未知のセクションは捨てずに保持して保存し直す**、壊れた / 無いファイルは標準値）。
- `ui/options.ts`: パネル（登録されたセクションから自動で組み立て）。変更はその場で実画面に反映（ライブ）、**OK** で保存して閉じる、
  **Cancel / Esc / 背景クリック** で保存済みの状態に戻す、**Reset to defaults**。フッターに保存先を表示。ツールバーの「⚙ Options」。
- main: `daw:options:load` / `daw:options:save`。保存は一時ファイルに書いてから置き換え（途中で落ちても壊れない）。
  上限 256 KB。ファイルは `%APPDATA%wakerwaker-options.json`。読めないファイルは標準値で起動し、警告を出す。
- 最初のセクション = **フェーダーのつまみ**（`ui/fader-skin.ts`）: 角の暗さ（None / Soft / Standard）、つまみの明るさ
  （Standard / Dimmer / Dimmest）、黒いインデックスラインの太さ（Thin / Standard / Bold）。標準値は `public/feder.svg` と
  完全に同一（テストで保証）で、標準の見た目は静的ファイルから、変えた見た目だけが data: URL の SVG として注入される。
**確認**: 純粋ロジックのテスト、実機で（初回はファイル無し → 開く → ライブ反映 → Cancel で復元かつ未保存 → OK で保存 →
再起動 / 再読み込みで自動適用 → パネルに保存値 → Reset）。起動直後に生成 SVG が当たっていることを CSS で確認。
**経緯の反省**: 途中の「thin に見える」失敗は、ユーザーがパネルで Thin を選んだ操作と私のテストが同じウィンドウ・同じファイルで
重なったもの（バグではない）。その際、ユーザーの保存値を私のテストが上書きしてしまったので、Thin に戻した。
**ユーザーの現在の設定**: 角 Standard / 明るさ Standard / ライン Thin（「楚々とした落ち着いた感じが疲れにくそう」）。

---

## 2026-10-09（3）— トランスポートを画面下へ（アイコンのみ、文字なし）

再生 / 停止 / 録音を、最上部のバーから**画面最下部の専用バー**（`#transportbar`、DAW のトランスポートパネル風）へ移した。
- ボタンは**文字なし**の SVG アイコン: 先頭へ ⏮ / 巻き戻し ⏪ / 早送り ⏩ / 停止 ■ / 再生 ▶（再生中は ❚❚ に切り替え、緑）/ 録音 ●（録音中は赤く点滅）。
  意味はツールチップ（`title`）と `aria-label` で伝える。点滅は `prefers-reduced-motion` で止まる。
- 左に時計 2 つ: 小節表示（bar.beat.sixteenth、拍子に追従）と 分:秒.ミリ秒。右は空き（将来テンポ / 拍子など）。
- 巻き戻し / 早送りは小節線単位（Shift で 4 小節）。録音中のシークは今までどおり無効。
- 既存の ID（`play` / `stop` / `rec` / `clock`）は維持したので、キー（Space / Enter）、MCU、MCP は変更なしで動く。
  ボタンの文字を書き換えていた処理（「Pause」「Recording…」）は、クラスと title / aria-label の更新に置き換えた。
- 最上部のバーは `#transport` から `#topbar` に改名（編集ツール、プロジェクト、MIDI、オプション、ステータス）。

---

## 2026-10-09（4）— 「＋ Add Track」パネルと File メニュー

- **File メニュー**（最上部バー左端、`#filemenu`）: New Project（Ctrl+N）/ Open…（Ctrl+O）/ Save（Ctrl+S）/ Save As…（Ctrl+Shift+S）/
  Import（DAWproject, MIDI）/ Export（DAWproject, MIDI）。バラバラに並んでいたプロジェクト系ボタンをここへ集約。
  既存の ID はそのまま（メニュー項目の `<button>` に付け替えただけ）なので MCP / ハンドラは変更なし。
  New Project は `restoreProject` に空のスナップショットを渡す（トラックがあるときだけ確認ダイアログ）。Esc / 外側クリックで閉じる。
- **Add Track パネル**（`ui/add-track.ts`、純粋ロジックは `add-track-model.ts` + テスト）: 旧ウィザード（`#wizard`）を置き換え。
  種類 = Audio（WAV 複数 / デモトーン）/ Instrument（楽器・名前・プリセットまたはパターン・長さ・作成後にエディタを開く）/ Line input（名前・入力・モニター）。
  名前は重複しない既定値（`uniqueName`）。ドラムは 2 小節、ほかは 4 小節が既定。Enter で追加、Esc / 外側クリック / Cancel で閉じる。
- 最上部の `+ Line` / `+ FM` / `+ EarlySynth` / `+ Drums` ボタンは廃止（パネルへ吸収）。`Monitor` は残した。
- `main.ts`: `addFmTrack` に `bars`、新規 `addSynthTrack`。パネルとは `initAddTrack(hooks)` で接続（作成処理はホスト側）。
**確認**: `npm run typecheck` / `npm test`（11 ファイル）OK。実機（MCP）で DOM 検証: 旧ボタンが無い、メニューの開閉と全項目、
パネルの開閉・種類切替・Cancel、Instrument 追加でトラック +1（検証後に元の 24 トラックへ復元）。スクリーンショットはこの端末では
取得不可（"display surface not available"）で、見た目の目視確認は未了。New Project / WAV 選択 / ライン追加の実クリックは未確認。

追記（同日）: File を**ネイティブのメニューバーの最左**にも追加（New / Open / Save / Save As / Import / Export / Quit。`daw:file` で
renderer の既存ハンドラを呼ぶ）。ウィンドウ内の File ボタンは最上部バーの最左へ移動。メニューバー側は main / preload の変更なので
アプリの再起動が必要（未確認）。Cubase の `.cpr` 直接読み込みは後回しのタスクとして記録。

追記（同日）: チャンネルストリップ操作中（チェックボックス / ラジオ / スライダーにフォーカス）の **Space が再生 / 停止に届く**ように修正
（以前は INPUT 一律で素通しだったため、チェックボックスが切り替わっていた）。ダイアログ（Add Track / Options / ピアノロール /
ステップグリッド）の中は従来どおりチェックボックスが優先。keyup 側でも Space の活性化を握りつぶす。キー入力のテストツールが無いため
実キーでの確認はユーザー側。

追記（同日）: **MCP 動作中のロック**（`ui/mcp-guard.ts`）。MCP モードでは右上に `MCP` インジケータが常駐し、ツール呼び出し中は
赤く光って、画面全体にグレー半透明のマスクが掛かる（ポインタ / キーボードを遮断。MCP 自身の操作はプログラムからの `click()` なので影響なし）。
最後の呼び出しの 4 秒後に解除（連続呼び出しでのちらつき防止）。マスクが出ていること（呼び出し直後）は実機で確認。解除側は MCP 経由では
確認できない（問い合わせ自体が再点灯させるため）。

追記（同日）: 最上部バー右端の GPU 表示を**ランプ化**（`#gpu-lamp`: 緑 = WebGPU 稼働、赤 = 失敗 / 描画停止、橙 = 初期化中。詳細はツールチップ。
`#gpu-status` は一時メッセージ専用で、通常は空）。MCP インジケータは右上の固定表示をやめ、**下のトランスポートバー右側の空きスロット**へ移動
（GPU 表示との重なりを解消。ユーザー確認済みの位置）。

追記（同日）: MCP インジケータを GPU と同じ**ランプ形式**（● + `MCP`）に。MCP モードでは常時表示、呼び出し中は赤く点灯（脈動）、待機中は暗く消灯。

追記（同日）: MCP ランプは **MCP 無効（`npm run dev` など）でも消灯のまま常時表示**（`ensureMcpLamp()` を起動時に呼ぶ）。有効時のみ呼び出し中に点灯。

追記（同日）: MCP ランプの置き場を**最上部バーの GPU ランプの左隣**に変更（下バー右は空きに戻した）。通常の並びなので重ならない。

追記（同日）: 最上部バーの並びを変更。一時メッセージ（`#gpu-status`）をスペーサーの**左側**（メトリクスの隣）へ、右端は `MCP` / `GPU` ランプ → **Options ボタンを最右**に固定。
メッセージの出入りで Options やランプが動かなくなった（メッセージはスペーサーの余白に伸びるだけ）。

追記（同日）: **MCP 操作ログ窓**（`ui/mcp-guard.ts`）。MCP が動いている間、画面下中央にログが出る（マスクと同じタイミングで出入り）。
1 行 = 状態（▶ 実行中 / ✓ / ✗）・ツール名・引数の要約・所要時間。直近 14 行。エラーは理由を表示。
renderer で処理するツールだけが対象（main 側の `project_save_file` / `screenshot` / `logs` などは出ない）。

追記（同日）: **MCP チャット**。ログ窓（`#mcp-log`）に会話欄と入力欄を追加。Claude 側は新しい MCP ツール `chat_say`（窓に書く）と
`chat_read`（人が打った行を受け取る。`waitSeconds` ≤ 50 で待てる）で読み書きする。マスクが出ている間も入力欄だけは打てる。
ログ窓は **MCP が一度動いたら開いたまま**（マスクだけが 4 秒後に消える）。× か MCP ランプのクリックで閉じる / 開く。
`mcp.ts` を変更したので反映にはアプリの再起動が必要。チャットは Claude が `chat_read` を呼んだときだけ届く（押し込み通知はない）。

追記（同日）: **AI ボタン**をトランスポートバーの右寄り（画面幅の約 78%、右 3 分の 1 の中央）に追加。ログ / チャット窓の開閉を単独で行う
（MCP ランプのクリックも同じ）。MCP 無効時は薄く表示（押しても何も起きない）。MCP がファンクションを動かすとマスクは掛かるが、窓（チャット欄）は
開いたまま残る。マスクは **110 ms の高速フェード**（`prefers-reduced-motion` ではフェードなし）。窓の見出しの×が効かなかった不具合
（初期化時の `head.textContent` が子要素を消していた）を修正。

**方針メモ（2026-10-09）**: 将来は **AI 自体をアプリに組み込む**（ユーザー談）。いまの MCP ログ / チャット窓・マスク・AI ボタンはその入口で、
当面は外部の Claude Code が MCP 経由でその役を担う。組み込み時はチャット欄と操作ログをそのまま使える形にしておく（ツール呼び出し = 操作、
`chat_say` / `chat_read` = 会話）。

追記（同日）: **MCP が触ったトラックを光らせる**。`track` / `owner` を指定するツール（`track_set` / `strip_set` / `insert_*` など）の完了後、
そのトラックのレーン行とチャンネルストリップに赤い枠が 0.75 秒ぴかっと光る（`master_set` と `owner:'master'` はマスターストリップ）。
マスクの上（z-index 2001）に重ねるので暗いマスク越しでも見える。画面外のトラックは光らない。

追記（同日）: MCP が触ったトラックの光る枠と AI パネルの外枠を**暗めの青**（#2f6fd0）に変更（区切り線も青系）。ランプと見出しの文字は赤のまま。

追記（同日）: AI パネル / 光る枠の見た目調整 — 枠線は少し落ち着いた青（#2a5a9e）、グロー（にじみ）と塗りは少し明るく。パネル内の文字は白（Claude Code 風）、
✓ / ✗ / ▶ の記号だけ色付き。ログ欄は初期表示から 10 行分の高さを確保（行が増えても 14 行まで）。

追記（同日）: AI パネルの送信ボタンを赤から青系（#1b2740 / 枠 #2a5a9e）へ。入力欄はアクティブ（フォーカス）時の枠を暗めのオレンジ（#b8731f）に。

追記（同日）: AI ボタンの左に **MCP サーバの接続 URL**（`http://127.0.0.1:7777/mcp`）を表示（クリックでコピー）。MCP 無効時は出ない。
main の IPC `daw:mcp:url` + preload `mcpUrl()` を追加。

## 2026-10-09（5）— AI フルミックスの試験（MCP 経由、24 トラックのバンド曲）

MCP だけで 24 トラックをミックス。流れ: ① 全トラックを 1 本ずつソロ → `bounce` でゲート済み LUFS を測る → ② 役割ごとの目標ラウドネスから
フェーダーを算出（-20..+12 dB）③ パン（ギターとダブルを左右へ）④ ストリップの HPF と EQ（低域の濁り整理・ボーカルの存在感）
⑤ インサート（スネア / クラップ / ボーカル / コーラスに薄いリバーブ、ベルにピンポンディレイ 375 ms）⑥ マスターフェーダー -6 dB、
マキシマイザー天井 -1.0 dB。コンプとドライブは元のまま。
**結果**: 統合 -13.9 LUFS / 最大短期 -12.9 / ピーク -1.00 dB / クリップ 0（元は -12.7 / -10.6 / -0.49）。保存: `mix_ai_v1.awaker.json`
（スクラッチパッド）。耳での評価は未了（AI は数値でしか判断できない）。
**MCP の使い勝手の所見**: トラック指定の操作は全て出来た。ログ窓 + チャットで人と往復できた。足りない操作: 聴感の確認手段、クリップ単位のゲイン /
フェード、オートメーション、トラック間のルーティング（センド）は MCP に無い。

### AI マスタリング（同日、ミックスの続き）
流れ: ① マスター処理（eq5 / buscomp / maximizer）を全部バイパスして `bounce save:true` → 保存された WAV を numpy で分析（1/3 オクターブの
平均スペクトルを「ピンクっぽい基準」と比較、M/S、L/R 相関）。素のミックスは相関 0.92、サイド -13.9 dB（広がりは控えめ）、
100〜160 Hz が約 -6 dB（胴が薄い）、30 Hz 台が相対的に強い、700〜800 Hz が +2〜3 dB（箱鳴り）、4 kHz が +2 dB（硬め）。
② eq5: 120 Hz +3 / 710 Hz -2 / 4 kHz -2.5 / 32 Hz -3 / 10 kHz -1。③ buscomp: thresh -16 / 2.5:1 / attack 30 ms / release 200 ms /
makeup 1.5 / drive 0.2。④ maximizer: gain +7.9 dB / 天井 -1.0 dB / release 150 ms。
**結果**: 統合 -13.89 LUFS / 最大短期 -12.78 / ピーク -1.00 dB / クリップ 0（マスタリング前の素のミックスは -22.8 LUFS）。
保存: `mix_ai_v1_mastered.awaker.json`（スクラッチパッド）。耳での評価はユーザーが「ミックスは良い方向」と回答済み、マスタリングの評価は未了。
**ハマりどころ**: `index.html` を編集すると renderer が丸ごと再読み込みされ、アプリは保存済みの自動ロード用ファイルへ戻る。
MCP で作業中の状態が消えるので、**作業中に renderer のソースを触るときは先に `project_save_file` で退避**すること。

## 2026-10-09（6）— リバーブとディレイを GPU 並列化（音は変えずに 65 倍速）

**きっかけ**: AI ミックスを入れたら再生がぶつぶつ切れた（アンダーラン毎秒約 8000 フレーム、バッファが 0〜320 ms で揺れる）。VRAM ではなく処理速度。
機能を 1 つずつ外して書き出し時間を測ると、トラックのインサート 7 個（リバーブ 6 + ディレイ 1）だけで 34.5 秒の曲に 26 秒かかっていた
（リバーブ 1 個 ≈ 3.7 秒）。原因は、GPU の**1 スレッド（チャンネルごと）が全サンプルを直列に計算**していたこと（RTX 3060 Ti の力は足りていた）。

**やったこと**（音質は落とさない。方針: 「性能を落とす気はない」）:
- **リバーブ**（`REVERB_COMB_WGSL` + `REVERB_AP_WGSL`、`gpu/effects/reverb.ts`）: 長さ D のコムは「D サンプル前に書いた値を読む」ので、D サンプルの
  塊の中は互いに独立（読むのは古い値、書き先は別スロット）。塊どうしだけ直列（約 14 段、バリア区切り）。コム内のダンピング用 1 次ローパスは
  `damp1 ≤ 0.4` なので、インパルス応答が 24 タップで 1e-9 未満になり、**24 タップ FIR + 前の塊からの持ち越し**で再帰と float32 精度で等価。
  オールパス 4 段も同じ塊分割。コム 16 ワークグループ（チャンネル × コム）+ オールパス 2 ワークグループ（256 スレッド）の 2 パス。作業用の
  scratch バッファ（18 × blockFrames）はインサートごと。
- **ディレイ**（`DELAY_WGSL`、`gpu/effects/delay.ts`）: 遅延 D サンプルの塊（`min(D, リング長 − D)`）が独立。フィードバックのローパス
  （`lp += damp·(d − lp)`）は 1 次の線形再帰なので、**256 スレッドの区間スキャン**（区間内を 0 から走査 → 256 区間の持ち越しを直列 → 補正）で厳密に解く。
  ピンポンは両チャンネルのスキャンを先に終えてから書く。256 サンプル未満の短い遅延は旧版（`DELAY_SERIAL_WGSL`）のまま。
- **テスト**: `tests/gpu-chunking.test.ts`（Node、倍精度）で「塊分割 = 直列」を固定（リバーブ 4 通り・ディレイ 5 通り、差 1e-11 以下。damp=1 の最悪でも 9e-12）。

**検証（実機・MCP の bounce、倍精度の CPU 直列版を基準に）**:
- リバーブ単体（合成信号）: 新 127 dB / 旧 128.7 dB SNR。実曲の 19 番トラック: 新 143.9 dB / 旧 143.9 dB（最大誤差 1.8e-8）。
- ディレイ（18 番、ピンポン + ダンピング）: 旧と新が 161 dB SNR（最大誤差 3.7e-9）。
- **速度**: インサート 7 個の分 26 秒 → 約 0.4 秒。曲全体の書き出し 35.5 秒 → 7.9 秒（実時間の **4.4 倍**）。再生 16 秒でアンダーラン 0、バッファ 200〜500 ms。
- 残りの内訳（34.5 秒の曲、全体 7.9 秒）: マスターチェーン 3.4 秒（eq5 / buscomp / maximizer も 2 スレッド直列）、ストリップのドライブ 1.9 秒、
  EQ・コンプ 約 0.5 秒、その他 0.5 秒。**次の候補**: マスターチェーンとストリップのドライブの並列化。

**ハマりどころ（重要）**:
- **同じプロジェクトでも、読み込みのたびに書き出しが約 -50 dB 違う**。ストリップのサチュレーションに「インスタンスごとの個体差の乱数」を埋め込んである設計のため
  （読み込み / インスタンス生成ごとに変わる。インサートを外した書き出しでも差が出ることで確認）。**数値の回帰比較は同じ読み込みの中で行う**こと
  （同じロード内なら 2 回の書き出しは完全に一致）。ロードをまたぐ比較は、個体差を切った状態（ストリップのバイパス）か、対象を絞った単体検証で。
- renderer のソースや `index.html` を触ると HMR で画面が再読み込みされ、保存済みの自動ロード用ファイルへ戻る。MCP 作業中の状態は先に `project_save_file` で退避。
- MCP の `bounce` は `save:true` で WAV を保存し、パスは結果の `wav`（`%APPDATA%\awaker\recordings\`）。外部の numpy で解析できる。

### 引き継ぎ — 次セッション: 処理負荷のチューニング（2026-10-09 夜）
ユーザー判断: **4.4 倍速では余裕が全然足りない**。「今のレベルの負荷（24 トラック + インサート + マスタリング）を圧倒的に余裕で処理できないと本格利用は厳しい」。
目標の目安: この曲で実時間の **20 倍以上**、最終的に **100 トラック**で余裕（CLAUDE.md の VRAM 上限の話とも接続）。
**測り方**: アプリを `npm run dev:mcp` で起動してプロジェクトを読み込み、`python scripts/mcp_perf_breakdown.py`（機能を 1 つずつ外して `bounce` の `renderMs` を測る。
最後に元のプロジェクトを自動で読み戻す）。結果の例（34.5 秒、24 トラック、RTX 3060 Ti）: 全体 7.9 秒 / マスターチェーン抜き 4.5 / ドライブ 0 で 1.8 / ストリップ全バイパス 0.46 秒（床）。
**内訳と候補（効く順）**:
1. **マスターチェーン 約 3.4 秒**（`eq5` 5 バイクアッド + `buscomp` + `maximizer`）。どれも 2 スレッド（L/R）が全サンプルを直列に回す作り。バイクアッドは
   2 次の線形再帰なので**2×2 行列の区間スキャン**で厳密に並列化できる（ディレイのローパスと同じ手筋）。コンプ / マキシマイザーは非線形のエンベロープ追従
   （アタック / リリースの 1 次再帰 + max）。段ごとに「検波（並列）→ 包絡（スキャンまたは短い直列）→ ゲイン適用（並列）」へ分けられるか検討。
2. **ストリップのドライブ 約 1.9 秒**（24 トラック分、サチュレーション）。トラックごとの直列部分を洗い出す。
3. **ディスパッチ数 / バッチ化**: トラックごと・段ごとに別ディスパッチ。同種の処理（全トラックの EQ、全トラックのコンプ…）を 1 ディスパッチにまとめ、
   ワークグループ = トラック × チャンネルにすれば GPU の並列度が上がり、ディスパッチ回数も減る（100 トラックへの布石）。
4. **計測の精度**: WebGPU の `timestamp-query` でパス別の GPU 時間を出す（今は CPU 側のウォールタイムのみ）。どこが本当に遅いかを先に確定してから手を入れる。
**守ること**: 音は変えない（倍精度の CPU 直列版を基準に SNR 120 dB 以上、`tests/gpu-chunking.test.ts` と同じ作法で数式のテストも足す）。
個体差の乱数（ストリップのサチュレーション）があるので**ロードをまたぐ数値比較は不可**（`gpudaw-bounce-nondeterminism` 参照）。同一ロード内、またはインサート単体を CPU 基準と照合する。

## 2026-10-09（7）— 処理負荷チューニング: 24 トラックの AI ミックスを実時間の 4.8 倍 → 20 倍へ

**きっかけ**: AI ミックスで音切れ（前節の続き）。目標は 24 トラック + インサート + マスタリングで実時間の **20 倍以上**、最終的に 100 トラック。
**結果**: 書き出し 7.1 秒 → **1.7 秒（実時間の 20.3 倍）**。24 トラックを 4 倍に複製した **96 トラックでも 2.0 秒（17 倍）**（トラック数に対してほぼ平坦）。
実機（ASIO / Zen Go）で 16 秒再生: アンダーラン 0、バッファ 220〜540 ms で安定。

**方針（全部に共通）**: GPU の遅さの正体は「1 スレッドが全サンプルを直列に回す」ことだった（RTX 3060 Ti の力は余っている）。
再帰フィルタは線形なので**時間方向に分割して並列に解ける**。本当に直列なのは状態依存のエンベロープ追従（ドライブのフィードバック・コンプなど）だけ。
- **線形再帰（1 次ローパス / バイクアッド）= チャンク走査**: 256 スレッド（1 ワークグループ）が各 blockFrames/256 サンプルの塊を持つ。
  ① 塊をゼロ状態から走らせて終端状態 E ② 1 スレッドが塊→塊へ状態を持ち越す S' = E + M·S（1 次なら M = (1−a)^C ※厳密）③ 真の状態から本走査。
  **バイクアッドはさらに parareal 補正**が要る（下記ハマりどころ）: ③で得た終端 F を使って持ち越しを S_new' = F(S_old) + M(S_new − S_old) に直し、もう一度本走査。
  M は 2×2 行列の塊分遷移。**(値, 傾き) 座標**で持つ（低域の極では素の (y1,y2) 基底が 100:1 で打ち消し合って float32 精度を失う）。
- **非線形の 1 次フォロワー（エンベロープ）= 軽い直列 + 並列**: 直列部分は register 演算だけのループにして、**256 サンプルずつ共有メモリに積んで**スレッド 0 が回す
  （グローバルメモリ往復をサンプルごとにやると遅延待ちで台無し。マキシマイザーで実測: 往復ありだと 0.07 秒しか縮まず、タイル化で 0.42 秒）。
  それ以外（log/pow のゲイン計算、ゲイン適用、ルックアヘッド遅延）はサンプル並列。
- 変更箇所とコスト（24 トラックの曲 34.5 秒、書き出し）:
  | 部位 | 前 | 後 | 方式 |
  | --- | --- | --- | --- |
  | マスター eq5 | 1.46 s | 0.12 s | バイクアッド 5 段をチャンク走査 + parareal（`EQ5_WGSL`、`chunkTransition` は eq5.ts） |
  | マスター buscomp | 1.1 s | 0.21 s | 検波エンベロープ（直列・タイル）+ ゲイン計算（並列）+ ブライトドライブ（強調 / DC の 1 次 + ハイシェルフをチャンク走査） |
  | マスター maximizer | 0.55 s | 0.10 s | ゲイン包絡だけ直列（タイル）、入力ゲイン / 遅延 / クランプ / リング更新は並列（ビット一致） |
  | ストリップ（ドライブ / カラー / アロパス / HPF / EQ） | ≈2.8 s | ≈0.4 s | (トラック×チャンネル)ごとのワークグループ。ドライブ: `driveA`（強調 + tanh、並列）→ `driveB`（フィードバック・コンプだけ直列・タイル）→ `tailC`。カラー: `preA`（1 次ローパス 4 段）→ `tailC`。`tailC` = ソフトトップ + アロパス + HPF + EQ 4 段 |
  | ストリップのコンプ | 0.6 s | 0.16 s | `compEnv` / `compGain`（直列・タイル、トラックごとのワークグループ）+ `compTg` / `compApply`（並列、bit 一致） |
  旧 `mainChain`（トラックごと 1 スレッドで全部直列）は廃止。
- 残りの内訳（1.7 秒）: 床 0.43（クリップ gather / mixAdd / 読み戻し。ブロックごとのコマンド数と mapAsync 同期）、ストリップ ≈ 0.55、マスター ≈ 0.48、インサート 0.02。

**検証の作法**（音は変えない）:
- **ビット一致を狙える変更**（マキシマイザー、コンプ、分割だけの変更）: ストリップの個体差乱数を一時的に定数へ固定（`Math.random()` → 0.37）して、旧実装（`git checkout HEAD -- <files>`）と
  新実装で `bounce save:true` → WAV を numpy で比較。誤差 0 を確認。**固定は必ず元に戻してコミット**（`channel-strip.ts` の `vary` ブロック。差分に 0.37 が出たら戻し忘れ）。
- **走査で丸めが変わる変更**（eq5 / buscomp / ストリップ）: 同じ旧実装との SNR + **倍精度の基準との SNR**。基準: eq5 は scipy の `lfilter`（`scripts/` ではなくワンオフ）、
  ストリップは `scripts/mcp_strip_accuracy.py`（合成信号 1 トラックのプロジェクトを作り、ドライブ / カラー（+ HPF）の倍精度の直列版と比較。乱数固定が前提）。
  結果: ドライブ 110 dB、カラー 109 dB（HPF なし。GPU の tanh / pow の精度が天井）。バスコンプは旧実装との SNR 132.6 dB。
- **オーディオ上の限界（旧実装と共通）**: 30〜40 Hz の HPF や 32 Hz のローシェルフは **float32 のバイクアッド自体が 56〜68 dB 止まり**（旧の直列実装も同じ。倍精度基準で 63.3 dB 対 新 63.7 dB）。
  実プロジェクトの旧 / 新比較が 74〜75 dB なのは、ホットなドライブ素材が丸め誤差を増幅するためで、旧実装も同じだけ基準から外れている（トリム 1e-4 dB の摂動で 73.6 dB まで落ちる）。
  この領域をさらに詰めるなら、バイクアッドをバランスの良い形（例: 状態空間 / 低域だけ倍精度風の補償）にする必要がある。→ 次の候補。

**ハマりどころ（重要）**:
- **WGSL の `workgroupBarrier` は一様な制御フローでないと不可**。ストレージから読んだ値で分岐して早期 return すると「must only be called from uniform control flow」でパイプラインが死に、
  ストリップが無音になる（`running dry` ログ）。→ 先頭でスレッド 0 が共有変数に flags を書き `workgroupUniformLoad(&v)` で全員に配る（`trackFlags()`）。ループ条件も一様に。
- **parareal が必要な理由**: 低域の極（32 Hz@96k など）では塊分遷移 M の成分が約 ±100 で、(y1,y2) 座標だと 100×100 の打ち消しで float32 精度が落ちる（SNR 36 dB）。
  (値, 傾き) 座標 + 1 回の補正で旧直列実装以上（65.2 dB 対 64.7 dB）。ゼロ状態の塊出力自体が大きくなる（≈1、真値 0.03）ので「補正を足す」方式は丸めで負ける → **真の状態からの再走査**が正解。
- 数値比較は**同じ読み込み内**でしか意味がない（乱数、`gpudaw-bounce-nondeterminism`）。比較スクリプトは HMR のたびに読み込み直るので、`git checkout` / ファイル復元後に `sleep` を入れて待つ。
- `renderMs` はブロックごとの mapAsync 同期を含む壁時計。ブロック数が多いと床が効く。
- dev サーバーを `npm run dev:mcp` で起動したまま、別の Electron が増えて MCP ポートが取り合いになることがある（`EADDRINUSE`）。余分な Electron は終了させる。

### 引き継ぎ — 次の候補（1.7 秒 / 20 倍 → 余裕をさらに）
1. **床 0.43 秒**: ブロックごとのコマンド（クリップ gather × クリップ数、トラックごとの copy + mixAdd のコンピュートパス、mapAsync 同期）。
   同種の処理を 1 ディスパッチへ（gather をトラック横断で 1 回、mixAdd をトラック横断のリダクション 1 回）、読み戻しのパイプライン化（2 ブロック先行）。100 トラックで床が伸びる。
2. **ドライブのフィードバック・コンプ（`driveB`）**: 唯一の直列。サンプルあたりの遅延は除算 3 回 + pow（log2/exp2）が支配。`1/dThr` を事前計算して乗算に、`exp2(k*log2(over))` を直書き、
   `grit * dMakeup` を `driveA` で掛けておく、など依存鎖の短縮（結果は丸め 1 ulp 違い、フィードバックが増幅するので聴感は不変でも bit 一致は崩れる）。
3. **バイクアッドの精度**（上記）。30〜40 Hz の HPF / 低域シェルフで 56〜68 dB。
4. `timestamp-query` でパス別の GPU 時間（今は「スキップして差を取る」実験で切り分けた。`DBG_SKIP` 的な一時フラグ）。
5. **100 トラックの実機再生確認**（今回は書き出しだけ 96 トラックで確認）。

## 2026-10-10 — AI 接続: アプリ内で独立した AI エージェントを起動できる（Options → AI で接続先を選ぶ）

**AI ボタンとチャット窓は従来のまま**（見た目・操作とも変更なし。入力欄のプレースホルダだけ「AI へのメッセージ」）。変えたのは「誰が答えるか」と、その設定（**Options → AI**）だけ。

| 接続先 | 動き | 要るもの |
| --- | --- | --- |
| Claude Code（アプリ内で起動）**既定** | アプリが本人の `claude`（Claude Code）を `-p` で子プロセス起動。専用の MCP（ランダムポート + トークン）でアプリのツールを渡す。会話は `--resume` で継続 | `claude` の場所（自動検出: PATH → `~/.local/bin` → VS Code 拡張の同梱バイナリ。パス指定も可）。ログインは本人のもの |
| Claude Code（外部から MCP 接続） | 従来どおり。本人が起動した Claude Code が `chat_read` で読む | `npm run dev:mcp` |
| Ollama | `http://localhost:11434/v1`（URL 空欄の既定） | モデル名（ツール呼び出し対応のもの） |
| Gemini | Google の OpenAI 互換エンドポイント（URL 空欄の既定） | API キー、モデル名 |
| OpenAI 互換（その他・自前） | LM Studio / llama.cpp / vLLM / OpenRouter / 自前など | URL、モデル名、必要ならキー |

**アカウントを組み込まないための決まり（崩さない）**
- 設定（接続先・URL・モデル・claude のパス）は普通の Options（`awaker-options.json`、秘密なし）。**API キーだけ Options に入れない**: OS の鍵保管
  （Electron `safeStorage`）で暗号化して `awaker-ai-key-<接続先>.bin`（接続先ごとに別）へ。暗号化できない環境では保存しない（環境変数 `AWAKER_AI_API_KEY`）。
  キーは renderer へ返さない（`aiGet` は `none | saved | env` だけ）。エラー文はキーを伏せ字にする。
- 既定の URL は公開の宛先（Ollama の localhost / Google の公開エンドポイント）だけ。キー・アカウント・個人情報は一切持たない。
- 平文 http は localhost / LAN / `*.local` のみ。インターネット側は https 必須（キーが平文で流れるため）。
- 組み込みエージェントに渡すツールから、パスを取るもの・screenshot・logs・app_reload・chat_* を除外（`ai-core.ts` の `AI_BLOCKED_TOOLS`）。
  claude-app は `--tools ""`（内蔵ツール全部オフ）+ `--allowedTools mcp__awaker` + 禁止ツールを `--disallowedTools`、作業フォルダは userData/agent（リポジトリの CLAUDE.md を読ませない）。
  専用 MCP の設定ファイル（トークン入り）は 1 ターンごとに作って消す。
- OpenAI 互換へ送られるもの: 会話の文面とツールの結果。音声データは送らない（Options の画面に明記）。

**ツール定義の互換**: Gemini などは完全な JSON Schema を受けないので、`additionalProperties` を落とし、`anyOf`（`owner` = 数値 | 'master'）は 1 つの型へ畳んで、
戻りで数値文字列を数値へ戻す（`simplifySchema` / `coerceToolArgs`）。

**構成**: `main/ai-core.ts`（純粋: 設定検証 / プリセット / 接続先チェック / スキーマ簡略化 / claude の引数と出力パーサ / エージェントループ。`tests/ai-core.test.ts`）·
`main/ai.ts`（鍵保管・claude 起動・fetch・IPC）· `main/mcp.ts`（`startPrivateMcp`: トークン付き専用サーバー）· `ui/ai-options.ts`（Options の AI 節: 接続先 / パス / モデル / URL、
キー入力、検出結果、実行中の AI を中断、会話リセット）· `ui/mcp-guard.ts`（チャットの宛先を Options の設定で振り分けるだけ）。
**テスト用 MCP**: `chat_type`（人がチャットに打つのと同じ）と `chat_history`（直近の会話）。**私（Claude Code）とアプリ内 AI は、この 2 つで会話できる**。
Options の `text` フィールド型を追加（`options-model.ts`）。**options ファイルの UTF-8 BOM を許容**（PowerShell で書いたファイルが「読めない」扱いになっていた）。

**検証**: ① claude-app: 実機で起動 → `tracks_list` をツールで呼び「24 本」と回答 → 次の発話で `--resume` により「24 本です」（会話継続）。専用 MCP の設定ファイルは実行後に消える。
② OpenAI 互換: 偽サーバー（localhost）でツール呼び出し → 結果返送 → 回答。禁止ツールは `tool not available`。環境変数のキーが `Bearer` で届き、どのファイルにも書かれない。
http の公開ホストは送信前に拒否。③ `safeStorage` はこの PC（Windows / DPAPI）で往復し、暗号化後に平文は見えない。
**未確認**: 実在の Gemini / Ollama / 他社サービスとの接続（Ollama はこの PC で未起動、Gemini はキー無し。偽サーバーのみ）。Options 画面からのキー保存の UI 操作
（入力欄を MCP から操作できないため。保存処理は main 側で往復確認）。

**スキル**: `.claude/skills/awaker/SKILL.md`（Awaker の操作・デバッグ・人間 / アプリ内 AI との対話の手順）。

### Ollama で使うモデルの選び方（RTX 3060 Ti 8 GB / RAM 16 GB、2026-10-10 実測）
- **VRAM の取り合い**: Awaker（24 トラック・96 kHz）が約 1.6 GB。空きは約 6.4 GB。7B の q4_K_M（4.7 GB）+ KV で全体 6.5 GB 使用 → 収まる。
  q5_K_M（5.4 GB）/ q6_K（6.3 GB）はほぼ余裕なし。**30B（qwen3:30b-a3b = 18.6 GB）は RAM 16 GB（空き約 1 GB）に載らない**。
- **ツール呼び出し対応が必須**: `ollama show` の capabilities に `tools` があるもの。`qwen2.5:3b` / `my-qwen:3b` は `completion` のみ → エージェントに使えない。
- **実測**: `qwen2.5-coder:7b-instruct-q4_K_M` は正しいツール（tracks_list）を選ぶが、**構造化せず JSON をテキストで返す** → `extractTextToolCalls`（ai-core）で
  ` ```json ` / `<tool_call>` / 生 JSON を拾う（既知のツール名だけ受理）。初回 10 秒（ロード込み）。ツール定義 26 個で約 2800 トークン → コンテキストは 8192 以上に。
- **`qwen7b-cline`** はこの環境で KV キャッシュ確保に失敗して Ollama ごと落ちた（cudaMalloc OOM）。使わない。
- ツール結果は Ollama のとき 6000 文字に切る（小さいコンテキスト対策）。
- **注意**: LLM の推論は GPU を使う。再生 / 書き出しと同時に動かすと音切れの原因になりうる（Awaker は 20 倍速で余裕はあるが、未計測）。

### 更新（2026-10-10 夜）— Ollama（Docker 内）/ Gemini の整理、接続先ごとの設定
- **Ollama は Docker の `ollama-webui`（open-webui:ollama）コンテナ内**。ポート 11434 を公開、GPU 全割り当て。`docker` CLI はこの端末から直接使える
  （`docker ps` / `docker logs ollama-webui` / `docker exec ollama-webui ollama pull …`）。MCP は不要。
- **全層を GPU に載せる読み込みが OOM になる**（空き 6.3 GB でも 7B q4 = 約 4.9 GB が `cudaMalloc failed`。WSL2 経由の制約とみられる）。
  `num_gpu` を指定した部分オフロードなら動く（20/29 層で 11 秒）。→ OOM（500 + cudaMalloc / unable to allocate）のとき、GPU 層数を 24 → 16 → 8 → 0 と
  減らして自動で再試行し、効いた層数をセッション中覚える（`OLLAMA_GPU_LAYER_STEPS`）。
- **Ollama はネイティブ API（`/api/chat`）で呼ぶ**: OpenAI 互換の口では `num_ctx` を指定できず、モデル既定の長いコンテキストが VRAM に載らない。
  `options.num_ctx`（Options の「コンテキスト長」、既定 8192）を付ける。ツールは `tools`、結果は `tool_name` 付きの `tool` ロール。
- **ツール非対応モデル**（`does not support tools` の 400）は、ツール一覧を system プロンプトに圧縮して入れ、JSON 1 個で答えさせるモードへ自動で切替（`toPlainChat`）。
  ただし **3B（my-qwen:3b / qwen2.5:3b）は指示に従えず実用にならなかった**（「トラック」を運送のトラックと解釈して回答）。
- **推奨: `qwen3:4b`**（2.5 GB、Q4_K_M、capabilities = completion / tools / thinking）。実機で、トラック数の取得とフェーダー設定（-3 dB、`tracks_list` で確認）を完遂。
  全 37 層が GPU に載る。初回 38 秒（ロード 16 秒込み）、2 回目 74 秒（thinking が長い）。→ 次の改善候補: thinking を切る設定（`think: false`）。
- **接続先ごとに URL / モデルを別項目に分離**（`ollamaUrl` / `ollamaModel` / `geminiModel` / `openaiUrl` / `openaiModel`）。切り替えてもモデル名を引きずらない。
  Gemini の既定モデル名は `gemini-3.5-flash-lite`（2.5 は廃止。ID は Options で変更できる。実 API での ID 確認は未）。**Gemini は実キーでの接続を未確認**。
- **Options の AI 節**: 枠（高さ固定）の中に項目を入れ、接続先に応じて不要な項目を非表示（`showWhen` / `box` を Options の機能として追加）。
  Ollama ではインストール済みモデルを一覧し、クリックで入力。**チャット窓の見出しの右側に「サービス · モデル名」を表示**。
- 検証: 偽サーバー（OpenAI 互換）/ 実機 Ollama（qwen3:4b）/ claude-app。`tests/ai-options.test.ts`（接続先ごとの値の解決・表示項目・ラベル）、ai-core の追加テスト。

### 方針（2026-10-10 決定）— どの AI をいつ使うか
- **普段使い: Gemini（`gemini-3.5-flash-lite`）**。クラウドなので GPU / VRAM を使わず、Awaker と同居しても音切れの心配がない。ツール呼び出しも実機で通った
  （思考署名の保持が必要だった。コミット d283a4c）。
- **Claude Code（アプリ内起動 / 外部 MCP）**: 本人のサブスクリプション。デバッグ・大きな作業向け。
- **Ollama は割り切り**: Awaker と同じ GPU（RTX 3060 Ti 8 GB）での同時利用は前提にしない。使うなら、GPU に余裕のある環境か別マシンの Ollama
  （Options の URL で指定）。この PC では `qwen3:4b` が動くが、推論が GPU を使うので再生中の音切れの懸念があり未計測。

### 操作ログと「実際に変わった設定」（2026-10-10）— AI が「やった」と言うことを信用しない
AI（特に小型モデル）は、やっていないことを「やりました」と言う。そこで、**アプリが自分で測った結果**を出す。
- **差分の計測**（`ai-core.ts` の `diffProject`）: 質問 1 件の前後で `project_get` を取り、変わった項目だけを一覧にしてチャットに出す
  （`tracks[01_KickIn].mix.gainDb: 0 → -2`。`view` / playhead は除外。トラックは `id` → `title` / `name` で突き合わせるので、途中のトラックを消しても連鎖しない。上限 200 件）。
  文面は「【実際に変わった設定】（アプリが計測。AI の説明ではありません）」で、変更が無ければ「変更なし」と明示。ツール実行回数と失敗回数も出る。
- **ツール実行の記録**（`mcp.ts` の `callTool` に `setToolHook`）: 全ての呼び出しが通る 1 か所なので、**どの AI・どの接続先でも**（外部 Claude Code も）漏れなく記録される。
- **ログ**（`ai-log.ts` の `RotatingLog`）: `%APPDATA%\awaker\logs\ai-ops.log`（JSON Lines）。1 MB を超えると `.1` → `.2` … と世代交代、5 世代で古いものを削除（ディスク使用は約 6 MB まで）。
  種類は `tool`（1 呼び出し 1 行。参照のみの成功は書かない）と `turn`（質問 1 件 = 依頼文・使ったツール・計測された変更・AI の返答）。書き込み失敗でアプリは止まらない。
- **振り返り**: MCP ツール `ops_log { kind: all | tool | turn, limit }`。アプリ内 AI も外部の Claude Code も同じに読める（ローテーションをまたいで読み返す）。
- 検証: `tests/ai-log.test.ts`（差分 9 種、ローテーション・読み返し・壊れた行・並行追記）。実機（Gemini）で「1番を -2 dB に」→ 計測 `0 → -2`、ログに turn / tool が残り、`ops_log` で読めた。
- **注意**: ログには依頼文とツール引数が入る（API キーは入らない）。ローカルの userData のみ。

### ミキサーのチャンネル表示（Cubase 式）— 2026-10-10
- **左の数値 = フェーダー値**（停止中も再生中も。MCP / AI が動かしても即時。一番下は −∞、上げたら +）。`ui/fader-text.ts` の `fmtFaderDb`。
- **右の数値 = ピーク**（クリックでリセット、0 dB 超えで赤）と**縦の棒 = レベル**は、**実際のチャンネル出力**を GPU で測った値になった。
  以前は「音源の 20 ms 包絡線 × フェーダー」の見積もりで、ストリップ（ドライブ / EQ / コンプ）・インサート・パンが入っていなかった。
- 仕組み: `MIXADD_WGSL` が、フェーダーとパンを掛けた後（マスターゲイン前）の |L|, |R| の最大値をワークグループで縮約し、`atomicMax`（非負 f32 はビット順 = 大小順なので u32 で代用）で
  トラックごとの枠 `peaks` に集める。ブロックの読み戻しと同じ submit で読み出し（`master-bus.ts` の `trackPeaks`）、スケジューラが「クリップのあるレーンだけ描画される」対応を
  レーン順に直して `metrics().trackPeaks` で渡す。**遅延はマスターのメーターと同じ**（先読みバッファぶん。0.2〜0.5 秒）。NaN は 1e6（赤）として表示。
- 検証: Bass だけをソロ + マスターのインサートをバイパスで、チャンネルのピーク -13.6 dB、マスターのピーク -23.6 dB（= -13.6 + マスターフェーダー -10 dB）で一致。
- 注意: 「見積もり」の `laneMeterLevel` は廃止（`ENV_WINDOW_S` は波形描画で使うので残る）。

### インタラクティブな依頼（波・スイープ）をアプリ内 AI にやらせる — 2026-10-10
**方針**: 専用の「アニメーション用ツール」は**足さない**。アプリ内 AI が通常のツールだけで、自分で段取りする（その能力を AI の側に持たせる）。
- **手順書**（`ai-core.ts` の `ANIMATION_GUIDE`。全接続先のシステムプロンプトに入る）: 空間的な波（トラックごとに位相をずらす）は 1 回設定すれば波に見える。
  時間で動かす依頼なら 1 フレーム = 1 メッセージ内の複数ツール呼び出し（全トラック分）→ `wait`（200〜600 ms）→ 次のフレーム、10〜20 フレーム。式 `mid + amp*sin(2π(track/N + frame/F))`。
  「フルスイング」= 制御の全範囲（フェーダー -60〜+6 dB → mid = -27 / amp = 33、パン -1〜+1）。送る前に最小・最大を確かめ、実際の値を言う。動かした後は元の値へ戻す。確認せずに「できた」と言わない。
- **ステップ数の上限**を設定化（Options → AI「最大ステップ数」、既定 40、4〜200。API 系の接続先）。1 フレーム = 1 ステップ。以前は固定 12 で、アニメーションには足りなかった。
- **古いツール結果の圧縮**（`compactOldToolResults`）: 直近 3 ラウンド以外のツール結果は 160 文字に縮める（20 フレーム × 24 呼び出しでもコンテキストが溢れない）。
- **計測の表示を正確に**: 「ツール実行: N 回」は**そのアシスタント自身の呼び出しだけ**（`origin: agent`）。別のクライアントや、アプリ内部の `project_get` は数えない。名前別の内訳も出す
  （`track_set 288、wait 10…`）。ログの `tool` 行に `origin` を持たせた。
- **実機の結果**（`gemini-3.1-flash-lite`）:
  1. 手順書なし: 0〜-6 dB の静止した波で、「-60〜+6 を使った」と**嘘の説明**（計測で露見）。
  2. 手順書あり（範囲の数値入り）: -60〜+6 dB の波を設定し、実際の最小・最大を正しく報告。
  3. 「流れるように 10 フレーム、終わったら元に戻して」: 10 フレーム + `wait 300 ms` + 元の 0 dB へ復帰。計測は「変更なし」（始まりと終わりが同じ）で正しかった。
  4. 同じ依頼をもう一度: `wait` を使わず 1 回だけ設定し、「元に戻した」と言いながら実際は -27 dB のままだった。**モデルの出来にばらつきがある**。計測の表示（0 → -27 …）が食い違いを示した。
- **結論**: 能力としては成立する（フレーム・`wait`・復元まで通る）が、**軽量モデルは確実ではない**。だから「AI の説明ではなく計測を見る」仕組みが効く。
  次の改善候補: 動画的な依頼で `wait` が 1 回も無かったときの警告、より強いモデルへの切り替え（Options）、依頼を宣言的に書かせて検証する。

**訂正（同日）**: 「波」は能力を試すための**検証用の依頼**で、実際の用途ではない（金輪際ない）。そのため、波の式・フレーム・フルスイングの数値まで全プロンプトに入れたのは過剰だった。
`ANIMATION_GUIDE` は廃止し、短い一般則 `OPERATING_GUIDE`（まとめて 1 メッセージで・実際の範囲を守る・試しに変えたら戻す・確認せずに「できた」と言わない・曖昧なら聞く）だけにした
（700 文字未満をテストで固定。小型モデルはトークンごとに効く）。残したもの: 最大ステップ数の設定、古いツール結果の圧縮、計測表示（AI 自身の呼び出しだけを数える）。

### DevTools は既定で開かない（2026-10-10）
人は使わないので、開発モードでも起動時に DevTools を開かない。必要なときは `DAW_DEVTOOLS=1`（起動時）か View → Toggle DevTools。renderer の warn / error は従来どおりターミナルに出る（`[renderer:warn]` / `[renderer:error]`）。`console.log` 全部は MCP の `logs` ツール。

## 2026-10-10（8）— ステム機能（段階 1）: ステムの定義とステム単位の書き出し

**目標**: Cubase Pro に匹敵する「ステム」。段階 1 = ステムの定義 + 書き出し。段階 2（グループチャンネル = 実体のあるバス）、段階 3（範囲・ディザ等の細部）は後続。
- **モデル**: ステム = トラックの `stem` 名（`Lane.stem`、プロジェクトの `tracks[].stem` に保存。無ければ未割り当て）。同名のトラックが 1 ファイル。
  左ペインのトラック詳細に「Stem」欄（既存名の候補つき）。MCP: `stems_list` / `stem_set` / `stems_export`。File → Export → Stems…（フォルダを選んで Options の既定で実行）。
- **書き出し**: `PlaybackScheduler.renderOffline(sources, …)` が、そのステムのトラックだけを GPU のマスターと同じ経路（ストリップ + インサート + フェーダー + パン）で
  オフライン描画する。全ステム同じ長さ（全レーンの最後のクリップ + 末尾の余韻）で頭が揃う。**マスターのチェーンとマスターフェーダーは既定で含めない**（Cubase の
  チャンネル書き出しと同じ）。Options で含めることも選べる。最終段の ±1 ハードクランプは、チェーンを含めない書き出しでは外す（`skipFinalClamp`。float は余裕を保つ）。
- **形式**（Options → Export が既定、MCP の引数で上書き）: 24-bit（既定）/ 32-bit float / 16-bit（TPDF ディザ、決定的）、サンプルレートはプロジェクトと同じ / 44.1 / 48 / 96 kHz。
  変換は書き出し時のみ CPU: 取り込みと同じ窓付き sinc の多相 FIR（`polyphaseCoeffs`）を位相間の線形補間つきで使う（96k → 48k は補間不要）。整数への変換は `wav.ts` の `encodeWavPcm` のみ
  （全体で ±フルスケールに切った数を返し、画面とツール結果で報告）。
- **処理の選択**: `process` = `full`（既定）/ `noInserts`（インサートを通さない）/ `dry`（ストリップも通さない）。`masterChain` = マスターのフェーダー + インサートを通す。
- **検算**: 既定で（ステムが 2 つ以上のとき）「ステムの合計」と「同じトラックの 1 回の描画」を比べて `maxAbsDiff` / `snrDb` を返す。
- **AI**: アプリ内 AI も同じツールを使える。**出力先はアプリ内 AI からは指定できない**（`callTool` が origin = agent の `folder` を捨て、常に `Documents/Awaker/Stems/<日時>/`）。
- **検証（実機・24 トラックの曲）**: 4 ステム（Drums 11 / Bass 1 / Guitars 5 / Vox 6、各 3,310,639 フレーム）を 4.2 秒で書き出し。検算 SNR 143 dB。
  全ステム（32-bit float）の合計 × マスターゲイン と、マスターのインサートをバイパスした通常の `bounce` が SNR 141 dB（最大差 1.2e-7）で一致。
  48 kHz は 1,655,320 フレーム、`dry` は `full` よりピークが 4 dB 低い、マスターチェーンを含めるとマキシマイザー（-0.49 dB）で頭打ち。
- **ハマりどころ**: ① 最初の実装は `INTERLEAVE_WGSL` の ±1 クランプで Drums が 1.0 に張り付き、検算が SNR 46 dB で不一致（合計とクランプの順序が違う）。
  ステム書き出しではクランプを外して解決。② Drums の素の合計は +2.7 dB でフルスケールを超える（このプロジェクトは各トラックが 0 dB で熱い）。24-bit では切れる（72 サンプル、報告される）→ 32-bit float か
  フェーダーを下げる。
- **未実装（次）**: 段階 2 のグループチャンネル（バスのフェーダー / インサート / ミュート / ソロ。トラック → バス → マスター）、書き出し範囲のロケーター指定 UI、ノーマライズ、
  ファイル名のテンプレート、FLAC / MP3、プリフェーダーの選択。ステムの UI は Stem 欄だけ（一覧管理の画面は無い）。

## 2026-10-10（9）— グループチャンネル（バス）: トラック → グループ → マスター

ステムの「段階 2」。トラックの出力先をマスター以外（グループチャンネル）にできる。
- **経路**（`master-bus.ts`）: トラックはグループへ振り分けられると、マスターの代わりに**グループごとの合算バッファ**（`groupBuf`、1 グループ 1 スライス）へ足される。
  全グループの合算が済んだら、グループごとに「合算 → グループのインサート → フェーダー / パン → マスターへ加算」。マスターフェーダーは、マスターへ入る所で 1 回だけ掛かる（グループへ入る所では 1）。
  ミックス加算は全部「累積」にして、ブロックの先頭でマスターとグループの合算をクリアする（以前の「先頭トラックは書き込み」は不要になった）。グループが無い場合の出力はビット一致（誤差 0）。
  グループ 1 本の出力ピークも GPU で測る（`groupPeaks`、トラックのピークと同じ枠 `peaks` の後ろ）。ミュートした / 流れ込みが無いグループは処理を飛ばす。
- **モデル**（`main.ts`）: `Group { id (1001〜), name, mix, inserts, strip }`、`Lane.group?`。id をトラックより上の別帯にして、1 つの数がインサートの持ち主・選択・MCP でどちらも指せる。
  保存: プロジェクトの `groups[]` と `tracks[].group`。ミュート / ソロ: グループのソロはメンバーを通す、メンバーのソロはそのグループを通す、ミュートしたグループはメンバーごと無音。
- **画面**: ミキサーのトラックの後ろにグループのストリップ（上端が青、R ボタンなし。フェーダー / パン / M / S / ピーク / インサートラック）。ツールバーの「＋ Group」。トラック詳細の
  「Output」（Master / グループ）。グループを選ぶと左ペインに名前（変更可）・メンバー・Delete・インサートラック。
- **MCP**: `groups_list` / `group_add` / `group_set`（メンバー全体の指定も可）/ `group_remove`、`track_set` の `group`、インサート系の `owner` にグループ id。
- **書き出し**: グループはステムとして既定で一緒に書き出される（グループの出力）。`process: noInserts / dry` ではグループのインサートも通さない。名前指定でステム名とグループ名の両方を選べる。
  検算（ステム合計）はステム名 / トラック別が対象で、グループは自分の処理を持つため含めない。
- **検証（実機、24 トラックの曲、マスターのチェーンはバイパス）**: グループ 0 dB = グループなし（SNR 141.2 dB）。グループ -4 dB = メンバー全員 -4 dB（148.4 dB）。グループのソロ = そのトラックだけ（完全一致）。
  グループのミュート = メンバーのミュート（完全一致）。保存 → 読み込みでグループと 11 本の経路が残る（ミックスは、ストリップの個体差で約 52 dB。既知）。グループの書き出し × マスターゲイン = その
  グループだけの bounce（151.7 dB）。グループ削除でトラックはマスターへ戻る。
- **未実装（次）**: グループのチャンネルストリップ（ドライブ / EQ / コンプ。今はインサートのみ）、グループ → グループ（入れ子）、グループのセンド、プリ / ポストフェーダーの選択、
  グループへのオートメーション、ドラッグ操作での振り分け、MIDI サーフェス（P1-Nano）でのグループのバンク切り替え。

## 2026-10-10（10）— トラックの色（色が下地・波形は濃いグレー）とステムの同色化

- **見た目**: レーンの背景を**トラック色**で塗り、波形は**濃いグレー**（`WAVE_INK` = 0.15 / 0.165 / 0.19）。以前の「濃いエメラルドの地 + 明るいエメラルドの波」から変更。
  レーン見出しの左端とミキサーのストリップの頭にも同じ色（CSS 変数 `--track`）。選んだクリップの塗りは、トラック色の淡い色（`fill`）+ ほぼ黒の波形。
  GPU: `WAVE_WGSL` の View に `waveColor` / `fillColor`（vec4）を足し、`WaveformRenderer.setColors(bg, wave, fill)`、背景のクリア色もトラック色。
- **色**: `Lane.color`（`#rrggbb`）。新しいトラックはパレット（12 色、`ui/track-color.ts`）を順に取る。保存: `tracks[].color`、`stemColors`（ステム名 → 色）、`groups[].color`。
  古いファイルにはどれも無く、位置でパレット色になる。
- **ステムの同色化**（`alignStemColors`、純粋・テスト済み）: ステムを選ぶ（画面の Stem 欄 / `stem_set`）と、そのトラックはステムの色になる（新しいステムは最初の 1 本の色を取る）。
  ステムを持つトラックに色を付けると、**そのステムの全トラックが同じ色になる**。ステムなしのトラックは自分の色。グループに振り分けたステムなしのトラックは、グループの色。
- **操作**: 左ペインの Color（パレット 12 色）、グループの詳細にも Color。MCP: `track_set { color }`（`#rrggbb` / `#rgb` / パレット番号 `"0"`〜`"11"`）、`stems_list` の `color`、`tracks_list` の `color`。
- **検証（実機）**: 既定で 12 トラックが別々の色 → ステム Drums に 11 本入れると全員が先頭の色 → 1 本の色を変えるとステム全員が変わり他は不変 → 後から入れたトラックも同色 →
  ステムを外すと自分の色を保つ → グループに振り分けるとグループの色 → 保存 / 読み込みで色とステムの色が残る。画面では、ドラム 11 本が同じ空色、Bass が黄色、波形は濃いグレー。

### 色まわりの調整（2026-10-10 続き）
- **レーンの色を少し暗く**: 背景 = トラック色の 70 %（`lanePaint` の `bg`）。波形の墨（濃いグレー）との明暗は、輝度平均で 55 % 未満をテストで固定。
- **波形の枠の緑のラインを廃止**: クリップの輪郭・フェード・選択・名前・ハンドルの緑（エメラルド）をやめた。通常 = ごく薄い黒の縁、選択 = 白、名前 = 濃いグレーの文字。
- **チャンネルストリップの色の帯 = 一番下**（細い、6 px）。上の帯は廃止。**帯をクリックすると 12 色のパレットが開き**、そこから色を設定できる（ステムのトラックはそろって変わる。
  グループのストリップならグループの色 + ステムなしのメンバー）。Esc / 外側クリックで閉じる。
- **グループの既定色は使用中を避ける**（`pickUnusedColor`、色相を離して選ぶ。12 個で一巡）。`group_set` に `color`。以前は 4 つ目で最初と同じ色になった。
- **書き出し**: 同じ名前・同じメンバーのステムとグループは 1 つとして扱い、バスの出力として 1 回だけ書き出す（二重にならない）。
- **API エラーの説明**（`explainApiError`）: HTTP 402 / 401 / 404 / 429 / 5xx を、原因と対処つきの日本語で表示（生の JSON は短い詳細として残す）。

## 2026-10-10（11）— AI ミックス（平均スペクトル合わせ）、サービス別のシステムプロンプト、スロット移動

- **サービス別のシステムプロンプト**（Options → AI）: Claude Code / Ollama / Gemini / OpenAI 互換のそれぞれに複数行の入力欄（`promptClaudeApp` / `promptOllama` / `promptGemini` / `promptOpenai`、上限 8000 字）。
  **空欄 = アプリの既定**（既定の文面は今回は変えていない）。「既定の文面を入力欄に読み込む」で既定から編集できる。外部の Claude Code（MCP）には無い（向こうが自分のプロンプトを持つ）。
  `AiConfig.systemPrompt` → `runAgentTurn(…, systemPrompt)` / `buildClaudeArgs({ prompt })`。操作ログの turn に `customPrompt: true`。Options の `text` フィールドに `multiline` / `rows`。
- **AI MIX ボタン**（転送バーの右端。AI ボタンの右側ではなく、ウィンドウ右端に離した）: ジャンル（pop / rock / metal / edm / hiphop / rnb / jazz / acoustic / classical）か、
  **リファレンス曲（WAV）の平均スペクトル**を目標にし、「測定だけ」も選べる。押すと、AI（Options → AI で選んだもの）に手順つきの依頼（`audio/mix-prompt.ts`）が飛ぶ。チャット欄には 1 行だけ表示。
- **測る**（`audio/spectrum.ts`、純粋・テスト済み）: 曲全体の**長時間平均スペクトル**を 1/3 オクターブ 28 帯（31.5 Hz〜16 kHz）で出す。Hann 窓の FFT（約 6 Hz 分解能、50 % オーバーラップ、
  L / R を 1 本の複素 FFT に詰める）、長い曲は最大 500 フレームを等間隔に抜く、無音のフレームは除く（絶対 -70 dBFS、平均の -30 dB 未満）。
  レンダはブロックごとにアナライザへ流し、**音声のコピーは持たない**（`renderOffline` の `keepAudio:false` / `onBlock`、`renderMaster`）。形（ラウドネスを引いた 100 Hz〜8 kHz 平均 0）で目標と比べる。
  ジャンルの曲線は教科書的な典型形（目安）。リファレンス曲のほうが正確。許容は中域 ±2 dB、端 ±3 dB（31.5 Hz は ±5 dB）。
- **直す**: 偏差は隣の帯と平滑化（1-2-1）してから領域にし、1 帯だけのギザギザは直さない。領域ごとに EQ の 1 手（`fix`: kind / freq / gainDb / q、効かせ方 70 %、±6 dB まで）を計算。
  `breakdown` ではグループ / ステム / その他を個別に書き出して、各領域のエネルギーの持ち主（`parts`: 割合と、そのパート単独で必要なゲイン）を返す。
  `eq_apply` は対象チャンネルの最初の eq5 に補正を**足し込む**（無ければ作る。合計 ±12 dB。ピークは近い帯があればそこへ、無ければ空きの帯へ）。
- **MCP ツール（新）**: `mix_target`（現在の目標と使えるジャンル）、`mix_target_set { genre }`、`spectrum_analyze { scope: master|breakdown, startSeconds, seconds }`、`eq_apply { owner | tracks, kind, freq, gainDb, q }`。
  リファレンス曲はパスを取るので、AI からは指定できない（ダイアログだけ）。
- **スロット移動**: インサートのスロットをドラッグ&ドロップで並べ替え（同じラック = 並べ替え、別チャンネルのラック = 移動。満杯 / マスター専用（BusComp / Maximizer）は拒否）。従来の ▾ メニューの上下も残る（`audio/slot-move.ts`、テスト済み）。
- **左ペイン**: Color を一番下へ（トラック / グループ）。
- **検証**: 単体 22 ファイル（`spectrum`: トーン -9.03 dB、ピンクノイズ平坦 ±0.6 dB、ホワイトノイズ +3 dB/oct、無音の除外、60 フレーム抜きで ±0.4 dB、
  ブロック分割でも同じ、EQ 帯の割り当て、ほか）。実機（24 トラック・34.5 秒、96 kHz）: マスターの測定 1.8 秒、breakdown（グループ 4 + その他）6.4 秒。ジャンル pop に対し
  rms 3.2 dB → 1 ラウンド（Bass 112 Hz +2.5 / Vocals 447 Hz -4.5 / Drums 6.3 kHz +4）で 2.7 dB、許容内 54 → 64 %。試験後はプロジェクトを元に戻した。
- **注意 / 次**: 「目標に近い = 良いミックス」ではない（平均スペクトルは形の目安）。AI の判断（どの部分を触るか）の質は接続先のモデルに依る。次の候補: 領域ごとのダイナミック EQ、
  ステレオ幅 / 位相の測定、ラウドネス目標（-14 LUFS など）との組み合わせ、リファレンスの複数曲の平均、ジャンル曲線を実測で作り直す仕組み。

### 追記（同日）— AI ミックスの段階化、アプリ内スキル、マスター EQ を最後の手段に
- **きっかけ**: AI がマスターに EQ を差して終わった。原因は、グループもステムも無いと内訳が「その他」1 個になり、直す先がマスターしか無かったこと。
  → グループにもステムにも入っていないトラックは、**トラック単独のパーツ**として内訳に出す（32 本まで。それ以上は「その他」1 個）。
  → `eq_apply` のマスターは 1 帯 ±3 dB で止め（`note` で AI に伝える）、依頼文と手順書で「領域はマスターで直さない」。
- **AI ミックスは 3 段階**（ユーザーの指定）: ① 各トラックを出力 RMS -18 dBFS 付近へ（`strip.trimDb`）② 飛び出す音をチャンネルストリップのコンプで抑える（`comp`）
  ③ 曲全体の平均スペクトルを目標へ（従来の測る → 直す）。最後に `bounce` でピーク確認。
  - 新ツール `track_levels`: トラックごとの出力 `rmsDb`（鳴っている区間の RMS。100 ms 窓、-60 dBFS 未満は除く）/ `peakDb` / `crestDb` / `stickOutDb`（一番大きい 100 ms 窓 − 平均）と、
    目標に合わせる `suggestTrimDb`（±24 dB）。`audio/levels.ts`（純粋・テスト済み）。トラックを 1 本ずつ単独でレンダし、ブロックごとにメーターへ流す（音声は保持しない）。
  - 「飛び出す」の合格: `stickOutDb` ≤ 6 dB（ドラム / パーカッションは ≤ 9 dB）。コンプはしきい値を RMS+2 dB・ratio 3 から、1 ラウンドごとにしきい値 -3 dB か ratio +1（4 ラウンドまで、`crestDb` < 6 で止める）。
    音量が落ちた分は `makeupDb` で戻す。
- **アプリ内スキル**（`skills/<名前>/SKILL.md`）: 同梱は `ai-mix` / `awaker-basics` / `stems-groups` / `mixing-basics`。ビルド時に main へ文字列として取り込む（`import.meta.glob`）。
  あなたのスキルは `<userData>/skills/<名前>/SKILL.md`（または `<名前>.md`）で、同名なら優先、再起動不要。AI は `skills_list` / `skill_get` で読む（MCP のツールなので、
  Claude Code / Gemini / Ollama のどれでも同じ手順書が届く）。システムプロンプトには**索引だけ**（名前 + 1 行）が自動で付く（自分のプロンプトにも付く）。
  AI MIX の依頼には `ai-mix` の本文を丸ごと載せる（確実に届ける。人が書き換えた版が優先）。
  純粋部分は `src/main/skills.ts`（テスト済み。同梱ファイルが解析でき、名前が一意で、文中のツール名がすべて実在するかも検査）。
- **検証（実機）**: `skills_list` 4 件、`skill_get ai_mix`（`_` / `-` どちらでも）、未知の名前は一覧つきのエラー、`track_levels`（5 トラックで 3.2 秒）。
- **次**: ゲインステージングをフェーダー側でも選べるようにするか（今はトリム）、グループのコンプ（グループにストリップが無いのでインサート待ち）、スキルを増やす
  （書き出し・録音・MIDI の手順書）。

## 2026-10-10（12）— Mixdown 書き出し、dev リリース準備（パッケージ化）

- **File → Export → Mixdown…**（`mixdown_export` ツール）: マスターのチェーンとフェーダーを通した最終ミックスを 1 本の WAV に（ビット深度 / レート / テイルは Options → Export）。
  バウンスと同じレンダ。結果にピーク / RMS / LUFS / クリップ数。検証（実機）: 24-bit・96 kHz・ステレオで 3,310,639 フレーム（曲の長さと一致）、ファイルのピーク -0.49 dBFS = バウンスの -0.49 dB。
  アプリ内アシスタントはフォルダを選べない（`stems_export` と同じ）。
- **他社製品名**: UI 文言とコメントから Cubase / Pro Tools の比較表現を除いた（Options の「含めない（一般的なチャンネル書き出しと同じ）」ほか）。
  DAWproject の互換の説明（「Cubase 14+ で書き出した DAWproject を読める」）だけは、どのソフトで使えるかを伝える事実の記述なので残す（README と import / export のヒント）。
- **portable ビルド**（`npm run package` = `scripts/package.mjs`、新しい依存なし）: Electron のランタイム + `out/` + 実行時に要るモジュール（audify・bindings・file-uri-to-path。cmake-js などのビルド道具は入れない）
  → `dist/Awaker-<version>-win32-x64/`（約 320 MB）と同名の zip（約 129 MB）。`Awaker.exe`、LICENSE / NOTICE / THIRD_PARTY_NOTICES.txt / LICENSE.electron / LICENSES.chromium.html、README.txt。
  zip は Windows の bsdtar をフルパスで呼ぶ（Git for Windows の GNU tar が先に PATH にあると `C:` をホスト名と読んで失敗する）。
- **検証（実機・展開した状態の Awaker.exe）**: 別ポート（`DAW_MCP_PORT=7790`）・使い捨ての user-data で起動 → WebGPU ready、MCP 応答、同梱スキル 4 件、エラーログなし、
  ネイティブのオーディオモジュールが読み込まれてデバイス一覧が出る。
- **リリース前に人が決めること**（未決・コードでは決めない）:
  1. **ASIO**: audify の同梱バイナリは ASIO 有効でビルドされている。ASIO の再配布は Steinberg のライセンス条件（task.md「フレームワーク由来…別途ライセンス確認」）。公開前に確認 / または ASIO なし（WASAPI のみ）のビルドで出す。
  2. **バージョンとタグ**: 今は `0.0.1`（README に「development preview (v0.0.1)」）。dev 版として何を名乗るか（例: `0.1.0-dev.1`）。
  3. **公開**: GitHub への push / リリース作成 / zip のアップロードは、まだ何もしていない（ブランチは `dev`、origin は GitHub）。
  4. **署名・アイコン**: 未署名（初回は SmartScreen の警告が出る）、実行ファイルのアイコンは Electron の既定。
  5. task.md「公開前の推奨アクション」の残り（商標は今回整理。G / F の弁理士確認は商用化前）。
- **次**: 決まったらバージョンを上げ、`npm run package`、zip の SHA-256 を控え、タグを打つ。公開後の追跡用に README の Status を更新。

## 2026-10-10（13）— ライセンスを GNU GPL v3（GPL-3.0-only）へ変更

- **理由**: 配布するオーディオ出力モジュールは ASIO 有効でビルドされており、Steinberg は ASIO SDK を GPLv3 または独自契約で提供している。初版は GPLv3 で配布する（判断: TK）。
  以前の開発版（Apache-2.0）の記述は、このログの過去部分に残してある。
- **変更**: `LICENSE` を GPLv3 の公式テキストに、`NOTICE` を GPL 表記 + ASIO の注記に、全ファイルの `SPDX-License-Identifier` を `GPL-3.0-only` に、`package.json` の `license`、README、リリースノート、
  配布物の README.txt / THIRD_PARTY_NOTICES.txt、exe のバージョン情報（著作権欄）。「or later」は付けていない（ASIO の条件が GPLv3 のため。必要なら `GPL-3.0-or-later` に変えられる）。
- **関係ライブラリとの整合（調査）**: 配布物は Electron（MIT）+ Chromium の同梱物 + audify（MIT）+ RtAudio（MIT 系、再配布時に変更点の送付を「依頼」するだけで拘束力なし）+ Opus（BSD 系）+ bindings / file-uri-to-path（MIT）。
  GPLv3 と矛盾するものは見つからなかった。ffmpeg.dll は LGPL v2.1+（動的リンクで可）、Vulkan / SwiftShader は Apache-2.0（GPLv3 と互換）、ANGLE は BSD-3。
  Chromium の `LICENSES.chromium.html` の GPL / AGPL / EPL 表記は、ほとんどが他 OS や Android 用の部品、またはライセンス文中の言及。
  Microsoft 配布物（d3dcompiler_47.dll / dxil.dll など）は Electron が同梱する独立 DLL で、GPL のアプリが Electron を同梱する例（Signal Desktop など）と同じ扱い。
- **残る注意（要確認）**: audify（RtAudio）が同梱する ASIO のヘッダは **ASIO SDK 2.3（© 1997-2013）**。Steinberg の GPLv3 提供は 2025 年 10 月の新しい SDK（2.3.4）で、
  古いヘッダ自体には GPL の許諾文が付いていない（`asioinfo.txt` は steinberg.net の契約書へ誘導）。厳密に GPLv3 で揃えるなら、audify を ASIO SDK 2.3.4 でビルドし直す、
  または Steinberg の（無償の）独自 SDK 契約を結ぶ。いずれの場合も、自分たちの著作物にだけ GPL の「ASIO とのリンクの例外（§7 の追加許諾）」を付ける選択肢がある。
- **GPL 配布の義務（公開時）**: 配布物に対応するソース（このリポジトリのタグ）を公開する。バイナリの audify は MIT の公開版（1.10.1）。LICENSE / NOTICE を配布物に同梱（済み）。

## 2026-10-10（14）— ソースのみのリリースに方針変更、ライセンスを Apache-2.0 へ戻す

- **経緯**: ASIO（audify の `rtaudio.dll` が抱える ASIO ホストコード。SDK 2.3 のヘッダ © 1997-2013）を zip に同梱して配ると、Steinberg の条件（独自契約 or GPLv3）の確認が要る。
  ASIO だけを除いた `rtaudio.dll` を作るには、MSVC の C++ ビルド環境が要る（このPCには無く、C: の空きも少ない）。**判断（TK）: バイナリは配らず、ソースだけを公開し、ビルド方法だけを書く**
  （Audacity と同じ方式）。ASIO はリポジトリにも配布物にも無い。audify は利用者が `npm install` で上流から取得する。
- **ライセンスを Apache-2.0 に戻した**（判断: TK）。GPLv3 にしたのは ASIO 入りの zip を配るためで、その前提が消えたため。`LICENSE` / `NOTICE` / 全ファイルの SPDX / `package.json` / README。
  将来 ASIO 入りのバイナリを配る場合は、そのとき GPLv3 または Steinberg の契約を選ぶ（Apache-2.0 のコードは GPLv3 の成果物に取り込める）。
- **調査メモ（残す）**: ASIO のコードは `audify.node` ではなく `rtaudio.dll`（219 KB）の中だけ。MSVC 製の `audify.node` が C++ の ABI で依存するため、差し替えには同じ MSVC での再ビルドが要る
  （MSYS2 の gcc では不可）。audify 自体は MIT・月 2.3 万 DL ほどの小さな公開パッケージ（作者 Almog Hamdani）で、ASIO の同梱は上流の RtAudio の流儀。
  ASIO を含まないビルドを CI（GitHub Actions の Windows ランナー、MSVC 入り）で作り、プリビルドとして配る案は未着手。
- **公開物**: ソース（タグ `v0.1.0-dev.1`）と README の「Building from source」。`github/RELEASE_NOTES.md` はソースのみのリリース用の本文。zip と SHA256SUMS は公開しない（削除）。
  `npm run package` は、手元で zip を作るための道具として残してある（配布用ではない）。

## 2026-10-10（15）— 残してあること（方針メモ。どれも未着手）

### 方針（TK、2026-10-10）
- **ASIO を含む部分と Awaker を別プロセス（別 exe）に分け、通信でオーディオを受け渡す。**
  - 境目は `src/main/audio-out.ts` の `NativeAudioOut`（デバイス列挙・開始 / 停止・出力チャンク・録音入力・ライブ入力）。これを抽象化し、同一プロセス版と遠隔版を持てるようにする。
  - 通信: Windows の名前付きパイプ（ローカル専用、起動ごとにランダム名）。枠付きバイナリで、開く設定 / 開始・停止 / 出力ブロック（float32 インターリーブ）/ 状態（再生済み・バッファ量・アンダーラン）/ 入力ブロック / デバイス一覧。
    帯域は 96 kHz・ステレオで約 0.77 MB/s。追加遅延は 1 ms 未満の見込み（要実測）。出力リングはホスト側に置く。
  - ホストは別リポジトリ・別配布。最初は Node + audify の小さなプログラム（ASIO 版。C++ のコンパイラ不要）。後で CI（GitHub Actions の Windows ランナー、MSVC 入り）で、ASIO なし（WASAPI のみ）版も作れる。
  - ホストが無い場合の Awaker は無音で起動する（書き出し・バウンス・Mixdown・AI ミックスはデバイス不要）。
  - 効果: Awaker は ASIO を一切含まず Apache-2.0 のまま配れる。ASIO の条件（Steinberg の契約 or GPLv3）はホストだけが負う。
  - **「いまはやらない」**（TK）。着手するときは、フェーズ 1 = プロトコル + 抽象化 + 遠隔クライアント + Node ホスト、から。

### 検討して退けた / 保留にした案
- **AudioWorklet + Wasm SIMD + SharedArrayBuffer**（Gemini の推奨）: 不採用。設計不変条件「Web Audio を使わない」に反し、ASIO と排他モード・96 kHz 固定の出力を失う。DSP は GPU にあるので Wasm SIMD も不要。
  使うとしても、ネイティブモジュールが無い環境向けの簡易フォールバック出力まで。
- **cpal + napi-rs（Rust）**: 保留。audify の置き換え候補で、Rust だけで済み（MSVC 不要）、貢献者の参入障壁が下がる。ASIO は cpal の任意機能なので、入れなければ Steinberg のコードは入らない
  （入れるとビルド時に SDK を取りに行く）。**未確認**: WASAPI の排他モード・プロジェクトのレート（96 kHz）直接出力・入力（録音 / ライブ）・cpal 自体のライセンス表記。
  進めるなら、先に小さな試作で「96 kHz 排他出力と入力が取れるか」を確かめる（退行しないこと）。
- **audify を別ライブラリへ置き換え**: 不採用（音の経路の再調整が大きく、退行の危険）。
- **ASIO を外した `rtaudio.dll` の再ビルド**: 手段は MSVC（このPCには無い。C: の空き 5.5 GB、D: は 12 GB）。ASIO のコードは `rtaudio.dll`（219 KB）の中だけで、`audify.node` は MSVC 製のため gcc（MSYS2）製 DLL とは差し替えられない。

### 公開（GitHub）で人がやること
- `dev` ブランチだけを push する。**`master` は push しない**（古い 4 コミットに旧メールアドレスと Windows のユーザー名が残っている。必要なら `master` をローカルから削除）。
- タグ `v0.1.0-dev.1` を打ち、リリース本文に `github/RELEASE_NOTES.md` を貼る（バイナリ添付なし）。
- 手元で zip が要るときは `npm run package`（`dist/`。ASIO 入りなので配布はしない）。

### その他の残り
- コード署名なし（証明書は有償）。exe のアイコンは仮（「〇に A」）。
- ASIO の古いヘッダ（SDK 2.3、© 1997-2013）は audify / RtAudio が抱えている。Steinberg の GPLv3 提供は SDK 2.3.4（2025-10）。バイナリを配る場合は契約書への署名か、2.3.4 でのビルドが要る。
- task.md「公開前の推奨アクション」の残り: リミッタ（F）と Transient Designer 系（G）の弁理士確認は商用化前。
- AI ミックス: 段階 1〜3 を AI に最後まで通した検証は未取得（ボタンからの実行結果の確認待ち）。ゲインステージングはトリム方式（フェーダー方式は未対応）。
- 重い処理は PowerShell（バックグラウンド + ログ）で行う（Git Bash のフォーク失敗で応答不能になった。メモリにも記録済み）。

## 2026-10-11 — 自前のオーディオモジュール（RtAudio + cwASIO）。audify はフォールバックへ

- **何をしたか**: audify（RtAudio の npm ラッパー）の代わりに、`native/audio` の自前モジュールを使うようにした。**Steinberg の SDK のコードは 1 バイトも入らない**
  （ASIO ドライバへの接続は cwASIO = クリーンルームの MIT 実装）。ビルドは MSYS2 UCRT64 の g++ だけ（MSVC・CMake・node-gyp 不要）。
- **構成**: `native/audio/vendor/rtaudio`（RtAudio 6.0.1 のソース、MIT 系）+ `vendor/cwasio`（MIT）+ `vendor/node-api`（Node のヘッダ、MIT）+ `src/shim`（RtAudio の ASIO 部分が
  `#include` する `asio.h` / `asiodrivers.h` などの代役。`AsioDrivers` クラスを cwASIO の列挙・読み込みの上に約 70 行で実装）+ `src/awaker_audio.cpp`（Node-API の層）+ `index.js`
  （audify と同じ形の `RtAudio` クラス）。`npm run build:audio` → `native/audio/build/awaker_audio.node`（約 3.3 MB、静的リンク）。
- **Node-API の呼び方**: インポートライブラリを使わず、ホスト（electron.exe）から関数を実行時に取り出す（`GetProcAddress`）。そのため MinGW 製でも Node と Electron の両方で読み込める
  （事前に最小の試作で確認）。`NAPI_EXTERN` を空にして公式ヘッダの型だけを使う。
- **audify との互換**: RtAudio の API（`openStream` / `write` / `start` / `stop` / コールバック）と意味（出力ブロックのキュー、1 ブロック消費ごとにフレームコールバック、入力ブロックごとに入力コールバック）を
  そのまま再現。`audio-out.ts` は読み込み先を `loadAudioModule()`（`src/main/audio-module.ts`）に変えただけ。自前版が未ビルドのときだけ audify を使う（`AWAKER_AUDIO_BACKEND=audify|native` で指定可）。
  audify は `optionalDependencies` へ。
- **検証（実機・Antelope Zen Go）**: ASIO ドライバ 4 件を cwASIO で列挙（Zen Go、Steinberg built-in、Generic Low Latency、ほか）。ASIO で 96 kHz・512 フレーム・ドライバ報告遅延 799 フレーム（audify のときと同じ）。
  フレームコールバック数が期待値（2 秒で 375）に一致。再生 60 秒でアンダーラン 0。ASIO 入力 2ch の録音でテイクが確定。WASAPI（共有）も 96 kHz で動作。バイナリに「Steinberg」の文字列は 0。
  テスト 25 ファイル（`awaker-audio`: 同梱ソースに Steinberg の SDK が無いこと、ビルド成果物に Steinberg の文字列が無いこと、API の形など）。
- **配布への含意**: 自前版は ASIO を含むバイナリを、Steinberg のコードなしで作れる。`npm run package` は、自前版が未ビルド、または Steinberg の文字列を含むときは失敗する（ガード）。
  バイナリ配布をするかどうかは未決（ソースのみの公開は維持）。cwASIO のクリーンルームの主張と、API 再実装の法理への依拠は、こちらでは検証していない（NOTICE に記載）。
- **未着手**: WASAPI 排他モードの実機確認（コードは従来と同じ）、`write()` のロックと確保（コールバック経路の `std::vector` 確保は audify と同等）、ライブ経路の短縮、
  モジュールの CI ビルド（貢献者がコンパイラを入れずに済むように）。

### 追記（2026-10-11）— 起動確認と WASAPI 排他の実機確認
- **起動確認**: `npm run dev:mcp` で起動。画面は正常（24 トラック・色分け・AI MIX は右端）、エラーログ 0 件、`[audio] using awaker-audio (RtAudio + cwASIO)`、WebGPU ready。
- **WASAPI 排他（Zen Go、無音出力）**: 「Playback 1/2」で、96 kHz / 512 フレームは期待どおり（2 秒で 376 コールバック）。48 kHz / 512 も正常。共有も正常。
  **96 kHz / 256 フレームは、コールバックが期待の約 80%（603 / 752）**: JS がブロックの補充（`write`）を、デバイスの周期（約 2.7 ms）に毎回は間に合わせられず、キューが空になって無音が出ている。
  → **今の構造（デバイスのコールバック → JS → `write`）では、256 以下は無理**で、ネイティブ側にリングを持たせて JS を周期から外す必要がある（ライブ経路の短縮と同じ話。`audify` でも同じ構造）。
  「Playback 3/4」は `Unable to initialize render audio client`（0 コールバック）。このエンドポイントは、ドライバ側で使えない状態（既定は 1/2 なので、アプリの動作には影響しない）。
- **cwASIO について**: クリーンルームの主張と、Steinberg の見解の確認は、TK が Steinberg に問い合わせる（結果待ち）。結果が出るまで、バイナリの配布は決めない。

## 2026-10-11（2）— マスターのラウドネスを -14 LUFS に着地させる（`loudness_land`）

- **きっかけ**: AI ミックス後の曲が大きすぎて、音割れを感じた（実測: 積算 -8.5 LUFS、ミックス前は -12.7 LUFS）。原因は、段階 1 のトリム（+1〜+24 dB）でマスターに入る前が +5.8 dB 上がり、
  マスターのチェーン（バスコン + マキシマイザー）が強く働いたこと。手順書は、ピークしか見ていなかった。
- **仕組み**: マスターフェーダーはマスターのチェーンの**手前**（`master-bus.ts` の mix-add で 1 度だけ掛かる）にあるため、最終の音量は、フェーダーの動きと 1:1 にならない（マキシマイザーが天井に張り付く）。
  そこで、**書き出して測る → フェーダーを動かす → もう一度測る**を、許容（±0.3 LU）に入るまで繰り返す（割線法。1 回の移動は ±12 dB まで、最大 8 回）。
  `audio/loudness-land.ts`（純粋、テスト済み）+ MCP ツール `loudness_land { targetLufs = -14, toleranceLu = 0.3, maxIterations = 8 }`（1 回ごとに曲全体のレンダ）。
  届かなかったときは `reason`（`fader limit` / `iteration limit` / `silent`）を返し、最も近かった値でフェーダーを止める。トラック・ストリップ・インサートは触らない。
- **AI ミックス**: 段階 4 として組み込み（手順書 `ai-mix` と依頼文）。AI MIX のダイアログに「最後に、マスターを ___ LUFS に着地させる」（既定 -14、チェックで無効）。
  この段階以外では、AI はマスターフェーダーを動かさない。測定のみの依頼では呼ばない。
- **検証（実機、24 トラック・34.5 秒）**: AI ミックス後 ai_mix1: フェーダー -10.0 → **-17.3 dB**、-8.5 → **-14.1 LUFS**（4 回のレンダ、6.9 秒。別のバウンスで -14.07 LUFS を確認、クリップ 0）。
  AI ミックス前 live_backup: -10.0 → -11.3 dB、-12.7 → -14.2 LUFS（2 回）。ピークは両方 -0.5 dBFS（マキシマイザーの天井）。
  結果は新しいファイルに保存（`%APPDATA%\gpudaw\ai_mix1_-14LUFS.json`、scratchpad の `live_backup_-14LUFS.json`）。既存のファイルは上書きしていない。
- **注意**: ラウドネスは、アプリが表示する積算 LUFS（K 特性。DEVELOP の LUFS 校正の注記どおり、暫定の +2 dB 補正つき）。外部の認証済みメーターとの照合は未了。
  また、トリムが +24 dB のトラックなど、段階 1 の持ち上げ過ぎ（サチュレーションへの影響）は、まだ手順書側で未対処（次の候補: トリムの上限）。

## 2026-10-11（3）— 赤を消す（`headroom_fit`）と、段階の組み替え（TK の指示）

- **指示**: ミックスの手法に問題がある。曲を通して、**どのトラックにも赤が付かない**ところまで、全体のフェーダーを下げる。各トラックの -18 dB は出発点（ゲインステージング）にすぎず、
  **ミックス後のマスターは RMS で -18 dB 前後が理想**（≒ -14 LUFS）。そのため、**全体を 10 dB 前後下げるのは、想定内**。
- **赤の定義**（コード確認）: トラック / グループの**出力ピーク（フェーダー後）が 0 dBFS 超え**（`main.ts` のメーター。`track_levels` の `peakDb` と同じ量）。
- **`headroom_fit { marginDb = 0.5 }`**: 各トラックとグループの出力ピークを曲全体で測り（オフライン）、一番大きいピークが `-marginDb` dBFS になる量だけ、**全トラックのフェーダーを同じ量下げる**
  （バランスは保つ。0.1 dB 単位で切り上げ）。それでもグループの合計が超えるなら、そのグループのフェーダーだけ、残りを下げる。再測定して `stillOver` を返す。
  純粋部分は `audio/headroom.ts`（テスト済み）。トラックの中身（トリム・EQ・コンプ）は触らない。
- **AI ミックスの段階**: ① トリムで -18 dB（出発点）② コンプ ③ スペクトル ④ **赤を消す**（`headroom_fit`）⑤ マスターを -14 LUFS に着地（`loudness_land`。戻り値に `rmsDb`、-18 dB 前後が理想）。
  手順書 `ai-mix` と依頼文（インラインの手順にも）を更新。測定のみの依頼では、④⑤を呼ばない。
- **検証（実機、ai_mix1 の -14 LUFS 版 + Bells の EQ）**:
  - 赤: 5 本（DrumsRoom +4.0、HiHat +2.2、ElecGtr1 +2.2、Claps +2.0、ElecGtr2 +0.4 dBFS）→ **全トラックのフェーダー -4.5 dB** → 0 本（最大 -0.5 dBFS）。21 秒。
  - 着地: マスターフェーダー -17.5 → -14.8 dB、**-16.7 → -14.2 LUFS、マスター RMS -18.3 dBFS**（別バウンスで -14.24 LUFS、ピーク -0.5、クリップ 0）。
  - 保存: `%APPDATA%\gpudaw\ai_mix1_headroom_-14LUFS.json`（新しいファイル。既存は上書きしていない）。
- **所見**: 今回の曲では、下げた量は -4.5 dB で、「10 dB 前後」には届かなかった（トリムが +24 dB のトラックは、赤の対象ではなかったため）。
  それでも、トリムの持ち上げ過ぎ（サチュレーションの手前）は、まだ手順書側で未対処。

## 2026-10-11（4）— 基準のミックス、`loudness_land` の 0.5 dB 刻み、テスト音源の権利

- **基準（TK の試聴判定）**: 折り返しのノイズを感じなくなり、ダイナミクスも出てきた。**これを基準とする**。
  `%APPDATA%\gpudaw\reference_mix_2026-10-11.json`（読み取り専用。SHA-256 `360db9c17b175c2688fbd3dcb6767bcf149611c97c9d550a7ea061eabb2f8ad1`）。
  内容: 24 トラック、**全トラックのフェーダー -4.5 dB**（赤を消した量）、トリム +1〜+24 dB（AI ミックスの段階 1）、コンプ 16 本、`18_Bells` に eq5（8 kHz -3 dB・Q 2）、
  マスター: フェーダー -15.0 dB、eq5 + バスコン + マキシマイザー。測定値: **-14.24 LUFS（積算）、短期の最大 -12.1 LUFS、RMS -18.3 dBFS、ピーク -0.5 dBFS、クリップ 0**。
  回帰の見方: 同じ素材を読み込んで `bounce` した値と比べる（ストリップの個体差で、読み込みごとに約 -50 dB の差が出る既知の件に注意。同一ロード内、または基準値との数 dB 以内で見る）。
- **`loudness_land` の刻み**: マスターフェーダーは 0.5 dB 刻み（スライダー）。以前の戻り値の `endDb`（-14.8）と保存値（-15.0）がずれていた（測定は丸めた後の値で行われていた）。
  探索を 0.5 dB の格子の上で行うように修正（`quantizeDb`、テストあり）。報告・保存・測定が同じ値になる。
- **テスト音源の権利**（TK の質問「この音源を再配布できると理想的」）:
  - 音源は Cambridge Music Technology（Cambridge-MT）のマルチトラック・ライブラリの、Moni Blue「April Blues」の抜粋（24 WAV、24-bit / 44.1 kHz、約 124 MB）。
    同梱の `Readme.txt`: 「教育目的でのみ提供。著作権者の明示的な許可なしに、商用目的に使ってはならない」。
  - ライブラリの FAQ（Mike Senior）: 自分の宣伝のためにミックスを使うことは、貢献者との取り決め上、許されない。許可は各アーティストに直接。
    素材の再配布・ミックスの公開について、明確な許諾の記述は確認できなかった（規約ページ本体は 403 で読めていない）。
  - **含意**: 生の WAV（と、そこからのミックス）を、リポジトリやリリースに同梱するのは避ける。公開用のデモには、権利が明確な素材（自作・合成・CC0 など）か、許可を得た短い抜粋を使う。
  - **プロジェクトファイルの注意**: プロジェクトの JSON は、WAV の**絶対パス（`C:\Users\<ユーザー名>\…`）**を持つ。共有・公開する前に、パスを相対化するか、取り除くこと。

## 2026-10-11（5）— ASIO を別ファイル（add-on）に分離（TK の指示）

- **指示**: cwASIO は明示的なライセンス違反ではないので、バイナリ配布は TK の責任で行う。ただし**ファイルを分離**して配布し、WASAPI ではなく ASIO を使うなら
  「同じフォルダに入れないと使えない」形にする。「cwASIO がバイナリ配布済みならリンクだけでも」→ 配布サイトに「ASIO を使うなら自分でダウンロード」とリンクを置く意味。
  **回答**: cwASIO はソースのみ（リリース・タグなし）で、Awaker 側の `AsioDrivers` 差し替え（shim）と RtAudio への接続は自前のコード。リンク先からは add-on が手に入らないので、add-on を自前で配布する。
  配布ページには、add-on の説明と cwASIO へのリンクを添える。
- **ビルド**（`scripts/build-audio.mjs`）: 2 ファイルを作る。`awaker_audio.node`（WASAPI のみ、ASIO のコード無し）と `awaker_audio_asio.node`（add-on: WASAPI + ASIO）。`--only=base|asio`。
  文字列確認: 本体は cwASIO 0、RtApiAsio 0、`SOFTWARE\ASIO` 0、Steinberg 0。add-on は RtApiAsio 52、cwASIO 7、Steinberg 0。
- **ローダ**（`native/audio/index.js`）: add-on（`build/`、exe と同じフォルダ、resources）→ 本体の順。壊れた add-on は飛ばして次へ。`nativeFile()` を追加。
  `audio-out.ts`: ASIO を要求しても、WASAPI のみのモジュールは RtAudio の仕様で WASAPI に替わる。`getApi()` を見て、ASIO の計画は飛ばす（別名で動かさない）。
  `audio-module.ts` は `using awaker-audio: <file> (<apis>)` をログに出す。
- **配布物**（`npm run package`）: 本体 zip（WASAPI のみ。ガードで、Steinberg / cwASIO / RtApiAsio / レジストリパスが入っていれば拒否）と、`Awaker-ASIO-addon-<ver>-win32-x64.zip`
  （`.node` 1 つ + cwASIO / RtAudio のライセンス + README。TK の責任で、無保証と明記）。本体 134.7 MB、add-on 0.75 MB。
- **検証**: 型チェック、`npm test` 27 ファイル全部通過。実機: `AWAKER_AUDIO_NODE` で本体を指すと、ASIO 要求が `WASAPI` になる（`apis=wasapi`）。add-on では ASIO ドライバ 4 本（Zen Go を含む）が列挙される。
- **未了**: Steinberg への問い合わせ（TK）、配布ページの文面、add-on を置いた状態での実際の再生（Zen Go）の聞き取り確認、デモ素材の権利。

## 2026-10-11（6）— 公開（dev + v0.1.0-dev.1）と公開側の整理

- **改行コード**: CRLF を主とする（TK）。`.gitattributes`（`* text=auto eol=crlf`、`tests/golden` は対象外）。リポジトリ内部は LF、作業ツリーは CRLF。`core.autocrlf` は false。
- **公開側（`github/` = TK-Developer-OSS/awaker のクローン）**: 親リポジトリの追跡ファイルを同期して **1 コミット**（`5897242`）。ローカルの履歴は繋げない（全履歴の push は厳禁）。
  `CLAUDE.md` と `.claude/skills/awaker/SKILL.md`（ローカル PC / MCP の話）は含めない。どちらも `.gitignore` に記載（親では追跡のまま）。同期時に明示的に飛ばす。
  公開済みの旧履歴（`3d19257`）には、古い `CLAUDE.md` が残っている（TK 了承）。
- **点検（クリアランス）**: 全 3 コミット + 作者 / メッセージ。個人名・ローカルパス・秘密情報・IP は 0 件。残るのは TK の公開署名、ベンダーの作者名、DEVELOP の実測機器名（RTX 3060 Ti / Zen Go）のみ。TK が了承。
  Claude の API キーはコードにない（`safeStorage` で暗号化して userData の `awaker-ai-key-*.bin`、`.gitignore` 済み）。
- **公開**: `dev` を push（HTTPS の URL へ直接。`origin` は SSH で、この環境では鍵がない）。`main` は触っていない。
  Release `v0.1.0-dev.1`（プレリリース、タグは dev 先頭）に 2 つの zip（本体 WASAPI のみ / ASIO add-on）+ SHA-256。
- **所見**: zip を別の場所に展開しても、ユーザーデータ（`%APPDATA%\gpudaw\gpudaw-project.json` など）から前回のプロジェクトが開く。まっさら起動の確認には、`%APPDATA%\gpudaw` / `%APPDATA%\awaker` を退避する。
- **未了**: Steinberg への問い合わせ（TK）、add-on を置いた状態での Zen Go の聴感確認、`mapAsync "master.staging" is already mapped`（ロード直後の再生）、トリム +24 dB のサチュレーション、WASAPI 排他の実機確認。

## 2026-10-25 — VST 音源の PoC（別プロセスのホスト → ライブ経路）、「なし」音源、ライブ経路の安定化

**やったこと**
- **MIDI の外部出力を実機で確認**（これまで機器が無く未確認だった）。**Electron の Web MIDI は Microsoft GS Wavetable Synth を一覧に出さない**（`sysex: true` でも）。loopMIDI（仮想ポート）を入れて、Awaker → loopMIDI → Komplete Kontrol / BFD Player が鳴ることを確認。**落とし穴**: ① loopMIDI で後から作ったポートは、loopMIDI を再起動するまでデータを中継しなかった（Total data が 0 のまま）② Awaker の MIDI 出力の一覧は、起動後に足したポートを反映しない（アプリの再読み込みが要る）③ 1 つのポートは、つながっている全アプリに同じ MIDI を配る（音源ごとにポートを分ける）。
- **「None (external MIDI)」インストルメント**（`gpu/instruments/external.ts`）: ノート・ピアノロール・MIDI 出力はあるが、内蔵音は出さないトラック。無音を描画して、レーン・ストリップ・インサートはそのまま使える。MCP `midi_track_add` の `instrument: 'none'`。
- **VST ホストのブリッジ（PoC）**（`main/vst-bridge.ts`）: 別プロセスのホストが 127.0.0.1（トークン認証）に接続し、MIDI（壁時計 ms の時刻つき）と 512 フレームのブロック要求を受け、音を返す。ホストは出力クロックより 1 ブロック先まで引っ張り（pull）、ブロックをライブ経路（ライン入力と同じ GPU のストリップ + インサート）に入れる。`audio-out.ts` に外部ソースの口（`injectLive` / `outClock` / `setExternalLive`）。MCP: `vst_listen` / `vst_note` / `vst_status` / `vst_stop`。画面: ライン入力トラックの詳細ペインに「VST host (PoC)」の節（プラグイン選択、待ち受け、状態、往復時間、MIDI イベント数）。
- **PoC のホストは Python の `pedalboard`（GPLv3、リポジトリには入れない）**。オフラインで MIDI → wav の描画ができ（Vital は実時間の約 18 倍）、Awaker のトラックとして取り込めた。リアルタイムでは、ホストの往復は平均 0.4〜1 ms（512 フレームの予算 5.33 ms）で健全。
- **ライブ経路の測定と改善**（詳細は「ロードマップ / 既知の問題」の「ライブ経路が…プチプチ」）: 原因は GPU の省電力（クロック 210〜465 MHz）が一因だったが主因ではなく、**1 ブロックごとに `await mapAsync` で読み戻しを待つ作りで、処理数が往復時間で頭打ち**になっていたこと。`MasterBus` の読み戻しバッファをプールから借りる形にして、`LiveBus` が最大 3 ブロックを同時に走らせる（パイプライン化）。重いストリップ 4 本 + 画面操作で、ブロック 512 の捨てが 50.7% → 3.2%、1024 は 5.5% → 0%。通常の再生は退行なし（アンダーラン 0）。既定ブロックを 1024 にし、「Line input」で選べる（512 / 1024 / 2048）。自動の着地遅延は 8 秒落ち着いたら戻す。
- ライブ用トラックのメーターと**マスターのメーター**が、ライブ経路の音を反映（`LiveBus.peakOf` / `outPeak`）。LUFS は未反映。
- MCP: `monitor` に `block`、`ui_click` に `pointer`（トラック / ストリップの選択は `pointerdown` で行うため）。

**今の状態 / 動くもの**
- Vital: 状態の保存なしで、ホスト経由でリアルタイムに鳴る（4 本のライブ用トラック、左右に振って確認。ごくまれにブツブツするが、それ以外の劣化はなし）。
- Komplete Kontrol（Kontakt の音源）: 窓で音源を選んだ同じプロセスの中でだけ鳴る（保存した状態からは復元されない）。
- BFD Player: PoC のホストでは処理の最初で落ちる（`BFDPlayer.vst3` 内のアクセス違反）。
- 外部の MIDI 出力（loopMIDI 経由）は、Out のポート選択で動く。

**次の一手**: ロードマップ「VST インストルメント対応」を参照。本物のホスト（C++ / VST3 SDK、ビルド環境の用意から）、state の保存と復元、先読みレンダリング型の再生への組み込み、安全装置（全ノートオフ）。**併行して、リターン用の仮想オーディオ I/F の路線**（TK 提案。入力デバイスの選択と複数デバイス対応が前提）。

**未解決**: ごくまれなブツブツ（画面操作の突発 60〜70 ms。専用 Worker への分離で根治できる見込みだが大工事）、BFD の落ちる原因、サンプラー系の状態復元、LUFS にライブ経路が入らない、ホスト停止時のノートオフ。`mapAsync "master.staging" is already mapped`（上の 2026-10-11（6））は、読み戻しバッファをプール化したことで解消した可能性があるが、未確認。

**触ったファイル**: `src/main/vst-bridge.ts`（新規）、`src/main/audio-out.ts`、`src/main/index.ts`、`src/main/mcp.ts`、`src/preload/index.ts`、`src/renderer/src/gpu/instruments/external.ts`（新規）、`src/renderer/src/gpu/master-bus.ts`、`src/renderer/src/audio/live-bus.ts`、`src/renderer/src/audio/scheduler.ts`、`src/renderer/src/main.ts`、`src/renderer/src/mcp-tools.ts`。コミット: `336fad2`、`5fb57b1`（push はしていない）。PoC のホスト（`vst_host.py`、`vst_edit.py`、測定の PowerShell）はスクラッチパッドで、リポジトリには無い。

## 2026-10-25（2）— VST ホスト PoC の合格（新規プロジェクトで、内蔵 MIDI 音源と外部 Kontakt が 8 ビートで同期）、リターン入力（Gemini 実装）、監督の運用

**合格の基準（TK）**: 元のミックスのプロジェクトではなく、**新規プロジェクト**で、内蔵の MIDI 音源（ドラムマシン + FM ベース）と、外部の Kontakt のピアノを同時に鳴らし、同期を確認する。**結果: 8 ビートでそろった（耳で確認。TK）**。数値: 16 小節（32 秒）で、ライブ経路の捨て 0、遅延ブロック 0、出力アンダーラン 0、ホストの往復は平均 0.96 ms・最大 8.6 ms（ブロック 512 の予算 5.33 ms）、MIDI の遅れたイベント 0。
**同期の合わせ方**: 外部音源の音は、ライブ経路を戻ってくるため、通常のトラックより約 35 ms 遅れる（着地遅延 25.7〜28.2 ms + ホストのブロックの量子化）。**外部ピアノの MIDI を、Out delay = -35 ms で早めに送る**（MIDI のポンプは 150 ms 先読みなので、負の値が使える）。MCP: `midi_track_set {track, out, channel, outDelayMs}`（新規）。

**構成（PoC）**
- ホスト: 作業フォルダ `gpudaw-poc/`（**リポジトリの外**。Python の `pedalboard` は GPLv3）。`vst-poc.ps1`（1 コマンドで起動。`-Plugin Vital` / `-Plugin "Komplete Kontrol" -Edit` / `-MidiIn "loopMIDI Pano"`）、`vst-poc-stop.ps1`、`vst_host.py`（loopMIDI の入力ポートを直接読み、MIDI トラックの Out をそのポートにすると、ノートが届く）、`vst_edit.py`。Awaker は `npm run dev:mcp` で起動しておく。
- Komplete Kontrol（Kontakt の音源）は、`-Edit` で窓（タイトル「Pedalboard」）を開き、音源を読み込んで窓を閉じる。**同じプロセスの中でだけ鳴る**（状態の保存と復元は、音源の読み込みが画面の操作と一体で、できなかった）。BFD Player は、この簡易ホストでは、処理の最初でアクセス違反（本物のホストで再挑戦）。
- 外部ソースの同時使用: ライブ経路は、1 本の連続したストリームを前提にしているので、`index.ts` の `extSource` で、**先に始めたほうだけを通す**（VST ホスト / リターン入力）。後から来たほうは、警告のログを出して無視。ミキサーで足し合わせる案は、将来。
- 「マスターにだけ入る」: ライブ経路の音は、グループチャンネルを通らず、マスターのインサート（バスコン、マキシマイザー）も掛からず、**バウンス・ミックスダウン・ステムにも入らない**。書き出しまでつなぐには、MIDI をホストでオフラインに描画して通常のオーディオトラックにする（PoC で、Vital が実時間の約 18 倍で書き出せて、取り込めた）。ロードマップの「先読みレンダリング」。

**リターン入力（Gemini 実装、Incline 経由。TK の指示）**: 仮想ケーブルの録音側などの、WASAPI 入力を第 2 の入力として開き、リング → ドリフト補正 → 出力クロックのフレーム番号でライブ経路へ（`src/main/return-in.ts` 511 行、`tests/return-in.test.ts`、`audio-out.ts` の `openWasapiInput` など、画面と MCP ツール `audio_inputs` / `return_*`）。型チェック・29 テストファイル通過。**実機の仮想ケーブルでの確認は、まだ**（この PC に VB-CABLE などが無い）。`RtAudio.cpp` の WASAPI 入力（IAudioClient3 の初期化失敗時に通常の初期化へ戻す）の修正も入っている（`npm run build:audio` でビルドは通った）。
**訂正**: 上の「この PC には MSVC / CMake / Rust が無い」は、MSVC の話。**この PC には MSYS2 の MinGW（`C:\msys64\ucrt64\bin\g++.exe`）があり、ネイティブのビルドは可能**（`npm run build:audio`）。本物の VST ホストを C++ で作るときは、MinGW での VST3 SDK のビルドを、先に試す。

**監督の運用（メモ）**: Incline（VS Code 拡張。TK のフォーク。https://github.com/TK-Developer-OSS/incline）は、ウィンドウごとにローカルの MCP サーバーを持つ（127.0.0.1、トークン認証。接続情報は、環境変数 `INCLINE_MCP_URL` / `INCLINE_MCP_TOKEN` として、同じウィンドウの Claude Code に渡る）。`session_send`（指示）、`session_status` / `session_messages`（状態と報告）、`session_wait`、`session_cancel`。**作業ツリーは共有なので、実装は 1 人だけが行い、監督側はリポジトリを編集せず、アプリも起動しない**（ポート 7777 と Zen Go の ASIO が衝突する）。Gemini は、範囲を絞って、手順を区切れば、使える。放っておくと調査に予算を使い切る（最初の予算で、本題のコードが 0 行）。Incline は `task.md`（追記）と `.task-order.json` を作るが、これは本体のコミットに含めない。

**次の一手**: ロードマップ「VST インストルメント対応」。優先は、(1) MIDI をホストでオフラインに描画して通常のトラックにする（書き出し・グループ・ステムに載る）(2) 本物のホスト（C++。BFD の対応。MinGW で試す）(3) リターン入力の実機確認（仮想ケーブルを入れる）(4) ホストの複数同時使用のためのミキサー。
**触ったファイル**: `src/main/index.ts`（`extSource`）、`src/main/mcp.ts` / `src/renderer/src/mcp-tools.ts` / `src/renderer/src/main.ts`（`midi_track_set`）、Gemini の変更（上）。
