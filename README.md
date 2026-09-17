# pi-quota-widget

A [pi coding agent](https://pi.dev) extension that shows a live usage & quota widget above the editor:

- **GLM Coding Plan quota** — 5-hour window and weekly credits, with reset countdowns. Works with **both** the international endpoint (`api.z.ai`) and the **China endpoint (`open.bigmodel.cn`)**, including `zai-coding-cn` accounts.
- **Session token stats** — cumulative input/output tokens, cache reads, request count, estimated cost, and context-window usage for the current session.
- **Optional multi-provider balances** — DeepSeek, Moonshot (Kimi), OpenRouter, SiliconFlow, or any custom endpoint.

```text
📊 glm-4.6 · ↑12.3k ↓4.5k · 18 次 · 缓存读 230k · ≈$0.0842
📦 上下文 34%（68.0k / 200.0k）
💰 5小时额度(LITE): 1,922/2,000 · 4.5小时后重置
💰 每周额度(LITE): 9,922/10,000 · 7天后重置
```

## Why this package?

GLM Coding Plan comes in two flavors: the international endpoint (`api.z.ai`) and the China endpoint (`open.bigmodel.cn`, provider id `zai-coding-cn`). Their APIs are similar but not identical — the China endpoint returns quota entries typed `CREDIT_LIMIT` with a `unit` field (`3` = hour-based window, `6` = weekly), while most existing tooling targets the international `TOKENS_LIMIT` format.

pi-quota-widget renders the raw `limits[]` array without type filtering, so it works with **both** response shapes — verified against a real `zai-coding-cn` (Lite plan) account.

## Install

```bash
pi install npm:pi-quota-widget
```

Or from git:

```bash
pi install git:github.com/gouzijing0821/pi-quota-widget
```

## Zero configuration for GLM

If you are logged in with `/login` (provider `zai-coding-cn`, `zai`, or `zai-coding`), the widget picks up your stored credentials automatically and queries the matching endpoint. Nothing to configure.

## Commands

| Command | Description |
|---|---|
| `/usage` | Refresh session stats (tokens, requests, context usage) |
| `/balance` | Refresh quota/balances; prints config help when nothing is configured |

## Optional: other providers

Create `~/.pi/agent/balance.json`:

```json
{
  "accounts": [
    { "name": "DeepSeek",    "api": "deepseek",    "apiKey": "$DEEPSEEK_API_KEY" },
    { "name": "Kimi",        "api": "moonshot",    "apiKey": "sk-..." },
    { "name": "OpenRouter",  "api": "openrouter",  "apiKey": "$OPENROUTER_API_KEY" },
    { "name": "SiliconFlow", "api": "siliconflow", "apiKey": "$SILICONFLOW_API_KEY" },
    { "name": "GLM 额度",     "api": "zhipu-quota", "provider": "zai-coding-cn" },
    {
      "name": "Custom", "api": "custom",
      "apiKey": "xxx", "url": "https://example.com/balance",
      "path": "data.balance", "currency": "¥"
    }
  ],
  "refreshMinIntervalMs": 30000
}
```

- `apiKey` values starting with `$` are read from environment variables.
- `provider` reuses credentials stored by pi's `/login` for that provider.
- Supported `api` kinds: `deepseek` · `moonshot` · `openrouter` · `siliconflow` · `zhipu-quota` (China) · `zhipu-quota-global` · `custom`.

## Refresh behavior

- Quota/balances refresh at session start and after each completed turn (rate-limited to one request per 30 s by default, configurable via `refreshMinIntervalMs`).
- Session token stats update after every assistant message — no extra API calls.

## Acknowledgements

- Endpoint and response-shape discovery credit: [gouzijing0821/dsh-ai-wallet](https://github.com/gouzijing0821/dsh-ai-wallet) (DeepSeek Harness plugin).

## License

MIT
