# AutoRouter（AutoDock）逆向报告

- 目标文件：`AutoRouter_0_f43m.dmg`（19,739,251 B）
- SHA-256：`58bb9d776cb17540f6753f8e3d2a3c093f5bf5b9fbb665ea913052f4036fd746`
- MD5：`54db0dc7c3ad4194466b4d38dc6a4a91`
- 分析方式：纯静态（7z 解 UDIF/HFS+、rabin2/strings、Mach-O 签名 blob 解析）。未动态运行（VM 无 macOS 运行时）。
- 日期：2026-11-06

## 一句话本质

AutoRouter 是一个 macOS 菜单栏常驻应用：它改写 Claude Code / Codex（及实验性 Claude Desktop）的配置，把模型请求引到自己的路由层，再按任务把每个 turn 分发到「你已付费的订阅（Claude / ChatGPT 计划）」或「它家 credits 计费的各家模型」上，主打省钱——轻任务走便宜模型，重任务才上顶配。内部代号 **AutoDock**。

## 身份与版本

| 项 | 值 |
|---|---|
| 对外名 | AutoRouter |
| 内部名/主程序 | AutoDock（模块名、bundle、源码路径均为 AutoDock） |
| 版本 | 0.1.73，build 1964 |
| Bundle ID | `local.auto.dock.installed` |
| 最低系统 | macOS 14.0 |
| 签名 | Developer ID Application: **Fractal Works, Inc. (9239Y57329)**，带 Apple 时间戳（2026-11-05 23:47 UTC 签发） |
| 沙盒/Entitlements | **无**（签名 superblob 内无 entitlements blob）——非沙盒应用 |
| 构建信息 | commit `b9f0261009e6`，builtAt 2026-11-05T23:46:46Z，branch detached（见 `AutoBuild.json`） |
| DMG | UDIF，卷名 AutoRouter，2026-11-05 23:48 制作；注释 `Auto-0` |
| 官网/仓库线索 | autorouter.com；strings 含 `github.com/fractal-works/autorouter#readme`、联系人 `team@` / `nadav@autorouter.com` |

注：`AutoBuild.json` 声明的 `executableSHA256`（1bd3aafa…）与实际主程序全文件及 x86_64/arm64 两切片的 SHA-256 均对不上——可能是签名/打包前哈希，未证实，仅记录。

## 技术栈

- 原生 **Swift**（stripped，universal：x86_64 + arm64），UI 为 SwiftUI + AppKit；`LSUIElement=true`（无 Dock 图标，菜单栏/HUD 形态）。
- 链接框架要点：Sparkle（自动更新）、ServiceManagement（登录项/服务注册）、Security（Keychain + RSA）、LocalAuthentication、**Accessibility（AXUIElement 全套，含 PerformAction/SetAttributeValue）**、**ScreenCaptureKit + CGWindowList**、Network、SQLite3、libcompression/zstd。
- 第三方 SDK：**Datadog**（RUM/崩溃，`libddsdkcpp.dylib` + clientToken `pubf475c…`、site us5、crashAppId `d8977b72-…`）、**PostHog**（`phc_AGuh…`、us.i.posthog.com，含推送订阅功能）、**Foglamp HUD**（`hud.foglamp.dev/hud/events`、`/api/storm`）。
- 附带小工具（Node .mjs）：`claude-status.mjs`（Claude Code 状态行渲染 + 会话标记）、`session-probe-status.mjs`（无障碍探针用会话标记）。
- 第二个二进制：`AutoRouterCleanup`（468 KB，Swift）——卸载清理器。

## 工作原理

### 1. 改配置接管 agent

对每个接入的 agent 做带标记的托管改写，改前备份、卸载还原：

- **Claude Code**（`~/.claude`，`--claude-home`）：
  - `ANTHROPIC_BASE_URL=http://127.0.0.1:8787`（本地回环端点 `http://127.0.0.1:8787/v1`）或托管 API（Info.plist `AutoHostedAPIURL=https://api.autorouter.com`，env `AUTO_HOSTED_API_URL` 可覆盖）
  - 注入 apiKeyHelper 凭证助手（`CLAUDE_CODE_API_KEY_HELPER_TTL_MS`、`AUTO_CLAUDE_CREDENTIAL_HELPER`）——由它按需向 AutoRouter 取当前凭证
  - 在模型选择器里加虚拟模型 **`auto-claude-route`**，选中即走路由
  - 接管 statusLine 为自带 `claude-status.mjs`，原状态行命令存入 `AUTO_CLAUDE_PREVIOUS_STATUS` 链式调用；状态行输出 `AutoRouter session: claude_code:<uuid>` 供它识别会话
  - 备份文件：`claude-settings-before-auto.json`；env 标记一组 `AUTO_CLAUDE_PREVIOUS_* / AUTO_CLAUDE_STATUS_*`
- **Codex**（`~/.codex`，`--codex-home`）：托管 `config.toml`（备份 `config-before-auto.toml`），写入网关 provider 段（`# BEGIN/END AUTO MANAGED PROVIDER / FEATURES / ROOT SETTINGS` 标记块）、`cli_auth_credentials_store = "file"`；还通过 Codex app-server（stdio）读会话索引（`session_index.jsonl`）、用量；甚至用无障碍**操作 Codex 桌面应用的 composer UI 切换模型**（`CodexComposerControl/ModelReader`）。
- **Claude Desktop**（实验性）：走 Claude Desktop 第三方推理（3P）配置（`~/Library/Application Support/Claude-3p`）：`inferenceGatewayBaseUrl` + `inferenceCredentialHelper`（含 TTL/超时/静默刷新字段）；托管模式下需 credential helper；另能把 claude.ai 上加的 connectors（MCP）同步进桌面版（调用 `api.anthropic.com/v1/mcp_servers`）。
- 自身数据目录：`~/Library/Application Support/Auto/`（`claude-target.json`、`codex-target.json`、`generated/` 下 model-catalog、engine-models、credential-helper 等）与 `~/.autorouter/routing-history/v1`（本地路由历史缓存）。

### 2. 路由决策

- 客户端向托管 API 请求/缓存决策：`v1/routing-decisions`、`v1/routing-sessions`、`v1/routing-feedback`，本地有 `RoutingDecisionCache`。
- 推理本身经网关转发：`v1/messages`（Anthropic 形态，含 `count_tokens`）、`v1/responses`（OpenAI 形态）、`v1/inference-requests`；模型目录由服务端下发：`v1/model-catalog`、`v1/catalog`、`v1/model-overrides`。
- 可写自然语言**路由规则**（RoutingRule/RoutingPolicyEditor，reason 图标集对应任务类型：写代码、修 bug、搜索、设计、视频、图表、实验、写作等）；企业规则字符串显示有隐私分级设计：受限上下文只能走组织批准的私有端点、无可用端点时 **fail closed 不转发公共模型**、私有端点优先于个人省钱偏好（此为客户端内置策略文案/示例，服务端实际执行未验证）。
- 每轮结束有 👍/👎 反馈（「Good/Not the right routing pick」）用于改进路由；HUD 悬浮窗实时显示选了哪个模型、理由、费用。
- 省钱账的算法（原文）：每 turn 按 API 价算两遍——实际所选模型的价格 vs 该应用顶配模型（Codex 里 GPT-6 Astra、Claude Code 里 Claude Fable 5.1）的价格，差额即「节省」；比顶配更贵的 turn 记 $0。

### 3. HUD 与会话识别

- 一个浮在 agent 窗口旁的「handle」+ 展开 HUD（Foglamp HUD）：用 Accessibility 遍历目标应用窗口树定位终端 pane，读状态行打出的 `AutoRouter session: claude_code:<uuid>` 标记把「窗口 ↔ 会话」对上号；Ghostty 可免权限匹配，其他终端需**屏幕录制**权限（ScreenCaptureKit）；Orca 终端有专门支持（`orca-runtime.json`）。
- 会读 Claude 转录（`~/.claude/projects/**/*.jsonl`）、Codex 会话索引与两家本地用量，做成本/用量估算（`CodexUsageCollector`、订阅周用量按会话均摊的估算逻辑）。

## 订阅凭证机制（最敏感的部分）

卖点「AutoRouter runs models through the subscriptions you already pay for」靠的是**托管授权（hosted grants）**：

- 你在应用里连入自己的 **Claude 订阅**与 **ChatGPT 计划**（OAuth：`claude.com/cai/oauth/authorize` + `platform.claude.com/v1/oauth/token`；`auth.openai.com/oauth/*`）。AutoRouter 自家账号体系走 **WorkOS**（`auth-api.autorouter.com`），也支持「Sign in with ChatGPT」（SIWC，`direct/openai-siwc/`）；字符串明确：ChatGPT **Business/Enterprise/Edu 不支持 SIWC、只收个人 Plus/Pro**。
- 相关 API：`v1/provider-grants`（+`/activation`）、`v1/credential-keys`、`v1/installation-credential`、`v1/claude-desktop-credential`、`v1/codex-gateway-credential`、`v1/subscription-accounts`（含 **`/sharing`**）、`v1/subscription-usage`、`v1/chatgpt-plans/`。
- 凭证保护动作（客户端可见）：本地存 Keychain（`SecItem*`，AfterFirstUnlockThisDeviceOnly）；与服务端交换时用 **RSA-OAEP-SHA256 加密**（`SecKeyCreateEncryptedData`），凭证密钥清单带 **RSA 签名校验**（`SecKeyVerifySignature`）；各 API 客户端普遍带 RedirectGuard（拒绝重定向，防凭证被 30x 带走）。
- 即：设计上不是明文裸传，但本质仍是**把个人订阅的 OAuth 凭证托管给第三方服务端**，由其服务端以你的计划额度发起推理；且存在订阅**共享**（sharing）接口。与 Anthropic/OpenAI 个人计划条款的兼容性属灰区——产品自己也只敢接个人计划并明确排除企业计划，此风险在服务端实现与条款解释，未在客户端证实违规，仅提示性质。

## 商业模式

- **Credits**：订阅覆盖外的模型按 credits 计费（美元充值，`v1/credits/checkout` 走 Stripe checkout/billing；金额 $5–$10,000）；**Pro** 档解锁 credits 计费模型；文案含「$20 of usage each month」「$50/mo」片段（具体档位以官网为准，客户端未完整证实）。
- 免费额度/增长：邀请奖励 $20、试用 credits、做任务赚 credits（Credits quests：如在 X 上发帖 `Tag @auto_router`、Slack 等，审核后到账，`v1/credits/grants`、`v1/account/invite-*`）。
- 企业版：seats、共享 credit、管理员控制、组织托管配置（`/Library/Managed Preferences`、MDM 风格的 ManagedConfigurationInstaller）。

## 数据与外连清单

外连域名（全部为其自家或功能必需）：

- 自家：`api.autorouter.com`、`auth-api.autorouter.com`、`app.autorouter.com`、`updates.autorouter.com`（Sparkle 更新源，EdDSA 公钥 `IWJ4xQxmdjJ8n3HyfZx4wR0AQxYIerJsiiM9hCKQYlM=`，每小时自动检查+自动更新）、`autorouter.com`
- 提供商：`api.anthropic.com`、`platform.claude.com`、`claude.com`、`api.openai.com`、`auth.openai.com`、`api.workos.com`
- 遥测：Datadog（us5）、PostHog（us，含远程推送订阅）、Foglamp HUD
- 本地：`127.0.0.1:8787`（自身回环服务）、`localhost:11434`（Ollama，可选本地模型端点）

未发现：硬编码的提供商 API 密钥（仅有 `sk-ant` 前缀字符串，应为格式识别用）、可疑外传域名（pastebin/网盘/IM webhook 等均无）。

数据读取面（本地）：两家 agent 的配置、会话索引、转录 jsonl、用量；终端窗口无障碍树；窗口列表。应用内诊断报告自述「contains request metadata and demo events, not prompt/response bodies or credentials」（其诊断导出功能的文案）。

**但须注意**：托管模式下推理请求（`v1/messages` / `v1/responses`）经其网关转发——你的 prompt 与代码内容必然过它的服务器，这是网关型产品的结构性事实，与诊断报告是否含正文是两回事。

## 更新与卸载

- 更新：Sparkle appcast（`https://updates.autorouter.com/appcast.xml`），自动检查间隔 3600s、自动更新开。
- 卸载：`AutoRouterCleanup` 经 `~/Library/LaunchAgents/local.auto.dock.cleanup.plist` 触发，带 `--claude-home/--codex-home/--claude-desktop-home/--app/--data` 参数，逐项剥离各 agent 配置中的 AUTO 托管段、恢复原模型与原状态行（「# Model before AutoRouter」「# AutoRouter previous status」注释即还原依据），并删自身数据。设计上是可逆的。

## 风险评级（实话版）

1. **信任集中**：无沙盒 + 可写多家 agent 配置 + 无障碍可读可点其他应用 UI + 持有你双份订阅 OAuth 凭证（托管在它服务端）+ 全部 prompt 过它网关。任何一环出事（服务端被入侵、内部滥用、条款封号），影响面都很大。这不是说它作恶——签名正规（Fractal Works, Inc. Developer ID + 公证时间戳）、客户端防护细节（重定向拒绝、RSA 加密/验签、fail-closed 文案）显示工程上是认真的——而是说**它的权限面本身就是风险**。
2. **条款灰区**：个人订阅转托管/共享给网关代跑，与两家个人计划的「本人使用」条款存在张力；封号风险由用户自担的可能性高。
3. **遥测面宽**：Datadog RUM + 崩溃、PostHog 行为分析 + 推送、Foglamp HUD 事件，三套并行；`AUTO_POSTHOG_ENABLED` 等 env 显示可关，但默认开。
4. **小瑕疵**：`AutoBuild.json` 的 executableSHA256 与实际二进制对不上（见上）。

## 未验证事项

- 服务端路由算法、计费与凭证保管实现（闭源在云端，客户端只能看到接口与决策结果）。
- 动态行为（权限弹窗顺序、实际流量）未跑：需 macOS 真机安装验证。
- Pro 价格档位全貌、企业版细节以官网为准。
