/**
 * usage.ts — 在输入框上方实时显示会话用量 + 模型额度/余额
 *
 * 显示内容：
 *   📊 模型名 · ↑输入tokens ↓输出tokens · N 次 · ≈估算成本
 *   📦 上下文占用百分比
 *   💰 GLM Coding Plan 5小时/每周额度（自动检测 zai-coding-cn 等厂商，零配置）
 *   💰 其他厂商 API 余额（可选，配置 ~/.pi/agent/balance.json）
 *
 * GLM 额度说明：
 *   - 端点来自 dsh-ai-wallet（github.com/gouzijing0821/dsh-ai-wallet）
 *   - 国内: https://open.bigmodel.cn/api/monitor/usage/quota/limit
 *   - 国际: https://api.z.ai/api/monitor/usage/quota/limit
 *   - 已 /login 登录 zai-coding-cn / zai 的会自动复用凭据
 *
 * 余额配置（可选）~/.pi/agent/balance.json：
 * {
 *   "accounts": [
 *     { "name": "DeepSeek",    "api": "deepseek",    "apiKey": "$DEEPSEEK_API_KEY" },
 *     { "name": "Kimi",        "api": "moonshot",    "apiKey": "sk-..." },
 *     { "name": "GLM额度",     "api": "zhipu-quota", "provider": "zai-coding-cn" },
 *     { "name": "自定义",       "api": "custom", "apiKey": "xxx", "url": "https://...",
 *       "path": "data.balance", "currency": "¥" }
 *   ],
 *   "refreshMinIntervalMs": 30000
 * }
 * - apiKey 写 "$环境变量名" 表示从环境变量读取
 * - "provider" 指定复用 pi 已登录厂商的凭据（如 zai-coding-cn）
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// 额度/余额配置
// ---------------------------------------------------------------------------

type ApiKind =
  | "deepseek"
  | "moonshot"
  | "openrouter"
  | "siliconflow"
  | "zhipu-quota"        // 智谱国内 open.bigmodel.cn（Coding Plan 额度）
  | "zhipu-quota-global" // Z.ai 国际 api.z.ai（Coding Plan 额度）
  | "custom";

interface Account {
  name?: string;
  api: ApiKind;
  apiKey?: string;
  provider?: string; // 复用 pi 已登录厂商的凭据
  url?: string;
  path?: string;
  currency?: string;
}

interface BalanceConfig {
  accounts?: Account[];
  refreshMinIntervalMs?: number;
}

const BALANCE_CONFIG_PATH = join(homedir(), ".pi", "agent", "balance.json");
const WIDGET_ID = "usage";
const DEFAULT_MIN_INTERVAL = 30_000;

// pi provider id -> api kind，用于零配置自动检测
const PROVIDER_API: Record<string, ApiKind> = {
  "zai-coding-cn": "zhipu-quota",
  "zai-coding": "zhipu-quota-global",
  zai: "zhipu-quota-global",
  zhipu: "zhipu-quota",
  deepseek: "deepseek",
  moonshot: "moonshot",
  openrouter: "openrouter",
  siliconflow: "siliconflow",
};

const DEFAULT_URLS: Record<Exclude<ApiKind, "custom">, string> = {
  "zhipu-quota": "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
  "zhipu-quota-global": "https://api.z.ai/api/monitor/usage/quota/limit",
  deepseek: "https://api.deepseek.com/user/balance",
  moonshot: "https://api.moonshot.cn/v1/users/me/balance",
  openrouter: "https://openrouter.ai/api/v1/credits",
  siliconflow: "https://api.siliconflow.cn/v1/user/info",
};

function resolveKey(acc: Account): string | undefined {
  const raw = acc.apiKey;
  if (!raw) return undefined;
  if (raw.startsWith("$")) return process.env[raw.slice(1)];
  return raw;
}

function pickByPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => {
    if (o != null && typeof o === "object") return (o as Record<string, unknown>)[k];
    return undefined;
  }, obj);
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as unknown;
}

// ---------------------------------------------------------------------------
// 余额类（返回单行）
// ---------------------------------------------------------------------------

async function fetchBalance(acc: Account, apiKey: string | undefined): Promise<string> {
  if (!apiKey) throw new Error("缺少 API key");
  let url = acc.url;
  if (!url && acc.api !== "custom") url = DEFAULT_URLS[acc.api];
  if (!url) throw new Error("缺少 url");
  const data = await fetchJson(url, { Authorization: `Bearer ${apiKey}` });

  let amount = NaN;
  let currency = acc.currency ?? "";
  if (acc.api === "deepseek") {
    const info = pickByPath(data, "balance_infos.0") as
      | { currency?: string; total_balance?: string | number }
      | undefined;
    amount = Number(info?.total_balance);
    if (!currency) {
      currency =
        info?.currency === "CNY" ? "¥" : info?.currency === "USD" ? "$" : (info?.currency ?? "");
    }
  } else if (acc.api === "moonshot") {
    amount = Number(pickByPath(data, "data.available_balance"));
    currency ||= "¥";
  } else if (acc.api === "openrouter") {
    const credits = Number(pickByPath(data, "data.total_credits"));
    const usage = Number(pickByPath(data, "data.total_usage"));
    amount = credits - usage;
    currency ||= "$";
  } else if (acc.api === "siliconflow") {
    amount = Number(pickByPath(data, "data.balance"));
    currency ||= "¥";
  } else {
    if (!acc.path) throw new Error("custom api 需要配置 path");
    amount = Number(pickByPath(data, acc.path));
  }
  if (!Number.isFinite(amount)) throw new Error("解析失败");
  return `${currency}${amount.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// GLM Coding Plan 额度（返回多行：5小时窗口 + 每周额度）
// 响应结构参考 dsh-ai-wallet：
// { code: 200, data: { level: "lite", limits: [{ unit, number, usage,
//   currentValue, remaining, percentage, nextResetTime }] } }
// unit: 3 = 小时窗口, 6 = 周
// ---------------------------------------------------------------------------

interface ZhipuLimit {
  unit?: number;
  number?: number;
  usage?: number;
  currentValue?: number;
  remaining?: number;
  percentage?: number;
  nextResetTime?: number;
}

function quotaLabel(lim: ZhipuLimit): string {
  if (lim.unit === 3) return `${lim.number ?? 5}小时额度`;
  if (lim.unit === 6) return (lim.number ?? 1) === 1 ? "每周额度" : `${lim.number}周额度`;
  return `额度(${lim.unit ?? "?"}×${lim.number ?? "?"})`;
}

function fmtInt(n: unknown): string {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v).toLocaleString("en-US") : "?";
}

function fmtReset(ms?: number): string {
  if (!ms) return "";
  const diff = ms - Date.now();
  if (diff <= 0) return "已重置";
  const hours = diff / 3_600_000;
  if (hours < 1) return `${Math.max(1, Math.round(diff / 60_000))}分钟后重置`;
  if (hours < 48) return `${hours < 10 ? hours.toFixed(1) : Math.round(hours)}小时后重置`;
  return `${Math.round(hours / 24)}天后重置`;
}

async function fetchZhipuQuotaLines(acc: Account, apiKey: string | undefined): Promise<string[]> {
  if (!apiKey) throw new Error("缺少 API key");
  let url = acc.url;
  if (!url) url = DEFAULT_URLS[acc.api as Exclude<ApiKind, "custom">];
  if (!url) throw new Error("缺少 url");
  const data = (await fetchJson(url, { Authorization: `Bearer ${apiKey}` })) as {
    code?: number;
    msg?: string;
    data?: { level?: string; limits?: ZhipuLimit[] };
  };
  if (data?.code !== 200) throw new Error(data?.msg ?? `code ${data?.code}`);
  const limits = Array.isArray(data.data?.limits) ? data.data!.limits! : [];
  if (limits.length === 0) throw new Error("无额度数据");
  const plan = data.data?.level ? data.data.level.toUpperCase() : "GLM";
  return limits.map(
    (lim) =>
      `💰 ${quotaLabel(lim)}(${plan}): ${fmtInt(lim.remaining)}/${fmtInt(lim.usage)} · ${fmtReset(lim.nextResetTime)}`,
  );
}

/** 查询一个账户，返回要显示的行（余额 1 行，GLM 额度多行） */
async function fetchAccountLines(acc: Account, apiKey: string | undefined): Promise<string[]> {
  if (acc.api === "zhipu-quota" || acc.api === "zhipu-quota-global") {
    return fetchZhipuQuotaLines(acc, apiKey);
  }
  const s = await fetchBalance(acc, apiKey);
  return [`💰 ${acc.name}: ${s}`];
}

// ---------------------------------------------------------------------------
// 格式化工具
// ---------------------------------------------------------------------------

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtCost(n: number): string {
  return `$${n.toFixed(n >= 1 ? 2 : 4)}`;
}

interface ContextUsageInfo {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

// ---------------------------------------------------------------------------
// 扩展主逻辑
// ---------------------------------------------------------------------------

export default function usageExtension(pi: ExtensionAPI) {
  // 会话用量统计
  let stats = { input: 0, output: 0, cacheRead: 0, cost: 0, requests: 0 };
  let ctxUsage: ContextUsageInfo | undefined;
  let modelId = "";

  // 额度/余额状态
  let config: BalanceConfig = {};
  let accounts: Account[] = [];
  let balanceLines: string[] = [];
  let inflight: Promise<void> | null = null;
  let lastAuto = 0;

  function loadConfig() {
    config = {};
    try {
      if (existsSync(BALANCE_CONFIG_PATH)) {
        config = JSON.parse(readFileSync(BALANCE_CONFIG_PATH, "utf8")) as BalanceConfig;
      }
    } catch {
      // 配置损坏时按未配置处理
    }
    accounts = Array.isArray(config.accounts) ? config.accounts : [];
  }

  function minInterval(): number {
    return typeof config.refreshMinIntervalMs === "number"
      ? config.refreshMinIntervalMs
      : DEFAULT_MIN_INTERVAL;
  }

  function addUsage(u: Usage) {
    stats.input += u.input;
    stats.output += u.output;
    stats.cacheRead += u.cacheRead ?? 0;
    stats.cost += u.cost?.total ?? 0;
    stats.requests += 1;
  }

  /** 从会话历史全量重建统计（启动 / 恢复会话时） */
  function recountFromSession(ctx: ExtensionContext) {
    stats = { input: 0, output: 0, cacheRead: 0, cost: 0, requests: 0 };
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message" && entry.message.role === "assistant") {
        const u = (entry.message as { usage?: Usage }).usage;
        if (u) addUsage(u);
      }
    }
  }

  function render(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    const lines: string[] = [];

    let l1 = `📊 ${modelId || "…"} · ↑${fmtTokens(stats.input)} ↓${fmtTokens(stats.output)} · ${stats.requests} 次`;
    if (stats.cacheRead > 0) l1 += ` · 缓存读 ${fmtTokens(stats.cacheRead)}`;
    if (stats.cost > 0) l1 += ` · ≈${fmtCost(stats.cost)}`;
    lines.push(l1);

    if (ctxUsage?.percent != null) {
      lines.push(
        `📦 上下文 ${Math.round(ctxUsage.percent)}%（${fmtTokens(ctxUsage.tokens ?? 0)} / ${fmtTokens(ctxUsage.contextWindow)}）`,
      );
    }

    lines.push(...balanceLines);
    ctx.ui.setWidget(WIDGET_ID, lines);
  }

  async function refreshAccounts(ctx: ExtensionContext, opts: { force?: boolean } = {}) {
    if (accounts.length === 0) {
      balanceLines = [];
      return;
    }
    const now = Date.now();
    if (!opts.force && now - lastAuto < minInterval()) return;
    if (inflight) {
      if (opts.force) await inflight;
      return;
    }
    lastAuto = now;
    balanceLines = accounts.map((a) => `💰 ${a.name ?? a.api}: 刷新中…`);
    render(ctx);

    inflight = (async () => {
      const results = await Promise.all(
        accounts.map(async (a) => {
          try {
            const key =
              resolveKey(a) ??
              (a.provider
                ? await ctx.modelRegistry.getApiKeyForProvider(a.provider)
                : a.api !== "custom" && !a.api.startsWith("zhipu")
                  ? await ctx.modelRegistry.getApiKeyForProvider(a.api)
                  : undefined);
            return await fetchAccountLines(a, key);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return [`⚠️ ${a.name ?? a.api}: ${msg}`];
          }
        }),
      );
      balanceLines = results.flat();
      render(ctx);
    })().finally(() => {
      inflight = null;
    });

    await inflight;
  }

  /** 未配置时按当前模型的厂商自动检测 */
  function autoDetectAccounts(ctx: ExtensionContext) {
    const provider = ctx.model?.provider;
    const kind = provider ? PROVIDER_API[provider] : undefined;
    if (kind && provider) {
      accounts = [{ name: provider, api: kind, provider }];
    }
  }

  // ---------------------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    loadConfig();
    if (accounts.length === 0) autoDetectAccounts(ctx);
    recountFromSession(ctx);
    modelId = ctx.model?.id ?? "";
    ctxUsage = ctx.getContextUsage();
    render(ctx);
    await refreshAccounts(ctx, { force: true });
  });

  pi.on("model_select", async (event, ctx) => {
    modelId = event.model?.id ?? modelId;
    if (!config.accounts?.length) {
      autoDetectAccounts(ctx);
    }
    render(ctx);
  });

  // 每条 assistant 回复完成 → 实时累加
  pi.on("message_end", async (event, ctx) => {
    const m = event.message;
    if (m.role !== "assistant") return;
    const u = (m as { usage?: Usage }).usage;
    if (!u) return;
    addUsage(u);
    ctxUsage = ctx.getContextUsage() ?? ctxUsage;
    render(ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    ctxUsage = ctx.getContextUsage() ?? ctxUsage;
    render(ctx);
    await refreshAccounts(ctx);
  });

  pi.registerCommand("usage", {
    description: "刷新并显示会话用量统计",
    handler: async (_args, ctx) => {
      recountFromSession(ctx);
      modelId = ctx.model?.id ?? modelId;
      ctxUsage = ctx.getContextUsage();
      render(ctx);
      const parts = [
        `↑${fmtTokens(stats.input)} ↓${fmtTokens(stats.output)} tokens`,
        `${stats.requests} 次请求`,
      ];
      if (stats.cacheRead > 0) parts.push(`缓存读 ${fmtTokens(stats.cacheRead)}`);
      if (stats.cost > 0) parts.push(`≈${fmtCost(stats.cost)}`);
      ctx.ui.notify(parts.join(" · "), "info");
    },
  });

  pi.registerCommand("balance", {
    description: "刷新模型额度/余额（GLM 自动检测，其他需配置 balance.json）",
    handler: async (_args, ctx) => {
      loadConfig();
      if (accounts.length === 0) autoDetectAccounts(ctx);

      if (accounts.length === 0) {
        const msg = [
          "💰 已自动支持 GLM Coding Plan（zai-coding-cn / zai，复用 /login 凭据）",
          "其他厂商在 ~/.pi/agent/balance.json 配置，例如：",
          '{"accounts":[{"name":"DeepSeek","api":"deepseek","apiKey":"$DEEPSEEK_API_KEY"}]}',
          "支持: deepseek | moonshot | openrouter | siliconflow | zhipu-quota | custom",
        ];
        for (const m of msg) ctx.ui.notify(m, "info");
        return;
      }

      await refreshAccounts(ctx, { force: true });
      ctx.ui.notify(
        balanceLines.map((l) => l.replace(/^💰 /, "")).join("  ·  "),
        "info",
      );
    },
  });
}
