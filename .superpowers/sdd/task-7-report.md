# Task 7 Report: Foundation公開APIと文書

## 実装

- `@pear-agent/core` package import smoke testを追加し、`defineDomain`、`evaluateGoalCompletion`、`transitionStep`、`validatePlanGraph`が関数として公開されることを確認した。
- `packages/core/src/index.ts`は着手時点ですでに`goal`、`actor`、`plan`、`step-state`、`domain`を明示的にbarrel exportしていたため、変更不要だった。
- `packages/core/README.md`を追加し、Install、最小Domain定義、DAG検証、Step状態導出、後続Phaseの境界を記載した。
- ルートREADMEにFoundation公開型とCore READMEへの導線を追加した。
- `docs/domain-contract.md`を現行`ExecutionDomainDefinition`に合わせ、未実装の`authorize`を例から除外し、後続Phaseの保証をFoundation保証から分離した。
- 公開型名を`ExecutionGoal`、`ExecutionActor`、`ExecutionPlan`、`ExecutionStep`、`StepStatus`、`ExecutionDomainDefinition`へ統一した。

## Review minor

- Capability schemaの正常系parseテストを追加した。
- `stepStatesSchema`から推論した`StepStates`を公開した。
- `deriveStepStatuses()`の入力を`ExecutionStep`のmutableな`Pick`から、`readonly id` / `readonly after`だけを持つ軽量な公開`StepDependency`へ変更した。`as const`のDAG入力を受け付ける型検査で確認した。

## TDD記録

1. package import smoke test、Capability正常系、`StepStates` / readonly DAG入力テストを先に追加した。
2. `pnpm --filter @pear-agent/core typecheck`を実行し、`StepStates`未公開とreadonly `after`非対応で失敗することを確認した。
3. `StepStates`と軽量readonly `StepDependency`を実装した。
4. 対象テスト33件とcore typecheckの成功を確認した。
5. Capability正常系テストはZod function schemaが関数wrapperを返すため、公開契約に即してフィールドと関数性を検証する形へ修正した。

## 検証

- `pnpm test`: 7 files / 49 tests passed
- `pnpm typecheck`: core、outing-domainともに成功
- `pnpm lint`: Oxlint成功
- `git diff --check`: 成功
- Oxfmt: 変更対象7ファイルを整形。全体`oxfmt --check .`は今回未変更の既存文書8件を含む9件の既存format差分を検出するため、リポジトリ全体のcheckは未達。ただし変更対象は整形済み。
- `rg "ExecutionStep|ExecutionGoal|defineDomain|StepStatus" README.md docs packages/core/README.md`: 公開型名の不整合なし。

## 自己レビュー

- package smoke testはpackage exports経由でimportしており、相対importだけでは検出できないbarrel回帰を検出する。
- `StepDependency`は状態導出に必要な2フィールドだけに限定し、既存の実行時挙動は変更していない。
- Foundationが保証しない永続化、Voice、AI SDK、認可等を公開READMEとDomain Contractで明示した。
- Cloudflare、React、Gemini、AI SDKへの依存追加なし。

## 懸念点

- packageは現在`private: true`かつexportsがTypeScript source直参照であり、公開registry配布用build設定は後続作業が必要。
- リポジトリ全体のOxfmt checkは既存文書のformat差分により失敗する。
