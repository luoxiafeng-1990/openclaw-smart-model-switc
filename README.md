# Smart Model Switch

OpenClaw 智能模型切换插件。自动探测哪些模型能用，会话中出错自动切换，context 溢出自动换大模型。

## 安装

一行命令，复制粘贴即可：

```bash
curl -fsSL https://raw.githubusercontent.com/luoxiafeng-1990/openclaw-smart-model-switc/main/install.sh | bash
```

安装完成后重启网关：

```bash
openclaw gateway run --force
```

**就这样，不需要其他配置。** 插件会自动读取你 `openclaw.json` 中已有的模型配置。

## 它做了什么

| 时机 | 行为 |
|------|------|
| 网关启动 | 逐个探测所有已配置模型，生成可用列表 |
| 收到用户消息 | 从可用列表中挑选模型（优先 MiniMax） |
| 模型出错 | 立即从可用列表移除该模型 |
| Context 溢出 | 下次自动切到 context window 最大的模型 |
| 每 1 小时 | 重新探测所有模型，恢复已修复的模型 |

## 可选配置

默认零配置即可工作。如需自定义，编辑 `~/.openclaw/openclaw.json`：

```json
{
  "plugins": {
    "entries": {
      "smart-model-switch": {
        "config": {
          "preferProvider": "minimax",
          "probeIntervalHours": 1
        }
      }
    }
  }
}
```

- `preferProvider` — 优先选哪个供应商（默认 `minimax`）
- `probeIntervalHours` — 重新探测间隔，单位小时（默认 `1`）

## 卸载

```bash
rm -rf ~/.openclaw/extensions/smart-model-switch
```

然后从 `openclaw.json` 的 `plugins.allow` 中移除 `smart-model-switch`。

## License

MIT
