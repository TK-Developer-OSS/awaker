---
name: awaker-basics
description: Awaker を操作するときの基本。まず見る、値の範囲、まとめて呼ぶ、正直に報告する。どの依頼でも迷ったら最初に読む
---

# Awaker を操作する基本

## 順序

1. **触る前に見る**: `tracks_list`（トラック id、フェーダー、ストリップ、インサート）、`groups_list`、`stems_list`、`state_get`（再生状態、メーター）。
2. **変える**: 複数のトラックに同じ操作をするときは、**1 つのメッセージの中で tool call を並べる**（トラックごとにメッセージを分けない）。
3. **確かめる**: 変えたあとに、返ってきた値や `tracks_list` で実際の値を見る。数値で確かめられることは `bounce` / `track_levels` / `spectrum_analyze` で測る。

## 値の範囲

- トラックのフェーダー `gainDb`: -60〜+6（-60 = -∞）。パン `pan`: -1〜+1。
- マスターフェーダー `master_set`: -60〜+6。
- ストリップ: `trimDb`、`drive`（0〜1）、`hpfHz`（0 = オフ）、`eqOn` と `eq`（4 バンド）、`comp`（`on`、`threshDb`、`ratio`、`attackMs`、`releaseMs`、`makeupDb`）。
- インサートの EQ（eq5）は、`eq_apply` で触る。パラメータの配列を直接書き換えない。

## 報告

- 設定した値は、**ツールが返した値**で報告する。失敗したツールは「失敗した」と言う。
- アプリが「【実際に変わった設定】」を自分で測って表示する。説明がそれと食い違うと、そちらが正しい。
- あなたは音を聴けない。聴感の話をするときは「数値から言えること」と断る。
- 試しに変えたものは、元に戻して、そう言う。
- 依頼が曖昧で結果が変わるときは聞く。聞かずに進めるときは、どれを選んだか言う。

## しないこと

- 頼まれていないトラックの削除・ミュート・ソロ・クリップ編集。
- ファイルのパスを取る道具（読み込み・書き出し）は、アプリ内のアシスタントには許可されていない。
- 1 つの値を、一度に大きく動かさない（フェーダーは ±3 dB ずつ、EQ は ±3 dB ずつを目安に）。

## 道具の対応

| やりたいこと | 道具 |
| --- | --- |
| フェーダー・パン・ミュート・ソロ・出力先・色 | `track_set` |
| グループ（バス）の作成・変更 | `group_add` / `group_set` |
| ステム名 | `stem_set`、`stems_list` |
| チャンネルストリップ | `strip_set` |
| インサート（EQ-5 / Tube EQ / Awaker / Reverb / Delay、マスターは BusComp / Maximizer も） | `insert_add` / `insert_set` / `insert_remove` |
| 数値の確認 | `bounce`、`track_levels`、`spectrum_analyze` |
| ステムの書き出し | `stems_export` |
| ミックス全体を 1 本の WAV に（頼まれたときだけ） | `mixdown_export` |
| 過去の操作を見直す | `ops_log` |

詳しい手順は、仕事ごとのスキルにある（`skills_list`）: `ai-mix`、`stems-groups`、`mixing-basics`。
