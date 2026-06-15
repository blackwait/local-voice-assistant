# 鱼泡语音助手

本项目是一个 Tauri 桌面语音助手：

- 录音输入最大 60 秒。
- 语音识别默认使用 FunASR 服务，优先远端，失败自动回退本地。
- 安装包不内置 Whisper / ggml 本地模型。
- 识别完成后，把文本发送给 DeepSeek 做 AI 润色和实时翻译。
- DeepSeek key 只在 Rust 后端读取，不写入前端代码。

## 默认识别方式

默认配置优先使用远端 FunASR Paraformer-large 服务；远端不可用时自动回退本机服务：

```text
ASR_ENGINE=funasr
FUNASR_ENDPOINT=http://10.254.81.32:10095
FUNASR_MODEL=iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch
FUNASR_DEVICE=cpu
```

代码中的默认顺序是：

```text
1. 先请求 FUNASR_ENDPOINT（默认 http://10.254.81.32:10095）
2. 如果失败，再自动回退到 http://127.0.0.1:10095
```

GitHub release 不会下载或打包 `models/ggml-tiny.bin`。同事安装后默认直接调用远端或本机的 FunASR 服务，不需要本机准备 Whisper 模型。

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
MACOS_CERTIFICATE_SHA1
```

同事首次打开未公证应用时，可能仍需要在系统设置中允许打开，或清理隔离属性。
后续更新必须继续使用同一份证书和同一个 Bundle ID：`com.black.local-voice-assistant`。
如果 GitHub Actions 检测到签名证书指纹不一致，会拒绝发布 macOS 包，避免用户更新后丢失辅助功能授权。

本地构建脚本不会静默生成新证书。仅本机临时开发时才使用：

```bash
ALLOW_CREATE_LOCAL_SIGNING_CERT=1 npm run package:mac
```

正式分发给同事的包必须来自同一条 GitHub Release 构建链路，不要混用本机临时包和 CI 包。

### 已授权但仍提示辅助功能权限

macOS 的麦克风、辅助功能等 TCC 权限会绑定到应用的代码签名身份。
如果重新打包时换了证书，系统设置里可能仍显示“鱼泡语音助手”已打开，
但当前安装包实际拿不到权限。

发布给别人安装时：

1. 固定使用同一份 `MACOS_CERTIFICATE` / `MACOS_SIGNING_IDENTITY` 打包。
2. 不要每次发布都重新生成自签名证书。
3. 如果用户已授权但应用仍提示辅助功能权限，让用户执行：

```bash
npm run mac:fix-accessibility
```

脚本只会重置 `com.black.local-voice-assistant` 的辅助功能授权记录，
然后打开系统辅助功能设置页，让用户重新授权当前签名的应用。
