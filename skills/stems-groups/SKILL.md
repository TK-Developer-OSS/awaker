---
name: stems-groups
description: トラックをグループ（バス）とステムにまとめる手順（ドラム / パーカッション / ベース / ギター / ボーカルなど）と、ステムの書き出し
---

# グループとステム

- **ステム** = トラックが持つ名前（`stem_set`）。同じ名前のトラックは、まとめて 1 本のファイルとして書き出される。
- **グループ** = ミキサー上のバス（`group_add`）。メンバーのトラックはここへ送られ、グループにフェーダー・パン・インサートを持てる。
- ミックスで EQ やコンプを足すなら、トラックごとではなく**グループ**に足すほうが少ない手数で済む。書き出しだけが目的ならステムだけでよい。
- 同じ名前・同じメンバーのステムとグループは、書き出しでは 1 つ（グループの出力）として扱われる。

## 手順

1. `tracks_list` でトラックの名前を全部見る。`groups_list` と `stems_list` で、すでにあるものも見る。
2. 名前から分類する（下の表）。迷うトラックは、一番ありそうなほうへ入れて、**報告に「どれを、どこへ、なぜ」を書く**。
3. 分類ごとに: `group_add { name, tracks: [...] }` → そのトラックそれぞれに `stem_set { track, stem: name }`。
4. `stems_list` と `groups_list` で、全員が入ったか確かめる。入っていないトラックは「どれが、どこにも入っていない」と報告する。

トラックの名前は変えない。クリップも触らない。色はアプリが自動で、グループとステムごとに合わせる。

## 分類の目安

| 名前 | 分類 |
| --- | --- |
| Kick / BD / Snare / SD / HiHat / HH / Tom / Overheads / OH / Room / Drum | **Drums** |
| Clap / Shaker / Tamb / Perc / Conga / Bongo / Cowbell / Triangle / Bells | **Percussion** |
| Bass / Sub / 808 | **Bass** |
| Gtr / Guitar / ElecGtr / AcGtr / Strum | **Guitars** |
| Keys / Piano / Organ / Synth / Pad / Strings | **Keys**（無ければ作らない） |
| Vox / Vocal / Lead / BGV / Backing / Harmony / Choir | **Vocals** |
| FX / Riser / Impact / Noise | **FX** |

- 同じ曲で、ドラムとパーカッションを分けるように言われたら、上の表のとおりに分ける。分けるよう言われなければ、パーカッションは Drums に入れてよい。
- 1 つのトラックは、1 つのグループにしか入れられない。

## 書き出し

`stems_export {}`（引数なしで、全ステムとグループ）。名前を絞るなら `stems: ["Drums", "Vocals"]`。
既定は Options → Export（24-bit WAV、プロジェクトのレート、ストリップとインサートを通す、マスターのチェーンは通さない）。
書き出し先のフォルダは、アプリ内のアシスタントからは決められない（Documents/Awaker/Stems の下に自動で作られる）。
結果の `verify` が、ステムの合計とミックスの一致の確認。`ok: false` ならそう報告する。
