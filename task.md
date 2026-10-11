# 特許抵触リスク洗い出し（dev リリース前）

- 作成: 2026-10-08 / 対象: このリポジトリ自身のコード（`src/`）のみ。フレームワーク/ライブラリ（Electron・RtAudio/audify・ASIO SDK・Vite 等）は範囲外
- 位置づけ: **コード側から見た「当たりそうな箇所」の洗い出し**。正式な FTO（侵害鑑定）ではない。
  前回の簡易点検は DEVELOP.md「2026-09-07 — 内蔵ストリップ: nasal 撤去」を参照。
- 手順: ① 本節で候補を列挙 → ② Web で特許の生死・クレームを確認 → ③ 末尾「調査結果」に追記。

## 1. 洗い出し（候補一覧）

| # | 箇所 | 技術要素 | 懸念の種類 | 暫定リスク |
| --- | --- | --- | --- | --- |
| A | アーキ全体: `scheduler.ts` / `track.ts` / `master-bus.ts` / `shaders.ts` | GPU（WebGPU）でオーディオ DSP をブロック処理し、読み戻してネイティブ出力へ送るパイプライン | GPU Audio Inc. の GPU オーディオ処理特許（US 12,026,518 B2 ほか。依存グラフ型スケジューラ、低レイテンシ GPU 処理など） | 中（要確認）。当方は単純な先読みブロックレンダ。 |
| B | `channel-strip.ts` `vary` / `satVary()` | インスタンスごとに乱数で係数を微小にずらす（個体差） | Brainworx TMT US 10,725,727 B2（部品公差レンジ＋ランダム化＋チャンネル選択） | 低〜中。ユーザー選択なし・回路モデルなし。表現（"tolerance"）を避ける運用。 |
| C | `channel-strip.ts` Saturation（drive / color）、`effects/tube.ts`、`tubeeq.ts` の 12AX7 モデル | 真空管・トランス・Class-A 風の非線形サチュレーション | 真空管/アナログ回路のデジタルモデリング特許（例: 非対称ソフトクリップ、トライオード段モデル）。多くは古く失効の可能性 | 低〜中（要確認） |
| D | `effects/tubeeq.ts` | Pultec EQP-1A 型（ブースト+アッテン同時）のパッシブ EQ エミュレーション | Pultec 原特許は失効済のはず。商標（Pultec / EQP-1A）の表記問題 | 特許 低 / 商標 中 |
| E | `effects/buscomp.ts` | SSL G バス型コンプ（ステップ値、Auto リリース＝プログラム依存、サイドチェイン、パラレルブレンド） | 古典的設計で特許は失効見込み。「Auto release」「パラレルコンプ」周辺の現行特許の有無。商標（SSL） | 特許 低 / 商標 中 |
| F | `effects/maximizer.ts` | ルックアヘッド・ブリックウォール・リミッタ（ステレオリンク） | Waves L1 系・各社ルックアヘッド/ISP リミッタ特許。基本方式は古く失効見込み。トゥルーピーク検出等を足すと別 | 低（要確認） |
| G | `effects/awaker.ts` / `AWAKER_WGSL` | HF エキサイタ（HF 抽出→高調波生成→パラレル加算）+ 帯域内トランジェント強調（fast/slow エンベロープ差分） | Aphex Aural Exciter 系（失効）、SPL Transient Designer（差分エンベロープ検出）系特許 | 低〜中（要確認） |
| H | `effects/reverb.ts` | Freeverb（Jezar、パブリックドメイン）。コム+オールパス | Schroeder/Moorer 系は失効。ただしデジタルリバーブ全般の現行特許の有無 | 低 |
| I | `effects/delay.ts` | フィードバック・ディレイ、ダンピング、クロスフィード | 一般的。ピンポン/クロスフィード特許は失効見込み | 低 |
| J | `effects/eq5.ts` / `biquad.ts` | RBJ biquad 5 バンド | 公知（Audio EQ Cookbook） | 低 |
| K | `resample-gpu.ts` / `RESAMPLE_WGSL` | ポリフェーズ FIR（窓付き sinc）による SRC | 古典的。GPU 上での SRC 実装特許の有無 | 低 |
| L | `waveform-renderer.ts` / ピーク表示 | GPU による波形描画・ズーム/パンでサンプルに再アクセスしない描画 | 波形表示（ピーク/ミップマップ）の古い特許は失効見込み。GPU 波形描画の現行特許の有無 | 低 |
| N | `control/mcu.ts` | Mackie Control プロトコルによる MIDI コントロールサーフェス駆動 | プロトコル利用は一般的。商標（Mackie / iCON）の表記のみ | 特許 低 / 商標 低 |
| O | `recorder.ts` / `edit/model.ts` | VRAM 常駐録音、クリップ編集（フェード、非破壊編集） | DAW の基本機能（Pro Tools/Cubase 系の古い特許は失効）。非破壊クリップフェード | 低 |
| P | `mcp.ts` / `mcp-tools.ts` | 内蔵 MCP サーバで AI がトランスポート・バウンスを操作 | AI による DAW 操作の新しめの出願が存在する可能性 | 低〜中（要確認） |

### 補足（特許以外で公開前に見るべき点）
- 商標表記: SSL / Neve / 1073 / 1176 / Pultec / EQP-1A / Mackie / iCON / Antelope / Zen Go /
  12AX7（球の型番は一般名称）。コメント・UI 文言での "〜風 / 〜ish / homage" の扱い。
  grep 結果: `shaders.ts`, `channel-strip.ts`, `buscomp.ts`, `tubeeq.ts`, `main.ts`, `mcu.ts`, `audio-out.ts`。
- フレームワーク由来（ASIO SDK の再配布条件など）は今回の範囲外。別途ライセンス確認が必要。

## 2. 調査結果


調査日: 2026-10-08。Google Patents / USPTO / 各社ページを確認。**正式な FTO ではない**（弁理士の鑑定ではない）。
「確認済み」= 特許本文または公式情報で裏取りできたもの、「未確認」= 検索で特許自体を特定できなかったもの。

### 結論サマリ
| # | 結果 | 根拠・判断 |
| --- | --- | --- |
| A | **要注意（確認済み・抵触は薄い）** | US 12,026,518 B2 は譲受人 **Braingines SA**（GPU Audio 関連）。生存、2042-09-13 まで。claim 1 は「SIMD 型デバイス上で、優先度・実行期限・リソース要求（スレッド数/レジスタ/共有メモリ/バリア数/実行時間）に基づき動的にスケジュールし、依存カウンタを更新し、階層キューを共有メモリに持つ並列分散スケジューラ」。当方は CPU 側の単純な先読みブロックレンダ（1 ブロック=1 GPU submit + 読み戻し）で、GPU 内スケジューラ・依存カウンタ・キューは持たない → 各構成要件を満たさない。**将来 GPU 側に依存グラフ/優先度キューのスケジューラを入れると危険。** |
| B | **要注意（確認済み・抵触は薄い）** | US 10,725,727 B2（Brainworx）生存、2038-03-18 まで。claim 1 は「回路モデル（各素子の位置・動作値・公差範囲）+ 公差範囲に基づく乱数動作値の生成 + リアルタイム・エミュレータ + GUI」、claim 15 は標準値での第 1 エミュレーションと乱数値での第 2 エミュレーション。従属項はコンソールのチャンネル等。当方 `vary` は素子モデルも公差範囲も持たず、係数に固定の微小ディザを埋め込むのみ・利用者に選択させない・GUI なし。コード/コメントも "component-tolerance ではない" と明記済み（grep で "tolerance" 系の表現なし）。**維持ルール: 公差/部品/チャンネル選択/シード UI を足さない。** `tubeeq.ts` にも同種の per-instance dither あり（同ルール適用）。 |
| C | 低（一部確認済み） | 検索で出た真空管エミュレーション特許（US 4,995,084 / 5,133,014 / 5,434,536 / 5,734,725）は 1989〜1990 年代出願で**20 年満了済みと見られる**（出願日からの計算、法的状態の個別確認は未了）。US 9,633,812「Triode tube emulator circuit」は生存だが**アナログ回路**の請求で、DSP ソフトは対象外の見込み。tanh/非対称ソフトクリップは公知技術。 |
| D | 特許 低 / 商標 注意 | Pultec EQP-1 は 1951 年設計で、特許が残っていても満了。特許は低リスク。**商標**（Pultec / EQP-1A）は名称使用に注意（"homage" 表記でも商標的使用になり得る）。 |
| E | 特許 低 / 商標 注意 | SSL G バスコンプは 1970〜80 年代設計。現行特許は検索で見つからず（未確認）。商標 SSL の使用に注意。 |
| F | 低（未確認） | ルックアヘッドリミッタ（Waves L1 系）は 1990 年代の基本方式。検索で現行特許は特定できず。トゥルーピーク検出/ISP 等を足す場合は再調査。 |
| G | 低（一部確認済み） | Aphex Aural Exciter の基本特許 US 4,150,253 は 1977 出願・1979 登録で**満了済み**。SPL Transient Designer の差分エンベロープ検出は検索で特許番号を特定できず（未確認、1990 年代後半の技術で満了している可能性が高い）。当方は HF 帯域内の fast/slow エンベロープ差分でパンチを付ける実装なので、**Transient Designer 型と近い**点は残る。要追加確認。 |
| H〜J | 低 | Freeverb（パブリックドメイン）、RBJ biquad、一般的なフィードバック・ディレイ。 |
| K | 低 | ポリフェーズ FIR/窓付き sinc の SRC は古典技術。GPU 上の SRC 特許は検索で見つからず。 |
| L | 低（未確認） | GPU 波形描画に絞った特許は検索で見つからず。 |
| N | 低 | Mackie Control は広く実装されたプロトコル。商標表記のみ（Mackie / iCON）。 |
| O | 低 | DAW の基本機能。古い特許は満了。 |
| P | 低（未確認） | 「MCP/AI で DAW を操作」を請求する登録特許は検索で見つからず（DAWZY など OSS/論文は存在）。出願中の可能性は残るが公開情報では確認できない。 |

### 追加で分かったこと
- DEVELOP.md / メモリにある「GPU Audio Inc. US 12,026,518」は**譲受人表記が誤り**。Google Patents 上は **Braingines SA**。DEVELOP.md の該当箇所は過去ログなので原文のまま残し、ここに訂正を記す。
- ストリップのサチュレーション/個体差は、現状の表現・実装で TMT の構成要件（素子ごとの公差範囲、標準値と乱数値の二重エミュレーション、GUI 提示）から外れている。

### 公開前の推奨アクション
1. **商標表記の整理**（最優先で効果が大きい）: UI 文言・コメントの `SSL` / `Neve` / `1073` / `1176` / `Pultec` / `EQP-1A` / `Mackie` / `iCON` / `Antelope` / `Zen Go`。UI 表示名は汎用名（"Program EQ" 等）にし、コメントで比較対象として挙げる程度に留めるか削除。対象: `shaders.ts`, `channel-strip.ts`, `buscomp.ts`, `tubeeq.ts`, `main.ts`, `mcu.ts`, `audio-out.ts`。※ 実施は別途指示を待つ。
2. 設計ルールの維持: ① GPU 側にスケジューラ（依存グラフ/優先度キュー）を作らない ② 個体差は乱数埋め込みのみ・ユーザー選択なし・"tolerance/component/channel number" を使わない。
3. G（Transient Designer 型）と F（リミッタ）は、実装を変える場合や商用化前に弁理士へ確認。
4. 本書の限界: 特許の網羅検索（分類 G10L/G10H/H03G、出願中公開公報、他国）はしていない。商用化・資金調達の際は正式 FTO を推奨。

### 出典
- US 12,026,518 B2: https://patents.google.com/patent/US12026518B2/en
- US 10,725,727 B2: https://patents.google.com/patent/US10725727
- US 4,150,253（Aphex）: https://patents.google.com/patent/US4150253A
- 真空管エミュレーション関連: https://patents.google.com/patent/US9633812 / https://patents.google.com/patent/US5434536 / https://patents.google.com/patent/US5734725

---

## 3. カテゴリ別 個別特許調査（深掘り）

凡例: 状態は Google Patents 表示に基づく（2026-10-08 時点）。「失効（Fee Related）」は年金不払いによる失効で、
満了予定日が先でも**現在は権利なし**。判定は **◎=問題なし / ○=低 / △=要注意（設計ルールで回避） / ×=抵触の恐れ**。
当方実装の事実は `src/renderer/src/gpu/shaders.ts` 等の現行コードに基づく。

### カテゴリ1: 倍音生成（エキサイタ / 低域・高域の倍音付加）— 最重点

当方の該当実装:
- `AWAKER_WGSL`: HF 帯域分離（1 極 LP の差分）→ HF プリエンファシス → **バイアス付き 3 次ソフトシェイパ** → ポスト LP → **ドライに並列加算**（`out = dry + amount·wet`）。さらに HF 帯の fast/slow エンベロープ差分による**トランジェント強調**を同じ wet バスに混ぜる。
- `colorStage`（ストリップ Color）: DC ブロック → **LF ブルーム（低域を抽出し tanh で飽和、元信号に戻す）** → HF プリエンファシス → 非対称 tanh（bias=2 次）→ ショルダ。
- `driveStage` / `buscomp` の bright drive: プリエンファシス → 非対称 tanh → DC ブロック。

| # | 特許 | 権利者 / 出願 | 状態 | 請求の要点 | 当方との比較 | 判定 |
| --- | --- | --- | --- | --- | --- | --- |
| 1-1 | US 4,150,253 Signal distortion circuit | Aphex / 1977 | 満了 | HPF → 閾値超の周波数に低次倍音を生成（真空管/半導体）。エキサイタの原型 | 構成は似るが満了 | ◎ |
| 1-2 | US 5,424,488 Transient discriminate harmonics generator | Aphex / 1993 | **満了** | 入力の立ち上がりで倍音量を多く、RC 時定数で漸減。ダイオード整流+RC / AGC 乗算 | 「立ち上がりで倍音を増やす」概念は Awaker の Punch と近いが、請求は RC・整流回路で、かつ満了 | ◎ |
| 1-3 | US 6,275,593 Harmonic enhancement | True Dimensional Sound / 1996 | 失効（2016） | HPF 風ネットワークで上域を非線形増幅、振幅ピーク最大 2 つ、磁気コイル系を使わない | 失効 | ◎ |
| 1-4 | US 5,524,074 DSP for adding harmonic content | E-mu（Creative）/ 1992 | 満了 | 優先エンコーダ+ビットシフタの「フラクタル」伝達関数 | 手法が全く別（ビット操作） | ◎ |
| 1-5 | US 5,841,875 Digital audio signal processor with harmonics modification | Yamaha / 1996 | 満了 | ルックアップテーブル+**入力振幅に応じて可変する DC バイアス** | 当方のバイアスは固定（ドライブ量依存のみ）。満了 | ◎ |
| 1-6 | US 6,792,115 Apparatus for generating harmonics | TDK Micronas→Entropic / 2000 | 満了（2022） | 適応フィルタで優勢な基音（<120Hz）を抽出→非線形→BPF→加算 | 満了。当方は基音追跡をしない | ◎ |
| 1-7 | US 6,134,330 Ultra bass | Philips / 1999 | 失効（2012） | 20–70Hz の倍音生成+70–100Hz を増幅 | 失効 | ◎ |
| 1-8 | US 5,930,373（Waves MaxxBass） | Waves / 1997 | 満了 | 低域基音ごとに倍音列（残差ハーモニクス）を生成 | 満了 | ◎ |
| 1-9 | US 7,577,259 Band extension with higher harmonic generator | Panasonic→IP Bridge / 2004 | 失効（Fee Related） | 高次倍音生成→**振幅変調 80–100%**→BPF→原音に加算（帯域拡張） | 失効。当方は AM 変調を使わない | ◎ |
| 1-10 | US 11,102,577 Stereo virtual bass enhancement | **Waves Audio / 2018（〜2038 有効）** | **有効** | 多チャンネルで**チャンネルごとに倍音生成し、ラウドネスを低域 ch に合わせ ILD/ITD（方向手がかり）を保持**して高域信号と加算 | 当方 LF ブルームは疑似低音用ではなく、ILD/ITD 補償も無い（トラック内の軽い飽和）。構成要件を満たさない | ○ |
| 1-11 | US 9,319,789 Bass enhancement | **TC Group→Music Tribe / 2009（〜2032 有効・復活）** | **有効** | 入力に既にある**低域の倍音**を検出し、低域レベル上昇に応じてその帯域のゲインを上げ、**中心周波数を上方シフト**、帯域幅も可変 | 当方は倍音の検出も、レベル連動の中心周波数シフトも無い | ○ |
| 1-12 | US 9,236,842 Bass enhancement system（US20130163784） | **DTS / 2012（〜2033 有効）** | **有効** | 低域の**倍音を「入力信号の利用可能ヘッドルームに基づく」クリッピングで生成**+スピーカ寸法に応じた EQ+ヘッドルーム変化に応じた適応ゲイン | 当方 `colorStage` の LF ブルームは tanh による固定量の飽和で、**ヘッドルーム連動・スピーカ寸法設定が無い**。ただし「低域を飽和して倍音を作る」点は近い | △ |
| 1-13 | US 20080049950 Nonlinear processor（Poletti） | 個人 / 2007 | **放棄（2012）** | 2 経路の非対称歪+AC 結合対称歪+加算 | 放棄済み。当方は 2 経路構成ではない | ◎ |

深掘り所見:
- 非対称バイアス（偶数次）と DC ブロックは教科書的手法で、これを単独で請求する現行特許は見つからなかった。
- 現行有効の倍音系特許（1-10, 1-11, 1-12）はすべて **「小型スピーカ向けの低域補償」** の文脈で、
  ヘッドルーム連動・ILD 保持・倍音検出といった**当方が持たない特徴**が構成要件。
- 公開前のコメント/UI で「bass extension」「スピーカで再現できない低域を補う」「ヘッドルームに応じて自動」といった
  **用途表現を避ける**（ミックスの音色付けであることを明確にする）。
- 検索の限界: 高域倍音（HF エキサイタ）で有効な個別特許は、今回の検索では見つからなかった。ただし網羅検索ではない。

### カテゴリ2: 真空管/アナログ機器のエミュレーション（サチュレーション）

当方: `tube.ts`（12AX7 風ワンノブ）、`tubeeq.ts`（真空管段+EQ）、ストリップ `driveStage`（非対称 tanh+FET 風コンプ）。
いずれも静的/準静的な `tanh(x·g + bias)` 系で、オーバーサンプリングや微分方程式ソルバは使っていない。

| # | 特許 | 権利者 | 状態 | 請求の要点 | 比較 | 判定 |
| --- | --- | --- | --- | --- | --- | --- |
| 2-1 | US 8,165,309 System and method for simulation of non-linear audio equipment | Softube / 2004 | **失効（2024-05 不払い）** | 動的非線形内の複数の静的非線形関数を**モード推定（振幅/エネルギー/ピーク）で切り替え**、チェビシェフ多項式展開 | 失効。当方はモード切替の非線形を持たない | ◎ |
| 2-2 | US 8,271,109 Distortion and tube amp emulation | 個人（M. N. Gallo） / 2007 | 失効（Fee Related） | 閾値比較+除算型クリップ関数+数値積分ソルバ | 失効。当方は除算型ショルダ `a/(1+\|a\|)` を使うが権利は失効 | ◎ |
| 2-3 | US 8,275,477 Digital power tube amp emulator | 個人（M. N. Gallo） / 2009 | 失効（Fee Related） | 上記+フィードバック網+暗黙的台形則ソルバ | 失効 | ◎ |
| 2-4 | US 9,633,812 Triode tube emulator circuit | W. Senski / 2016 | 有効 | **アナログ回路**（ハードウェア）の請求 | ソフトウェア DSP は請求範囲外の見込み | ○ |
| 2-5 | US 4,995,084 / 5,133,014 / 5,434,536 / 5,734,725 | 各社 / 1989–1990年代 | 満了 | 半導体による真空管エミュレーション | 満了 | ◎ |
| 2-6 | US 10,725,727 Digital emulation with tolerance modeling | Brainworx / 2016 | **有効（〜2038）** | 前節 B の通り（公差付き素子モデル+乱数+標準値/乱数値 2 回エミュ+GUI） | `vary` は素子モデルも公差範囲も GUI も無い。`tubeeq.ts` の per-instance dither も同様 | △（運用ルール維持） |

深掘り所見:
- `vary` は「係数に ±0.3% 程度の固定ディザを一度だけ乗せ、非表示・非永続」。TMT の核である
  「素子ごとの公差範囲」「標準値と乱数値の二重エミュレーション」「ユーザー提示」に該当しない。
- Softube / Gallo は失効済みなので、`tanh`+バイアス+プリエンファシスの組み合わせで当たる現行特許は見つからなかった。
- 追加で守る: コード/UI に **tolerance / component / variation seed / channel number** を持ち込まない。

### カテゴリ3: トランジェント強調（Awaker の Punch）

当方: HF 帯の `envFast`（瞬間アタック）と `envSlow` の差で `trans = max(0, envF − envS)` を作り、ゲイン `1 + punch·trans/envS`（上限 punchMax）を wet に乗せる。

| # | 対象 | 調査結果 | 判定 |
| --- | --- | --- | --- |
| 3-1 | SPL Transient Designer（Differential Envelope Technology, DET） | **DET は登録商標**。特許番号は検索で特定できず（US 6,566,915 は無関係な通信用検出器）。商品は 1998 年頃 | △（未確認。"Differential Envelope" を名称に使わない） |
| 3-2 | US 5,424,488 Aphex（再掲） | 満了 | ◎ |
| 3-3 | Elysia nvelope / Sonnox Envolution | 特許番号を特定できず | ○（未確認） |

深掘り所見:
- 「速い/遅いエンベロープの差分でトランジェントを検出」は DET の説明と**概念が重なる**。ただし当方は閾値なしの差分を
  **HF 帯域内のゲイン増幅**に使っており、ドライ全域のアタック/サステイン操作ではない。
- 追加調査の候補: SPL の独国・欧州特許。Google Patents では見つからなかったため、商用化前に確認。

### カテゴリ4: リミッタ / マキシマイザ（`MAXIMIZER_WGSL`）

当方: 約 1.5 ms ルックアヘッド（遅延線）、ステレオリンクのピーク検出、`gt = ceiling/peak`、`gHold`（遅いリリースのピークホールド）、
アタック/リリース係数で平滑化した `gEnv` を遅延後の信号に乗算、最後に `clamp`。**単段**。

| # | 特許 | 権利者 | 状態 | 請求の要点 | 比較 | 判定 |
| --- | --- | --- | --- | --- | --- | --- |
| 4-1 | US 8,488,811 Audio-peak limiting in slow and fast stages | **Dolby / 2007（〜2030 有効）** | **有効** | **第 1 段: 変化率制限のゆっくりしたゲイン → 遅延 → 第 2 段: 1.5 ms ルックアヘッドで速いゲイン**（二段構成） | 当方は**単段**で、遅い先行ゲイン段が無い | △ |
| 4-2 | US 9,661,438 Low latency limiter | Amazon / 2015 | 失効（Fee Related） | 遅延 0.5–2.5 ms、目標ゲイン=閾値/ピーク、アタック→ホールド(0.4–1 ms)→リリース(70–300 ms) | 当方の構成は近い（`ceiling/peak`、約 1.5 ms）が、権利は失効 | ◎ |
| 4-3 | US 11,496,099 Systems and methods for limiter functions | Mimi Hearing / 2020（〜2041 有効） | **有効** | ブロック単位で**後方パス→前方パス**の 2 パスでゲイン輪郭を作る（瞬時上昇/緩やか減衰） | 当方は**サンプル逐次**で後方パスなし | △ |
| 4-4 | US 7,391,875 Peak-limiting mixer | Waves / 2004 | 満了（2025-01） | ミックス前にトラック別に平滑減衰を計算し、全体でピーク制限 | 満了 | ◎ |
| 4-5 | US 5,737,434 Multi-band compressor with look-ahead clipper | 1990 年代 | 満了 | ルックアヘッドクリッパ | 満了 | ◎ |

深掘り所見:
- ルックアヘッド・ブリックウォールの基本方式は古く、直接の現行特許は見当たらない。
- **Dolby の二段方式（4-1）と Mimi の 2 パス（4-3）が現行有効**。今後トゥルーピーク/ISP 対応や滑らかさ改善で
  「先行する遅いゲイン段」や「ブロック内の後方→前方パス」を足すと近づく。

### カテゴリ5: コンプレッサ（バスコンプ / ストリップ FET 風）

当方: `buscomp`（ステレオリンク ピーク検出、ソフトニー、段階値のレシオ/アタック/リリース、**Auto リリース**=
`slam` による速い/遅いリリース係数のブレンド、後段の bright drive、パラレルミックス）。ストリップの FET 風はフィードバック検出（前サンプル出力）+プログラム依存リリース。

| # | 特許 | 権利者 | 状態 | 請求の要点 | 比較 | 判定 |
| --- | --- | --- | --- | --- | --- | --- |
| 5-1 | US 6,944,305 Audio dynamics processing control system | J. K. Waller / 2001 | 失効（2017） | 速い時定数の検出信号を閾値でクランプして長い時定数の DC を生成、差動制御 | 失効 | ◎ |
| 5-2 | US 7,532,730（同系） | Waller | 要確認 | 完全プログラム依存のアタック/リリース | アナログ回路。当方は係数補間 | ○ |
| 5-3 | US 8,842,852 Exponential release response | **Waller（個人） / 2011（〜2032 有効）** | **有効** | 速い/遅い時定数の**差分**を対数検波→カレントミラーで**指数リリース電流**、約 1 V の不感帯 | アナログ回路の請求。当方は係数ブレンドで、電流源・不感帯なし | ○ |
| 5-4 | US 11,641,183 Integration release window | **Ear Physics / 2019（〜2039 有効）** | **有効** | 速い時定数の制御信号を**積分リリースウィンドウ**（指定 dB 減衰するまで遅いリリースを更新しない）で条件付け | 当方の `slam` ブレンドは dB しきい値で遅い側を保留する仕組みを持たない | ○ |
| 5-5 | US 5,444,788 Compressor combining feedback and feedforward sidechain | 1990 年代 | 満了見込み（要確認） | フィードバック+フィードフォワード検出の併用 | — | ○ |

深掘り所見:
- 5-3/5-4 は「速い/遅い 2 本の時定数信号を比較して release を制御する」という**考え方が Auto release に近い**。
  当方は単一の検出器+リリース係数の補間なので構成要件が異なる。
  ただし **「速い検出信号と遅い検出信号の差分でリリースを切り替える」実装に変えない**こと。

### カテゴリ6: EQ（`eq5.ts`, ストリップ EQ, `tubeeq.ts` の Pultec 型）

| # | 特許/技術 | 状態 | 比較 | 判定 |
| --- | --- | --- | --- | --- |
| 6-1 | RBJ biquad（Audio EQ Cookbook） | 公知。特許なし | 当方 5 バンドの基盤 | ◎ |
| 6-2 | US 6,581,080 Digital filters / US 7,831,645 Digital resonant shelf filter | 年代的に満了と見られる（個別の状態は未確認） | シェルフの Nyquist 付近整合。当方は RBJ で補正なし | ○ |
| 6-3 | Pultec EQP-1A「ブースト+アッテン同時」 | 設計は 1951 年。有効な特許なし。**商標**（Pultec / EQP-1A）のみ注意 | `tubeeq.ts` は 4 つの RBJ biquad+真空管段 | ◎（特許）/ △（商標） |

### カテゴリ7: リバーブ / ディレイ（`reverb.ts`, `delay.ts`）

| # | 対象 | 状態 | 判定 |
| --- | --- | --- | --- |
| 7-1 | Freeverb（Jezar、パブリックドメイン。Schroeder/Moorer のコム+オールパス） | 基礎特許は満了、実装は PD | ◎ |
| 7-2 | FDN（Jot, 1997）系 | 当方は FDN ではなくコム+オールパス | ◎ |
| 7-3 | US 8,204,240 Apparatus and method for artificial reverberation | Fraunhofer。FDN 系の請求と見られ、当方の構成とは別（未精査） | ○ |
| 7-4 | フィードバック・ディレイ+ダンピング+クロスフィード | 一般的。有効な特許は検索で見つからず | ○ |

### カテゴリ8: サンプルレート変換（`resample-gpu.ts`）

| # | 特許 | 状態 | 比較 | 判定 |
| --- | --- | --- | --- | --- |
| 8-1 | US 5,274,372 Sampling rate conversion using polyphase filters with interpolation | 1990 年代出願で満了 | 当方は窓付き sinc のポリフェーズ FIR（64 tap） | ◎ |
| 8-2 | US 6,531,969 / US 7,920,078 / US 8,117,039 | 2000 年代。US 8,117,039（多段再帰フレームベース リサンプリング+時間写像）は要確認 | 当方は単段。多段再帰ではない | ○（要確認） |
| 8-3 | GPU 実装 | 学術論文あり。GPU リサンプラ特許は検索で見つからず | — | ○ |

### カテゴリ9: GPU オーディオ処理・波形表示

| # | 特許 | 権利者 | 状態 | 比較 | 判定 |
| --- | --- | --- | --- | --- | --- |
| 9-1 | US 12,026,518 | Braingines SA（GPU Audio 関連） | 有効（〜2042） | 前節 A の通り。GPU 内スケジューラ/依存カウンタ/階層キューを当方は持たない | △（設計ルール） |
| 9-2 | US 9,165,394 GPU audio output on GPU | 要確認（古い出願で満了見込み） | GPU から音声を出力する話で、DSP とは別 | ○ |
| 9-3 | US 10,204,187 Data reduction for waveform data | **Cadence（EDA） / 2015（〜2036 有効）** | 電子設計の波形ビューア向け。X 軸スライスごとに first/last/min/max を残して GPU に渡す。当方のピーク(min/max)化は DAW 表示の定番手法でスライス+min/max は同型だが、請求は EDA 文脈（スライス幅・線太さによる適応等）の可能性 | △（要精査） |
| 9-4 | US 5,634,020 / US 5,675,778 | 1990 年代 | 満了 | ◎ |

深掘り所見:
- 9-3: 当方は「サンプルを GPU 上でピーク化し、描画はユニフォーム更新のみ」。特許は CPU 側で間引いてから GPU に渡す方式なので
  別方式の可能性が高いが、**独立請求項の全文は未読**。公開前に精読する。

### カテゴリ10: コントロールサーフェス / MIDI（`mcu.ts`）

| # | 対象 | 調査結果 | 判定 |
| --- | --- | --- | --- |
| 10-1 | Mackie Control (MCU) プロトコル | 検索で特許は見つからず（独自仕様として広く実装される）。商標: Mackie / iCON | ○（特許）/ △（商標） |

### カテゴリ11: DAW 基本機能（非破壊編集・フェード・パンチ録音）

| # | 対象 | 調査結果 | 判定 |
| --- | --- | --- | --- |
| 11-1 | 非破壊クリップ/フェード/テイク録音 | 古い Avid/Digidesign 系は満了。有効な個別特許は検索で特定できず（US 8,600,529 Audio fade control 等は未精査） | ○（未確認） |

### カテゴリ12: AI / MCP による DAW 操作

| # | 対象 | 調査結果 | 判定 |
| --- | --- | --- | --- |
| 12-1 | MCP/LLM で DAW を操作 | 登録特許は見つからず（DAWZY、openDAW MCP など OSS・論文のみ）。出願中公報は網羅できていない | ○（未確認） |

---

## 4. 総括（更新）

**現行コードで抵触の恐れ(×)はなし。** 要注意(△)は、いずれも「今後こう変更すると近づく」という設計ルールで回避する性質のもの:

| ID | 内容 | 守るルール |
| --- | --- | --- |
| 1-12 | DTS: ヘッドルーム連動で低域倍音を生成 | LF ブルームを入力ヘッドルームや「再生系の限界」に連動させない。「bass extension」用途表現を避ける |
| 2-6 / B | Brainworx TMT | `vary` を公差/素子/チャンネル番号/シードと結び付けない。ユーザー選択にしない |
| 4-1 | Dolby 二段リミッタ | マキシマイザに「先行する遅いゲイン段」を足さない |
| 4-3 | Mimi 2 パス | ブロックの後方→前方 2 パスでゲイン輪郭を作る実装にしない |
| 3-1 | SPL DET | "Differential Envelope" を名称に使わない。要追加確認 |
| 9-1 / A | Braingines GPU スケジューラ | GPU 内に依存グラフ/優先度キュー/カウンタ式スケジューラを作らない |
| 9-3 | Cadence 波形データ削減 | 請求項を精読（未実施） |

### 未完了（次にやること）
- 9-3（US 10,204,187）の独立請求項の全文精読。
- 5-2 US 7,532,730、5-5 US 5,444,788、6-2 US 6,581,080 / 7,831,645、7-3 US 8,204,240、8-2 US 8,117,039、9-2 US 9,165,394、11-1 US 8,600,529 の状態/請求の確認。
- SPL / Elysia の独国・欧州特許（Transient Designer）。
- 本調査は Google Patents の要約＋請求項抜粋に基づく。**法的結論ではない**。商用化前に弁理士の FTO を推奨。

### 出典（追加分）
- https://patents.google.com/patent/US5424488A/en （Aphex、満了）
- https://patents.google.com/patent/US6275593 / https://patents.google.com/patent/US5524074 / https://patents.google.com/patent/US6792115
- https://patents.google.com/patent/US5841875A/en （Yamaha）
- https://patents.google.com/patent/US6134330 （Philips）
- https://patents.google.com/patent/US11102577 （Waves、有効）
- https://patents.google.com/patent/US9319789B1/en （TC/Music Tribe、有効）
- https://patents.google.com/patent/US20130163784 （DTS、US9236842B2、有効）
- https://patents.google.com/patent/US7577259 （Panasonic、失効）
- https://patents.google.com/patent/US8165309B2/en （Softube、失効）
- https://patents.google.com/patent/US8271109B2/en / https://patents.google.com/patent/US8275477B2/en （Gallo、失効）
- https://patents.google.com/patent/US20080049950A1/en （放棄）
- https://patents.google.com/patent/US8488811 （Dolby、有効）
- https://patents.google.com/patent/US9661438 （Amazon、失効）
- https://patents.google.com/patent/US11496099 （Mimi、有効）
- https://patents.google.com/patent/US7391875 （Waves、満了）
- https://patents.google.com/patent/US6944305 / https://patents.google.com/patent/US8842852 / https://patents.google.com/patent/US11641183 （Waller 系）
- https://patents.google.com/patent/US10204187 （Cadence）

---

## 5. 追加調査: IR（コンボリューション）/ 物理モデリング（GPGPU インストルメント向け）

調査日: 2026-10-08。同じ簡易調査（Google Patents の要約＋請求項抜粋）。法的結論ではない。

### カテゴリ13: IR / コンボリューション・リバーブ・キャビネット IR

| # | 特許/技術 | 権利者 | 状態 | 請求の要点 | 判定 |
| --- | --- | --- | --- | --- | --- |
| 13-1 | US 5,502,747 Filtering with short flow-through delay | Lake DSP→Dolby / 1993 | **満了（2013）** | 小さな成分フィルタを異なる遅延で並列に動かし、短い遅延の時間領域+FFT の高速畳み込みを組み合わせる（**不均一パーティション畳み込みの原特許**） | ◎ |
| 13-2 | US 6,625,629 Signal processing using an improved convolution technique | Microsoft / 2000 | **満了（2020）** | IR をブロック分割し FFT、入力 DFT とスペクトル乗算＋オーバーラップ加算、最適パーティションを動的計画法で探索 | ◎ |
| 13-3 | US 11,611,839 Optimization of convolution reverberation | **Square Enix / 2021（〜2041 有効）** | **有効** | 入力と IR を FFT し、**IR 周波数ビンの 30〜90% をゼロにして**（約 −60 dB 未満を間引き）乗算 | △（要回避） |
| 13-4 | 均一パーティションのオーバーラップ・セーブ/アド（FFT 畳み込み） | 教科書的技術 | 特許対象外 | — | ◎ |
| 13-5 | GPU 畳み込みリバーブ | 学術（DAFx 等）・GPU Audio 社の製品 | 特許は検索で特定できず（GPU Audio の系列は前述 A に注意） | ○ |
| 13-6 | キャビネット IR 取り込み（2 IR 方式など） | Kemper 等 | IR 技術自体は特許化されていない旨の報道。個別特許は特定できず | ○（未確認） |

深掘り所見:
- **当方で作るなら**: 均一または二段階の分割 FFT 畳み込み（教科書的）で、IR は**間引かない**（周波数ビンのゼロ化をしない）。
  Lake の不均一パーティションは満了しており、使っても問題ない。GPU 実装は「バッチで複数ブロックを同時に FFT/乗算」するだけで、
  GPU 内スケジューラ（A の特許）には踏み込まない。
- 回避ルール: **IR の周波数ビンを閾値で間引く最適化を入れない**（13-3）。

### カテゴリ14: 物理モデリング（弦・管・モーダル）

| # | 特許/技術 | 権利者 | 状態 | 請求の要点 | 判定 |
| --- | --- | --- | --- | --- | --- |
| 14-1 | US 4,649,783 Wavetable-modification（Karplus-Strong） | Stanford / 1984 | **満了（2004）** | ランダム初期化ウェーブテーブルを平均してフィードバック | ◎ |
| 14-2 | デジタル導波管合成（Smith / Stanford）関連 | Stanford→Yamaha | 初期特許は**満了**（Stanford/Yamaha 1989 契約、VL1 は 1994）。Wikipedia 等「初期特許はすべて満了」 | ◎ |
| 14-3 | US 5,248,844 Waveguide type tone synthesizer | Yamaha / 1990 | **満了（2010）** | 励振部＋双方向伝送系のフィードバック（管楽器など） | ◎ |
| 14-4 | モーダル合成（IRCAM Modalys 系の概念） | 学術 | 概念は公知（モード周波数＋減衰の和） | ◎ |
| 14-5 | 商用物理モデル（Modartt Pianoteq、AAS、Korg Z1/Prophecy、Roland 2009 など） | 各社 | 個別の登録特許は今回の検索では特定できず。**2000 年代以降の個別実装特許が有効な可能性は残る** | ○（未確認） |

深掘り所見:
- 弦（Karplus-Strong / 導波管）、管（導波管）、モーダル合成は**基礎特許が満了**しており、アルゴリズムとして実装して問題が出にくい。
- リスクが残るのは「特定の楽器の特定の実装（ハンマー-弦の接触モデル、ピアノのソフトペダル等）」。**既存製品の再現を目指さず、
  汎用の弦/管/モーダルの組み合わせとして作る**ことで、個別特許との重複を避けやすい。
- GPU との相性: モーダル合成は「モード数×フレーム」で和を取るだけなのでシンセ（`SYNTH_WGSL`）と同じ設計（ステートレス）にできる。
  導波管/Karplus-Strong は再帰（遅延線のフィードバック）なのでノート単位で直列、ノート間を並列にする。

### 追記: 設計ルール（案）
- IR 畳み込み: IR の周波数ビン間引き（ゼロ化）をしない。
- 物理モデル: 既存製品の再現（名称・モデル構造の模倣）を目指さず、汎用の弦 / 管 / モーダルとして実装する。商標名を使わない。

### 出典
- https://patents.google.com/patent/US5502747 （Lake/Dolby、満了）
- https://patents.google.com/patent/US6625629 （Microsoft、満了）
- https://patents.google.com/patent/US11611839 （Square Enix、有効）
- https://patents.google.com/patent/US4649783A （Karplus-Strong、満了）
- https://patents.google.com/patent/US5248844 （Yamaha 導波管、満了）
