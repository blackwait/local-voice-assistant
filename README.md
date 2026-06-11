# 鱼泡语音助手

本项目是一个 Tauri 桌面语音助手：

- 录音输入最大 60 秒。
- 语音识别默认使用 FunASR，也可以切换到本地 `whisper.cpp` 模型。
- 识别完成后，把文本发送给 DeepSeek 做语音错词纠正和实时翻译。
- DeepSeek key 只在 Rust 后端读取，不写入前端代码。

## 本机检查结论

当前安装包会内置轻量模型：

```text
models/ggml-tiny.bin
```

默认选择它的原因：

- 文件较小，适合随 DMG 一起分发。
- 启动和短句识别更快。
- 未配置本地模型时，应用会自动使用 FunASR，不会因为 `WHISPER_MODEL_PATH` 缺失直接报错。

如果你更重视本地离线准确率，可以在“模型设置”中手动添加更大的模型，例如：

```text
ggml-large-v3.bin
```

## 运行前准备

当前本机还缺少 Rust / Cargo / Tauri 运行所需工具链，需要先安装 Rust：

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

安装 whisper.cpp：

```bash
brew install whisper-cpp
```

下载内置轻量模型：

```bash
node scripts/download_whisper_tiny_model.mjs
```

配置环境变量：

```bash
cp .env.example .env.local
```

然后编辑 `.env.local`：

```text
WHISPER_CLI_PATH=/opt/homebrew/bin/whisper-cli
WHISPER_MODEL_PATH=/Users/black/IdeaProjects/local-voice-assistant/models/ggml-tiny.bin
WHISPER_THREADS=8
DEEPSEEK_API_KEY=你的 DeepSeek key
DEEPSEEK_MODEL=deepseek-v4-flash
```

## 开发运行

```bash
npm install
npm run tauri:dev
```

## 说明

DeepSeek 官方 OpenAI-compatible endpoint 当前 flash 模型 ID 是
`deepseek-v4-flash`。
