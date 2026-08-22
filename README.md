# deepseek-cost

> DeepSeek 余额与费用实时监控插件（pi / pi-web 通用）

在 pi 状态栏（pi CLI 底部**最右端** / pi-web 顶栏）实时显示一行：

```
MCP: 0/11 servers ... 💳🔴¥6.67 🌙 本轮¥0.0014·缓存99% 累计¥0.0366
```

## 功能

| 功能 | 说明 |
|------|------|
| 💳 **密钥实时余额** | 调用 DeepSeek 官方 `/user/balance` API，默认每 60 秒自动刷新，会话启动立即拉取 |
| 🔴 **低余额提醒** | 余额低于阈值（默认 ¥10）时状态栏显示 🔴 红色标记，并弹一次性通知；恢复后自动解除 |
| ⛰️/🌙 **高峰/空闲时段** | 按北京时间识别：高峰 9:00–12:00、14:00–18:00，空闲为高峰半价 |
| 💹 **时段计价** | 每轮消费按消息发生时刻的时段价格计算（历史消息按时间戳还原时段） |
| 📊 **逐项计费** | 缓存命中（cacheRead）× 命中价 + 未命中（input）× 输入价 + 输出（output）× 输出价 |
| 💵 **累计消费** | 会话累计金额（支持中途加载时从会话历史重建） |

## 计费规则（DeepSeek 官方价格，¥/1M tokens）

| 模型 | 时段 | 缓存命中 | 输入(未命中) | 输出 |
|------|------|---------|------------|------|
| v4-flash | 高峰 | ¥0.10 | ¥3.0 | ¥9.0 |
| v4-flash | 空闲 | ¥0.05 | ¥1.5 | ¥4.5 |
| v4-pro | 高峰 | ¥0.30 | ¥9.0 | ¥27.0 |
| v4-pro | 空闲 | ¥0.15 | ¥4.5 | ¥13.5 |
| deepseek-chat | 固定 | ¥0.5 | ¥2.0 | ¥8.0 |
| deepseek-reasoner | 固定 | ¥1.0 | ¥4.0 | ¥16.0 |

高峰时段：北京时间 **9:00–12:00、14:00–18:00**（其余为空闲时段）。

## 安装

**方式一：扩展目录（最简单）**

把整个 `deepseek-cost/` 目录放到 `~/.pi/agent/extensions/`，重启 pi（或 `/reload`）即生效。

**方式二：pi 包安装**

```bash
pi install npm:deepseek-cost   # 发布后
# 或本地
pi install ./path/to/deepseek-cost
```

余额查询复用 pi 中 deepseek provider 的 API key（`models.json` / `auth.json` / 环境变量均可），**零额外配置**。

## 配置（可选）

在扩展目录下创建 `deepseek-cost.config.json`（参考 `deepseek-cost.config.example.json`）：

```json
{
  "providerId": "deepseek",
  "balanceRefreshMs": 60000,
  "peakWindows": [[9, 12], [14, 18]],
  "lowBalanceThreshold": 10,
  "lowBalanceNotify": true,
  "prices": {}
}
```

| 字段 | 默认 | 说明 |
|------|------|------|
| `providerId` | `"deepseek"` | 余额查询所用 provider id（取它的 API key） |
| `balanceRefreshMs` | `60000` | 余额自动刷新间隔（毫秒）；设 `0` 关闭自动刷新 |
| `peakWindows` | `[[9,12],[14,18]]` | 高峰时段（北京小时，含头不含尾） |
| `lowBalanceThreshold` | `10` | 低余额阈值（¥），余额低于此值触发提醒 |
| `lowBalanceNotify` | `true` | 是否弹出通知（状态栏 🔴 标记始终显示） |
| `prices` | 内置官方价表 | 覆盖/新增模型价格：`{peak, offpeak}` 两档或固定 `{input, output, cacheRead}`（¥/1M） |

## 命令

| 命令 | 说明 |
|------|------|
| `/dsrefresh` | 立即刷新余额（含低余额检查） |
| `/dscost` | 查看余额拆分、本轮逐项计费明细（命中/未命中/输出各自金额） |

## 布局说明

- 状态栏 key 以 `z-` 开头，按字母排序后显示在**底部状态栏最右端**，不与 MCP 等其他扩展状态冲突
- 不占用顶部编辑器区域，不产生重复信息
- 详细费用与计费公式通过 `/dscost` 命令查看

## 数据安全

- API key 只在扩展内部构造官方余额接口的 `Authorization` 头，**绝不出现在界面、日志或任何输出中**
- 消费/缓存统计来自 pi 会话内每条消息上报的 `usage`，不发起额外网络请求
- 余额以官方接口返回为准；价格与费用为按官方公告的估算

## 开发

```bash
# 类型检查
npx tsc --noEmit
# 发布
npm publish
```

MIT License
