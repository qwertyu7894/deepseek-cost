/**
 * deepseek-cost — DeepSeek 余额 & 费用实时监控插件（pi / pi-web）
 *
 * 功能：
 *   1. 💳 密钥实时余额：调用 DeepSeek 官方 /user/balance API，定时自动刷新
 *   2. ⛰️/🌙 高峰/空闲时段识别（北京时间 9:00–12:00、14:00–18:00 为高峰，空闲半价）
 *   3. 📊 每轮消费统计：缓存命中 / 未命中 / 输出逐项计费（按消息发生时刻的时段价格）
 *   4. 💵 本场累计消费
 *   5. 🔴 低余额提醒：低于阈值时状态栏红色标记 + 一次性通知（恢复后重置）
 *
 * 计费口径（DeepSeek 官方价格，¥/1M tokens）：
 *   - 缓存命中输入 cacheRead × 命中价
 *   - 缓存未命中输入 input × 输入价
 *   - 输出 output × 输出价
 *   高峰时段为北京时间 9:00–12:00、14:00–18:00，空闲时段为高峰半价。
 *
 * 配置：~/.pi/agent/extensions/deepseek-cost/deepseek-cost.config.json
 *   {
 *     "providerId": "deepseek",          // 余额查询所用 provider id
 *     "balanceRefreshMs": 60000,         // 余额刷新间隔（毫秒）
 *     "peakWindows": [[9,12],[14,18]],   // 高峰时段（北京小时，含头不含尾）
 *     "lowBalanceThreshold": 10,         // 低余额阈值（¥），低于此值提醒
 *     "lowBalanceNotify": true,          // 是否弹出通知
 *     "prices": { ... }                  // 覆盖/新增模型价格表
 *   }
 *
 * 命令：
 *   /dsrefresh  立即刷新余额
 *   /dscost     查看余额拆分与本轮逐项计费明细
 */
import type {
  ExtensionAPI,
  ExtensionContext,
  MessageEndEvent,
  TurnStartEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import type { Model, Usage } from "@earendil-works/pi-ai";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/* ============================== 配置 ============================== */

interface PriceEntry {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite?: number;
}

interface PeakPriceEntry {
  peak: PriceEntry;
  offpeak: PriceEntry;
}

interface Config {
  providerId: string;
  balanceRefreshMs: number;
  peakWindows: Array<[number, number]>;
  lowBalanceThreshold: number;
  lowBalanceNotify: boolean;
  prices: Record<string, PeakPriceEntry | PriceEntry>;
}

/** DeepSeek 官方人民币价格（¥/1M tokens） */
const DEFAULT_PRICES: Record<string, PeakPriceEntry | PriceEntry> = {
  "deepseek-v4-flash": {
    peak: { input: 3, output: 9, cacheRead: 0.1, cacheWrite: 0 },
    offpeak: { input: 1.5, output: 4.5, cacheRead: 0.05, cacheWrite: 0 },
  },
  "deepseek-v4-pro": {
    peak: { input: 9, output: 27, cacheRead: 0.3, cacheWrite: 0 },
    offpeak: { input: 4.5, output: 13.5, cacheRead: 0.15, cacheWrite: 0 },
  },
  "deepseek-chat": { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 },
  "deepseek-reasoner": { input: 4, output: 16, cacheRead: 1, cacheWrite: 0 },
};

const DEFAULT_CONFIG: Config = {
  providerId: "deepseek",
  balanceRefreshMs: 60_000,
  peakWindows: [
    [9, 12],
    [14, 18],
  ],
  lowBalanceThreshold: 10,
  lowBalanceNotify: true,
  prices: DEFAULT_PRICES,
};

const CONFIG_PATH = join(
  homedir(), ".pi", "agent", "extensions", "deepseek-cost", "deepseek-cost.config.json",
);

function loadConfig(): Config {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<Config>;
      return {
        ...DEFAULT_CONFIG,
        ...raw,
        prices: { ...DEFAULT_PRICES, ...(raw.prices ?? {}) },
      };
    }
  } catch {
    // 配置损坏时回退默认（不打印 error.message，避免日志暴露本地绝对路径/用户名）
    console.error("[deepseek-cost] 配置文件解析失败，已使用默认配置");
  }
  return DEFAULT_CONFIG;
}

const config = loadConfig();

// key 以 z 开头：扩展 status 按 key 字母排序，保证排在其他状态（如 MCP）右侧
const STATUS_KEY = "z-deepseek-cost";

/* ============================== 时段 ============================== */

/** 判断某时刻是否为高峰时段（北京时间，含头不含尾） */
function isPeakTime(date: Date): boolean {
  const bj = new Date(date.getTime() + 8 * 3600_000); // UTC+8
  const minutes = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  return config.peakWindows.some(
    ([start, end]) => minutes >= start * 60 && minutes < end * 60,
  );
}

function peakLabel(peak: boolean): string {
  return peak ? "⛰️" : "🌙";
}

/** 精简价格显示：3.00→3，1.50→1.5，0.10→0.1 */
function fmtPrice(v: number): string {
  return v.toFixed(2).replace(/\.?0+$/, "");
}

/* ============================== 状态 ============================== */

interface Totals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costCny: number; // 按时段官方价计算的成本（人民币）
}

function emptyTotals(): Totals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costCny: 0 };
}

interface BalanceState {
  currency: string;
  total: string;
  granted: string;
  toppedUp: string;
  fetchedAt: number;
  error?: string;
}

function emptyBalance(): BalanceState {
  return {
    currency: "CNY",
    total: "—",
    granted: "—",
    toppedUp: "—",
    fetchedAt: 0,
  };
}

/* ============================== 工具 ============================== */

function formatCNY(v: number): string {
  if (v === 0) return `¥0`;
  if (v >= 100) return `¥${v.toFixed(2)}`;
  if (v >= 1) return `¥${v.toFixed(3)}`;
  if (v >= 0.01) return `¥${v.toFixed(4)}`;
  return `¥${v.toFixed(5)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${Math.round(n)}`;
}

/** 取某模型的时段单价：官方价格表 > 模型 cost（USD×7.2）> null */
function getPrice(
  model: Model<any> | undefined,
  date: Date,
): { price: PriceEntry | null; peak: boolean } {
  const peak = isPeakTime(date);
  const entry = model ? config.prices[model.id] : undefined;
  if (entry) {
    const p = "peak" in entry ? (peak ? entry.peak : entry.offpeak) : entry;
    return { price: p, peak };
  }
  const cost = model?.cost;
  if (cost && (cost.input > 0 || cost.output > 0 || cost.cacheRead > 0)) {
    const rate = 7.2; // 美元→人民币估算汇率
    return {
      price: {
        input: cost.input * rate,
        output: cost.output * rate,
        cacheRead: cost.cacheRead * rate,
        cacheWrite: 0,
      },
      peak,
    };
  }
  return { price: null, peak };
}

/** 按单价计算一条 usage 的成本（¥） */
function calcCostCny(usage: Usage, price: PriceEntry): number {
  const sum =
    (usage.input ?? 0) * price.input +
    (usage.output ?? 0) * price.output +
    (usage.cacheRead ?? 0) * price.cacheRead +
    (usage.cacheWrite ?? 0) * (price.cacheWrite ?? 0);
  return sum / 1_000_000;
}

/** 解析余额数值；无效时返回 null */
function parseBalanceTotal(balance: BalanceState): number | null {
  if (balance.fetchedAt === 0 || balance.error) return null;
  const v = parseFloat(balance.total);
  return Number.isFinite(v) ? v : null;
}

/** 错误消息安全化：HTTP 错误只显示状态码，其余截断，避免回显敏感片段 */
function sanitizeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const status = msg.match(/HTTP (\d{3})/)?.[1];
  if (status) return `HTTP ${status}`;
  const trimmed = msg.replace(/[\r\n]+/g, " ").trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 80)}…` : trimmed;
}

/* ============================== 插件工厂 ============================== */

export default function (pi: ExtensionAPI) {
  let sessionTotals: Totals = emptyTotals();
  let turnTotals: Totals = emptyTotals();
  let currentModel: Model<any> | undefined;
  let balance: BalanceState = emptyBalance();
  let balanceTimer: ReturnType<typeof setInterval> | undefined;
  let lowBalanceNotified = false;

  /** 拉取 DeepSeek 官方余额，并触发低余额提醒 */
  async function refreshBalance(ctx: ExtensionContext): Promise<void> {
    try {
      // 安全校验：只允许 baseUrl 指向 DeepSeek 官方的 provider 发起余额请求，
      // 防止 providerId 误配时把其他 provider 的 API key 发送到非 DeepSeek 地址
      const provider = ctx.modelRegistry.getProvider(config.providerId);
      const providerBaseUrl = provider?.baseUrl ?? "";
      if (!/deepseek\.com/i.test(providerBaseUrl)) {
        balance = { ...emptyBalance(), error: `provider ${config.providerId} 非 DeepSeek` };
        updateUI(ctx);
        return;
      }
      const auth = await ctx.modelRegistry.getProviderAuth(config.providerId);
      const key = auth?.auth?.apiKey;
      if (!key) {
        balance = { ...emptyBalance(), error: `no-key(${config.providerId})` };
        updateUI(ctx);
        return;
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const res = await fetch("https://api.deepseek.com/user/balance", {
          method: "GET",
          headers: { Authorization: `Bearer ${key}` },
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as {
          is_available?: boolean;
          balance_infos?: Array<{
            currency?: string;
            total_balance?: string;
            granted_balance?: string;
            topped_up_balance?: string;
          }>;
        };
        const info = (data.balance_infos ?? []).find((b) => b.currency === "CNY")
          ?? (data.balance_infos ?? [])[0];
        balance = {
          currency: info?.currency ?? "CNY",
          total: info?.total_balance ?? "—",
          granted: info?.granted_balance ?? "—",
          toppedUp: info?.topped_up_balance ?? "—",
          fetchedAt: Date.now(),
        };
      } finally {
        clearTimeout(timeout);
      }
    } catch (e) {
      balance = {
        ...emptyBalance(),
        error: sanitizeError(e),
      };
    }
    checkLowBalance(ctx);
    updateUI(ctx);
  }

  /** 低余额提醒：低于阈值时状态栏红色标记 + 一次性通知（恢复后重置） */
  function checkLowBalance(ctx: ExtensionContext): void {
    const bal = parseBalanceTotal(balance);
    if (bal === null) return;
    const low = bal < config.lowBalanceThreshold;
    if (low) {
      if (!lowBalanceNotified) {
        lowBalanceNotified = true;
        if (config.lowBalanceNotify) {
          ctx.ui.notify(
            `⚠️ DeepSeek 余额不足：¥${balance.total}（低于 ¥${config.lowBalanceThreshold}），请及时充值`,
            "warning",
          );
        }
      }
    } else {
      lowBalanceNotified = false;
    }
  }

  function isLowBalance(): boolean {
    const bal = parseBalanceTotal(balance);
    return bal !== null && bal < config.lowBalanceThreshold;
  }

  function updateUI(ctx: ExtensionContext): void {
    const peak = isPeakTime(new Date());
    const money = formatCNY(sessionTotals.costCny);
    const turnMoney = formatCNY(turnTotals.costCny);
    const turnTokens =
      turnTotals.input + turnTotals.output + turnTotals.cacheRead + turnTotals.cacheWrite;
    const cachePct = turnTokens > 0 ? Math.round((turnTotals.cacheRead / turnTokens) * 100) : 0;

    // 余额文本（低余额时红色标记）
    let balanceText = "❓";
    if (balance.error) {
      balanceText = "⚠️";
    } else if (balance.fetchedAt > 0) {
      const low = isLowBalance();
      balanceText = low ? `🔴¥${balance.total}` : `¥${balance.total}`;
    }

    // 状态栏一行（底部最右端）：余额 + 当前时段（高峰期/非高峰期）+ 本轮 + 累计
    const peakText = peak ? "⛰️高峰期" : "🌙非高峰期";
    const line =
      `💳${balanceText} ${peakText} 本轮${turnMoney}·缓存${cachePct}% 累计${money}`;
    ctx.ui.setStatus(STATUS_KEY, line);
  }

  /** 事件入口：按消息时刻的时段价格计费并累加 */
  function handleUsage(ctx: ExtensionContext, usage: Usage | undefined, when: Date): void {
    if (!usage) return;
    const { price } = getPrice(currentModel, when);
    if (price) {
      const cny = calcCostCny(usage, price);
      turnTotals.costCny += cny;
      sessionTotals.costCny += cny;
    }
    turnTotals.input += usage.input ?? 0;
    turnTotals.output += usage.output ?? 0;
    turnTotals.cacheRead += usage.cacheRead ?? 0;
    turnTotals.cacheWrite += usage.cacheWrite ?? 0;
    sessionTotals.input += usage.input ?? 0;
    sessionTotals.output += usage.output ?? 0;
    sessionTotals.cacheRead += usage.cacheRead ?? 0;
    sessionTotals.cacheWrite += usage.cacheWrite ?? 0;
    updateUI(ctx);
  }

  /* ------------------------------ 生命周期 ------------------------------ */

  pi.on("session_start", async (_event, ctx) => {
    sessionTotals = emptyTotals();
    turnTotals = emptyTotals();
    currentModel = ctx.model;
    balance = emptyBalance();
    lowBalanceNotified = false;

    // 从会话历史重建累计（按消息时间戳还原当时时段价格）
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const msg = entry.message;
      if (msg.role !== "assistant" && msg.role !== "toolResult") continue;
      const usage = (msg as { usage?: Usage }).usage;
      if (!usage) continue;
      const when = new Date((msg as { timestamp?: number }).timestamp ?? entry.timestamp ?? Date.now());
      const { price } = getPrice(currentModel, when);
      if (price) sessionTotals.costCny += calcCostCny(usage, price);
      sessionTotals.input += usage.input ?? 0;
      sessionTotals.output += usage.output ?? 0;
      sessionTotals.cacheRead += usage.cacheRead ?? 0;
      sessionTotals.cacheWrite += usage.cacheWrite ?? 0;
    }

    // 立即刷新余额，随后定时刷新
    await refreshBalance(ctx);
    if (balanceTimer) clearInterval(balanceTimer);
    if (config.balanceRefreshMs > 0) {
      balanceTimer = setInterval(() => {
        refreshBalance(ctx).catch(() => {});
      }, config.balanceRefreshMs);
      if (typeof balanceTimer.unref === "function") balanceTimer.unref();
    }
  });

  pi.on("model_select", (event, ctx) => {
    currentModel = event.model;
    updateUI(ctx);
  });

  pi.on("turn_start", (_event: TurnStartEvent, _ctx) => {
    turnTotals = emptyTotals();
  });

  pi.on("message_end", (event: MessageEndEvent, ctx) => {
    if (event.message.role !== "assistant") return;
    const usage = (event.message as { usage?: Usage }).usage;
    handleUsage(ctx, usage, new Date());
  });

  pi.on("tool_result", (event: ToolResultEvent, ctx) => {
    handleUsage(ctx, event.usage, new Date());
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (balanceTimer) {
      clearInterval(balanceTimer);
      balanceTimer = undefined;
    }
    ctx.ui.setStatus(STATUS_KEY, undefined);
    ctx.ui.setWidget(STATUS_KEY, undefined);
  });

  /* ------------------------------ 命令 ------------------------------ */

  pi.registerCommand("dsrefresh", {
    description: "刷新 DeepSeek 余额显示",
    handler: async (_args, ctx) => {
      await refreshBalance(ctx);
      if (balance.error) {
        ctx.ui.notify(`余额刷新失败：${balance.error}`, "error");
      } else if (isLowBalance()) {
        ctx.ui.notify(`⚠️ DeepSeek 余额：¥${balance.total}（低于 ¥${config.lowBalanceThreshold}，建议充值）`, "warning");
      } else {
        ctx.ui.notify(`DeepSeek 余额：¥${balance.total}`, "info");
      }
    },
  });

  pi.registerCommand("dscost", {
    description: "显示余额与本轮逐项计费明细",
    handler: async (_args, ctx) => {
      updateUI(ctx);
      const now = new Date();
      const peak = isPeakTime(now);
      const { price } = getPrice(currentModel, now);
      const hit = turnTotals.cacheRead;
      const miss = turnTotals.input;
      const out = turnTotals.output;
      let msg = `${peakLabel(peak)} ${peak ? "高峰" : "空闲"}时段`;
      if (balance.fetchedAt > 0 && !balance.error) {
        const low = isLowBalance();
        msg += `\n💳 余额：${low ? "🔴 " : ""}¥${balance.total}` +
          (balance.toppedUp !== "—" || balance.granted !== "—"
            ? `（充值 ¥${balance.toppedUp} + 赠送 ¥${balance.granted}）`
            : "") +
          (low ? `\n⚠️ 低于阈值 ¥${config.lowBalanceThreshold}，建议充值` : "");
      }
      msg += `\n本轮 ${formatCNY(turnTotals.costCny)} · 累计 ${formatCNY(sessionTotals.costCny)}`;
      if (price) {
        msg += `\n缓存命中 ${formatTokens(hit)} × ¥${fmtPrice(price.cacheRead)}/M = ${formatCNY((hit * price.cacheRead) / 1_000_000)}`;
        msg += `\n未命中 ${formatTokens(miss)} × ¥${fmtPrice(price.input)}/M = ${formatCNY((miss * price.input) / 1_000_000)}`;
        msg += `\n输出 ${formatTokens(out)} × ¥${fmtPrice(price.output)}/M = ${formatCNY((out * price.output) / 1_000_000)}`;
      }
      ctx.ui.notify(msg, "info");
    },
  });
}
