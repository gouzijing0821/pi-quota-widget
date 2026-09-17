# Changelog

## 0.1.0 (2026-09-17)

- Initial release.
- GLM Coding Plan quota widget: 5-hour window + weekly credits with reset countdowns.
  - China (`open.bigmodel.cn`, `zai-coding-cn`) and global (`api.z.ai`) endpoints.
  - Auto-detects provider from pi `/login` credentials — zero config.
- Session token stats: input/output tokens, cache reads, request count, estimated cost, context-window usage.
- Optional multi-provider balances via `~/.pi/agent/balance.json`:
  `deepseek`, `moonshot`, `openrouter`, `siliconflow`, `zhipu-quota`, `zhipu-quota-global`, `custom`.
- Commands: `/usage`, `/balance`.
