# ボート競技ライブリザルト - 開発用コマンド集
.PHONY: help test watch status master

help:  ## このヘルプを表示
	@grep -E '^[a-z]+:.*##' Makefile | awk -F':.*## ' '{printf "  %-12s %s\n", $$1, $$2}'

test:  ## E2Eテストを実行
	python3 test/e2e_test.py

watch: ## CSV watchモードを起動（ブラウザ確認あり）
	python3 tools/watch.py --serve

status: ## システム状態を確認
	python3 tools/check_status.py

master: ## サンプルCSVからmaster.jsonを再生成
	python3 tools/generate_master.py \
		--schedule test/csv/schedule_sample.csv \
		--entries  test/csv/entries_sample.csv  \
		--output   data/master.json \
		--tournament "大会名をここに入力" \
		--dates "2025-06-07,2025-06-08" \
		--venue "会場名" \
		-y

pipeline: ## テストCSVからrace JSONを生成
	python3 tools/simulate_pipeline.py --csv test/csv/

push-test: ## テストCSVを処理してGitHubにPush（TOKEN必須）
	@test -n "$(TOKEN)" || (echo "使い方: make push-test TOKEN=ghp_xxx" && exit 1)
	python3 tools/simulate_pipeline.py --csv test/csv/ --push --token $(TOKEN)
