# macOS 语音输出「自动粘贴 / 剪贴板」踩坑记录

> 背景：语音识别完成后，要把文本「自动输出到当前光标处」。这个功能在 macOS 上反复出问题，
> 表现为「不粘贴」「粘两次」「剪贴板是空的」等，排查链路很长，这里把每个坑和最终方案记下来，
> 避免以后重复踩。

---

## 一、最终可用方案（结论先行）

macOS 端文本输出统一为 **「进程内 NSPasteboard 写剪贴板」+「CGEvent 模拟 Cmd+V」** 两步：

1. 用 `NSPasteboard.generalPasteboard` 在**进程内**写系统剪贴板（不依赖任何子进程）。
2. 激活之前记录的目标 App，再用 `CGEvent` 合成 `Cmd+V` 粘贴。

只保留这一条机制，不要再叠加「辅助功能直接写入（AX）」，否则会重复粘贴。

相关代码：`src-tauri/src/lib.rs`
- `macos_input::write_clipboard`（NSPasteboard 写剪贴板）
- `output_text_to_macos_focused_app`（输出主流程）
- `macos_input::send_command_v`（合成 Cmd+V）

---

## 二、踩过的坑（按排查顺序）

### 坑 1：AX 直接写入「假成功」——飞书等输入框写不进去
- **现象**：界面提示「已输出到光标位置」，但飞书输入框是空的。
- **原因**：用 `AXUIElementSetAttributeValue(focusedElement, AXSelectedText, ...)` 写焦点元素。
  飞书等基于 Electron / contenteditable 的输入框，即使没真正写进去也会返回
  `kAXErrorSuccess(0)`，于是代码以为成功直接 return，剪贴板兜底逻辑根本没机会跑。
- **教训**：AX 的返回码在这类应用上不可信，不能只靠返回值判断是否真的写入。

### 坑 2：给 AX 加「写入后回读校验」反而导致重复粘贴
- **现象**：改成写完回读 `AXValue` 校验后，飞书里文字被粘了**两遍**。
- **原因**：飞书的焦点元素 `AXValue` 读不回来（None），校验判定为「没生效」，
  于是又走了 `AXValue` 写入分支 + 剪贴板 Cmd+V 兜底；而其中某些 AX 写入其实**生效了**，
  叠加 Cmd+V 就成了两次。
- **教训**：多条输出路径叠加 + 不可靠的校验 = 难以预测的重复。**只保留单一机制**最稳。

### 坑 3（核心大坑）：用 `pbcopy` 子进程写剪贴板，写完没关闭 stdin
- **现象**：去掉 AX、只留剪贴板 + Cmd+V 后，**剪贴板是空的**——
  语音完成后连手动 `Cmd+V` 都粘不出东西。
- **原因**：
  ```rust
  let mut child = Command::new("pbcopy").stdin(Stdio::piped()).spawn()?;
  if let Some(stdin) = child.stdin.as_mut() {   // 只拿了 &mut，没有 take/drop
      stdin.write_all(text.as_bytes())?;
  }
  let status = child.wait()?;                   // stdin 一直开着，pbcopy 收不到 EOF
  ```
  `child.stdin.as_mut()` 不会关闭 stdin，`pbcopy` 收不到 EOF 就**不会把内容真正提交到剪贴板**
  （还可能让 `wait()` 阻塞）。在打包后的 GUI app 环境里尤其容易出问题。
- **关键诊断手法**：让用户「语音完成后**手动按 Cmd+V**」——
  - 能粘出来 → 剪贴板 OK，问题在按键注入；
  - 粘不出来 → **剪贴板本身是空的**，问题在写剪贴板这步。
  这一步把「剪贴板写入」和「按键注入」两个独立环节快速二分，极大缩短排查。
- **最终修法**：放弃 `pbcopy` 子进程，改用进程内 `NSPasteboard`：
  ```rust
  let pasteboard: *mut AnyObject = msg_send![class!(NSPasteboard 取自 AnyClass::get), generalPasteboard];
  let _: i64 = msg_send![pasteboard, clearContents];
  let ok: Bool = msg_send![pasteboard, setString: &*ns_text, forType: &*ns_type]; // type = "public.utf8-plain-text"
  ```
  无子进程、无 PATH 依赖、无 stdin/EOF 问题，`setString:forType:` 的 BOOL 返回值直接判定成败。

---

## 三、和「业务无关」但同样耗时的环境坑

### 坑 4：钥匙串里有两张同名签名证书 → codesign 报 ambiguous
- **现象**：`codesign --sign "Local Voice Assistant Self Signed"` 报
  `ambiguous (matches ... in login.keychain-db and login_renamed_1.keychain-db)`。
- **原因**：两个钥匙串里各有一张 CN 相同但指纹不同的证书。
- **修法**：改用证书的 **SHA-1 指纹**签名来消歧义；并且要选**和已安装 app 相同的那张**
  （`codesign -d -r- <app>` 看 `certificate leaf = H"..."`），否则换证书会导致
  辅助功能 / 麦克风的 TCC 授权失效、需要重新授权。
  - 本项目当前用的指纹：`C638B8F34951CB6F9DD99EC2EFE4F28211632862`（login.keychain-db）。

### 坑 5：一直在运行「挂载 DMG 里的旧包」，而不是 /Applications 的新包
- **现象**：明明装了修复版，行为还是旧的「不粘贴」。
- **原因**：用户从挂载的 DMG 卷（`/Volumes/鱼泡语音助手*`）里直接运行 app，
  根本没跑 `/Applications` 里那个修复版；甚至 `/Applications` 的副本被覆盖/移除了。
- **排查手法**：
  - `ls /Volumes` 看有没有挂载的同名卷；
  - `grep -a -c "insert_text_into_focused_element" <二进制>` 判断是不是残留旧逻辑的旧包；
  - `/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" <Info.plist>` 看版本。
- **修法 / 预防**：用完推出 DMG，只从 `/Applications` 启动；并见坑 6。

### 坑 6：版本号一直不变（0.1.22）→ 根本分不清装的是哪个包
- **修法**：每次改动后**升版本号**（`package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml` 三处同步），
  并在**界面标题旁显示版本号**（用 Tauri `getVersion()` 运行时读取）。
  这样用户一眼能确认跑的是不是新包，省掉大量来回。

### 坑 7：本地 `tauri build` 只出**当前架构**的单架构包
- **现象**：本机是 Intel，`tauri build` 默认只编 `x86_64`，拷到 M 系列只能 Rosetta 跑。
- **修法 / 预防**：对外分发**一律用 CI 出的通用包**
  （`release.yml` 用 `--target universal-apple-darwin`，含 x86_64 + arm64，两种芯片都原生）。
  本地包仅供本机自测，别拷给别人。

---

## 四、复盘：为什么这个「复制问题」拖了很久

1. **多条输出路径互相掩盖**：AX、AXValue、剪贴板 Cmd+V 三条路混在一起，
   单独看都「像是成功」，叠加后表现却是空/重复，难以归因。
2. **「假成功」信号**：AX 返回 0、pbcopy 退出码 0、界面提示「已输出」——
   全是假的成功信号，掩盖了真实失败。
3. **测试对象不一致**：反复在「旧 DMG 包 / 旧版本 / 单架构包」上验证，
   把环境问题误当成代码问题。
4. **缺少可观测性**：没有版本号显示、没有对剪贴板写入做回读，导致无法快速确认。

**最有效的一招**：让用户「手动 Cmd+V」做二分诊断，直接定位到「剪贴板写入」这一环，
再加上「升版本 + 界面显示版本」消除环境干扰。

---

## 五、Checklist（以后改这块功能先过一遍）

- [ ] 输出只走**一条**机制（NSPasteboard + Cmd+V），不要叠加 AX 直接写入。
- [ ] 剪贴板用**进程内 API**，不要用 `pbcopy` 子进程；若必须用子进程，务必 `take()` 并 drop stdin 触发 EOF。
- [ ] 不要相信 AX / 子进程退出码这类「假成功」信号，必要时回读校验。
- [ ] 改完**升版本号（三处同步）**，界面能看到版本。
- [ ] 签名用**固定证书的 SHA-1 指纹**，保持和旧版同一身份（保住 TCC 授权）。
- [ ] 对外分发用 **CI 通用包**；提醒用户推出旧 DMG、首次打开过 Gatekeeper、按机器授权。
