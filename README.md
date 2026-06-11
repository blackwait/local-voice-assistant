# 鱼泡语音助手

本项目是一个 Tauri 桌面语音助手：

- 录音输入最大 60 秒。
- 语音识别默认使用 FunASR 服务。
- 安装包不内置 Whisper / ggml 本地模型。
- 识别完成后，把文本发送给 DeepSeek 做语音错词纠正和实时翻译。
- DeepSeek key 只在 Rust 后端读取，不写入前端代码。

## 默认识别方式

默认配置使用当前 FunASR 服务：

```text
ASR_ENGINE=funasr
FUNASR_ENDPOINT=http://10.254.81.32:10095
FUNASR_MODEL=iic/SenseVoiceSmall
FUNASR_DEVICE=cpu
```

GitHub release 不会下载或打包 `models/ggml-tiny.bin`。同事安装后默认直接调用 FunASR 服务，不需要本机准备 Whisper 模型。

## 可选：本地 Whisper 模型

如果用户需要离线或本地识别，可以自行安装 `whisper.cpp` 并下载 ggml 模型，然后在软件“模型设置”中切换到 Whisper 并填写：

```text
WHISPER_CLI_PATH=/opt/homebrew/bin/whisper-cli
WHISPER_MODEL_PATH=/Users/black/models/whisper/ggml-large-v3.bin
WHISPER_THREADS=8
```

安装 `whisper.cpp` 示例：

```bash
brew install whisper-cpp
```

模型文件由用户自行管理，软件只保存路径，不复制、不下载、不随安装包分发。

## 开发运行

```bash
npm install
npm run tauri:dev
```

## 内部 macOS 分发

个人开发者内部给同事安装时，可用自签名证书保持稳定代码身份：

```bash
npm run mac:signing-secret
```

把脚本输出的 `identity.p12.base64` 配置到 GitHub Secrets：

```text
MACOS_CERTIFICATE
MACOS_CERTIFICATE_PASSWORD
MACOS_SIGNING_IDENTITY
```

同事首次打开未公证应用时，可能仍需要在系统设置中允许打开，或清理隔离属性。
