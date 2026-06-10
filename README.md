# 鱼泡语音助手

本项目是一个 Tauri 桌面语音助手：

- 录音输入最大 60 秒。
- 语音识别只调用本地 `whisper.cpp` 模型。
- 识别完成后，把文本发送给 DeepSeek 做语音错词纠正和实时翻译。
- DeepSeek key 只在 Rust 后端读取，不写入前端代码。

## 本机检查结论

当前机器是 macOS / Apple M4 / 16GB 内存。质量优先时推荐使用：

```text
ggml-large-v3.bin
```

推荐原因：

- Whisper 本地 ASR 里准确率更强，适合中文和中英混合口语。
- 对专有名词、长句断句、弱口音更稳。
- 60 秒输入在 M4 / 16GB 上可用，但会比 `small` 慢。

如果你更重视响应速度，可降级为：

```text
ggml-small.bin
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

下载推荐模型：

```bash
mkdir -p /Users/black/models/whisper
curl -L \
  -o /Users/black/models/whisper/ggml-large-v3.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin
```

配置环境变量：

```bash
cp .env.example .env.local
```

然后编辑 `.env.local`：

```text
WHISPER_CLI_PATH=/opt/homebrew/bin/whisper-cli
WHISPER_MODEL_PATH=/Users/black/models/whisper/ggml-large-v3.bin
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
