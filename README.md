# Smart Model Switch — OpenClaw Plugin

智能模型切换插件，为 [OpenClaw](https://github.com/openclaw/openclaw) 提供**主动探测 + 自动切换 + 上下文感知**的模型选择能力。

## 功能

- **网关启动时主动探测**：对所有已配置模型发送最小请求，生成"可用模型列表"
- **智能选模型**：每次会话优先选择偏好供应商（默认 MiniMax）
- **错误即淘汰**：模型在会话中出错时，立即从可用列表移除
- **定时刷新**：每 1 小时（可配置）重新探测所有模型，恢复已修复的模型
- **持久化**：可用列表保存到磁盘，网关重启可读取
- **Context-Aware 选模型**：检测到 context overflow 后，自动为该 session 切换到 context window 最大的模型
- **多 API 格式支持**：同时支持 OpenAI 和 Anthropic 格式的供应商探测
- **凭证管理 (Option A)**：可在插件配置中存储 baseUrl + apiKey，自动同步到 openclaw.json

## 支持的供应商

已测试的供应商：

| 供应商 | baseUrl 示例 | API 格式 |
|--------|-------------|----------|
| DeepSeek | `https://api.deepseek.com` | openai-completions |
| 火山引擎 | `https://ark.cn-beijing.volces.com/api/v3` | openai-completions |
| 智谱 AI | `https://open.bigmodel.cn/api/paas/v4` | openai-completions |
| MiniMax | `https://newapi.hizui.cn/v1` | openai-completions |
| Moonshot | `https://api.moonshot.cn/v1` | openai-completions |
| 百度千帆 | `https://qianfan.baidubce.com/v2` | openai-completions |
| 小米 MiMo | `https://api.xiaomimimo.com/anthropic` | anthropic-messages |
| OpenRouter | `https://openrouter.ai/api/v1` | openai-completions |

## 一键部署

```bash
curl -fsSL https://raw.githubusercontent.com/luoxiafeng-1990/openclaw-smart-model-switc/main/install.sh | bash
```

或手动安装：

```bash
git clone https://github.com/luoxiafeng-1990/openclaw-smart-model-switc.git /tmp/smart-model-switch
cp -r /tmp/smart-model-switch ~/.openclaw/extensions/smart-model-switch
rm -rf /tmp/smart-model-switch
```

然后在 `~/.openclaw/openclaw.json` 中添加插件配置（见下方配置说明），重启网关即可。

## 配置

在 `~/.openclaw/openclaw.json` 的 `plugins` 部分添加：

```json
{
  "plugins": {
    "allow": ["smart-model-switch"],
    "entries": {
      "smart-model-switch": {
        "config": {
          "providers": {},
          "preferProvider": "minimax",
          "probeIntervalHours": 1
        }
      }
    }
  }
}
```

### 配置项说明

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `providers` | object | `{}` | 插件自带的供应商配置（Option A）。为空时自动读取 openclaw.json 中已有的 `models.providers` |
| `preferProvider` | string | `"minimax"` | 正常情况下优先选择的供应商 |
| `probeIntervalHours` | number | `1` | 全量重新探测的间隔（小时） |

### 两种使用方式

**方式 A：插件管理凭证（适合分享给他人使用）**

在 `providers` 中配置 baseUrl + apiKey，插件会自动同步到 openclaw.json：

```json
{
  "providers": {
    "minimax": {
      "baseUrl": "https://newapi.hizui.cn/v1",
      "apiKey": "sk-your-key",
      "models": [{ "id": "MiniMax-M2.5", "name": "MiniMax M2.5" }]
    }
  }
}
```

**方式 B：读取已有配置（推荐，零配置）**

`providers` 留空 `{}`，插件自动读取 openclaw.json 中已配置的 `models.providers`。

## Context-Aware 模型切换

当某个 session 遇到 context overflow 错误（如 "context used 191.3k/200k"）时：

1. 插件检测到 context overflow 错误模式
2. 标记该 session 为"需要大 context window"
3. 该 session 的**下一条消息**自动切换到可用列表中 context window 最大的模型
4. 切换成功后，标记自动清除

**注意**：当前溢出的消息无法自动重发（OpenClaw 架构限制），需要用户重新发送。但插件已确保重发时会使用更大 context 的模型。

建议同时配置 compaction 专用模型来预防 context overflow：

```json
{
  "agents": {
    "defaults": {
      "compaction": {
        "mode": "safeguard",
        "model": "openrouter/qwen/qwen3-coder:free"
      }
    }
  }
}
```

## 持久化路径

- 可用模型列表：`~/.openclaw/plugins/smart-model-switch/available-models.json`
- 支持 `$OPENCLAW_STATE_DIR` 环境变量自定义路径

## 运行测试

```bash
node probe.test.js
```

## License

MIT
