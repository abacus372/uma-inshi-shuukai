# 因子周回スキル差分チェッカー

ウマ娘の因子周回サポートツール。

- レース場（競馬場・コース）を1つ選ぶ
- 「本育成用」「因子周回用」それぞれの編成（サポカ最大6枚）を入力する
- 因子周回用の編成でしか取得できず、かつ選んだレース場でそもそも発動しうるスキルだけを一覧表示する

## 使い方

`index.html` をブラウザで開くだけ（サーバー不要）。編成の枠をクリックするとサムネイル画像付きのサポカ選択モーダルが開く（検索・レア度/タイプ絞り込み可）。同名・同レア度・同タイプのカードでも画像が違うので判別できる。編成とレース場は「この内容を保存」でブラウザのlocalStorageに保存され、次回開いたときに復元される。

## データソース

- サポカのヒントスキル一覧・スキル名・スキル発動条件: [daftuyda/UmaTools](https://github.com/daftuyda/UmaTools) の `assets/support_hints.json` / `assets/skills_all.json`。GameToraを1〜3日おきに自動スクレイピングしているので随時最新に近い（`alpha123/uma-skill-tools` の `skill_data.json` は2026年3月から更新が止まっていたため乗り換えた）。
- コース形状・競馬場名（芝/ダート・距離・回りなど、ゲーム内容更新の影響を受けない静的データ）: `Z:\stacalc-local\uma-skill-tools`（[alpha123/uma-skill-tools](https://github.com/alpha123/uma-skill-tools)）の `data/course_data.json`, `data/tracknames.json`
- `build-data.js` が上記から `data/*.json` / `data/*.js` を生成する（縮小・整形用）。データを最新化したい場合は、まずスクリプト冒頭のcurlコマンド2本で `support_hints.json` / `skills_all.json` を再取得してから再実行する。
- サポカのサムネイル画像: `download-thumbs.js` が同じくUmaToolsの `assets/support_thumbs/*.png` を `data/thumbs/` にダウンロードする（553枚・約6.7MB）。新しいカードが増えたら再実行すればよい（既存ファイルはスキップされる）。

## 判定ロジックの制限

スキルの発動条件文字列（例: `ground_type==2&phase==1&blocked_side_continuetime>=2`）のうち、以下の変数だけを見て「発動しうるか」を判定している。

コースを選んだ時点で確定するもの:
- `ground_type`（芝/ダート）
- `distance_type`（距離区分: 短距離/マイル/中距離/長距離）
- `track_id`（競馬場）
- `course_distance`（距離ぴったり指定）
- `rotation`（右/左/直線）
- `is_dirtgrade`（地方競馬場ダート扱いか）

「詳細条件」で指定した場合のみ確定するもの（未指定なら常に「満たしうる」扱い）:
- `running_style`（脚質。逃げ⇔大逃げは同一視するゲーム側の仕様も反映済み）
- `season`（季節）
- `ground_condition`（馬場状態）
- `weather`（天気）

それ以外の条件（コーナー、直線、順位、HPなど、展開や馬の作り次第でどうにでもなるもの）は常に「満たしうる」として扱い、除外条件には使っていない。そのため「有効」判定はやや甘め（=見逃しは少ないが、実際は発動しにくいスキルも混ざりうる）。
