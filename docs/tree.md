# faostat-mcp-server - Directory Structure

Generated on: 2026-07-27 17:52:37

```text
faostat-mcp-server/
├── .claude/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .faostat-mirror/
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 0.1.x/
│   ├── 0.2.x/
│   └── template.md
├── docs/
│   └── design.md
├── scripts/
│   ├── _mirror-context.ts
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── faostat-mirror-init.ts
│   ├── faostat-mirror-refresh.ts
│   ├── faostat-mirror-verify.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── release-github.ts
│   └── tree.ts
├── skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   ├── resources/
│   │   │   └── definitions/
│   │   └── tools/
│   │       └── definitions/
│   │           ├── commodity-profile.tool.ts
│   │           ├── dataframe-describe.tool.ts
│   │           ├── dataframe-query.tool.ts
│   │           ├── list-domains.tool.ts
│   │           ├── query-observations.tool.ts
│   │           └── resolve-codes.tool.ts
│   ├── services/
│   │   ├── faostat-mirror/
│   │   │   ├── csv.ts
│   │   │   ├── dimensions-store.ts
│   │   │   ├── faostat-mirror.ts
│   │   │   ├── http.ts
│   │   │   ├── index.ts
│   │   │   ├── ingester.ts
│   │   │   ├── manifest.ts
│   │   │   └── types.ts
│   │   ├── canvas-accessor.ts
│   │   └── canvas-staging.ts
│   └── index.ts
├── tests/
│   ├── fixtures/
│   │   └── synthetic-domain.ts
│   ├── prompts/
│   ├── resources/
│   ├── services/
│   │   ├── csv.test.ts
│   │   ├── faostat-mirror-index.test.ts
│   │   ├── faostat-mirror.test.ts
│   │   ├── http-headers.test.ts
│   │   ├── ingester-parse.test.ts
│   │   └── manifest.test.ts
│   └── tools/
│       ├── commodity-profile-aggregation.test.ts
│       ├── commodity-profile-notice.test.ts
│       ├── commodity-profile-year-range.test.ts
│       ├── dataframe-canvas-id-optional.test.ts
│       ├── dataframe-describe-provenance.test.ts
│       ├── dataframe-query-reasons.test.ts
│       ├── error-contract.test.ts
│       ├── list-domains-pagination.test.ts
│       ├── query-observations-spillover.test.ts
│       ├── query-observations-validation.test.ts
│       ├── resolve-codes-domain-scope.test.ts
│       └── resolve-codes-pagination.test.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CITATION.cff
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
