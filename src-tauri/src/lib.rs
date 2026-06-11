use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::env;
use std::fs;
use std::io::Cursor;
#[cfg(any(
    target_os = "macos",
    all(not(target_os = "macos"), not(target_os = "windows"))
))]
use std::io::Write;
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process;
use std::process::Command;
#[cfg(any(
    target_os = "macos",
    all(not(target_os = "macos"), not(target_os = "windows"))
))]
use std::process::Stdio;
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};
use tempfile::Builder;
use thiserror::Error;

const MAX_RECORDING_SECONDS: usize = 60;
const DEFAULT_DEEPSEEK_API_KEY: &str = "sk-5ccffb5099bb43cc9e98d85386b25cec";
const RECORD_SHORTCUT_EVENT: &str = "record-shortcut-pressed";
const RECORD_TRANSCRIBED_EVENT: &str = "record-transcribed";
const OVERLAY_LABEL: &str = "voice-overlay";
const OVERLAY_STATE_EVENT: &str = "voice-overlay-state";
const LEGACY_VOICE_TRANSCRIBER_MODEL_DIR: &str =
    "/Users/black/IdeaProjects/voice-transcriber-tauri/models/";
const RECORDING_STARTUP_TIMEOUT_SECONDS: u64 = 15;
const MAX_VOICE_HISTORY_ITEMS: usize = 100;

#[derive(Debug, Error)]
enum AppError {
    #[error("本地 Whisper 模型不可用")]
    MissingWhisperModel,
    #[error("本地 whisper 命令执行失败：{0}")]
    WhisperFailed(String),
    #[error("DeepSeek key 未配置，请在 .env.local 中设置 DEEPSEEK_API_KEY")]
    MissingDeepSeekKey,
    #[error("DeepSeek 请求失败：{0}")]
    DeepSeekFailed(String),
    #[error("文件处理失败：{0}")]
    Io(String),
    #[error("麦克风录音失败：{0}")]
    Audio(String),
    #[error("文本输出失败：{0}")]
    Output(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
struct AppConfig {
    whisper_cli_path: String,
    whisper_model_path: String,
    whisper_model_profiles: Vec<WhisperModelProfile>,
    whisper_threads: String,
    asr_engine: String,
    funasr_endpoint: String,
    funasr_model: String,
    funasr_device: String,
    deepseek_api_key: String,
    deepseek_model: String,
    deepseek_endpoint: String,
    #[serde(default = "default_translation_enabled")]
    translation_enabled: bool,
    target_language: String,
    record_shortcut: String,
    shortcut_enabled: bool,
    #[serde(default)]
    polish_prompt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
struct WhisperModelProfile {
    name: String,
    path: String,
    speed_hint: String,
}

impl Default for WhisperModelProfile {
    fn default() -> Self {
        Self {
            name: String::new(),
            path: String::new(),
            speed_hint: String::new(),
        }
    }
}

impl Default for AppConfig {
    fn default() -> Self {
        load_dotenv();
        Self {
            whisper_cli_path: whisper_cli_path_from_env(),
            whisper_model_path: default_whisper_model_path(),
            whisper_model_profiles: default_model_profiles(),
            whisper_threads: env::var("WHISPER_THREADS").unwrap_or_else(|_| "8".to_string()),
            asr_engine: env::var("ASR_ENGINE").unwrap_or_else(|_| "funasr".to_string()),
            funasr_endpoint: env::var("FUNASR_ENDPOINT")
                .unwrap_or_else(|_| "http://10.254.81.32:10095".to_string()),
            funasr_model: "iic/SenseVoiceSmall".to_string(),
            funasr_device: "cpu".to_string(),
            deepseek_api_key: env::var("DEEPSEEK_API_KEY")
                .unwrap_or_else(|_| DEFAULT_DEEPSEEK_API_KEY.to_string()),
            deepseek_model: env::var("DEEPSEEK_MODEL")
                .unwrap_or_else(|_| "deepseek-v4-flash".to_string()),
            deepseek_endpoint: env::var("DEEPSEEK_ENDPOINT")
                .unwrap_or_else(|_| "http://10.254.81.32:10095".to_string()),
            translation_enabled: default_translation_enabled(),
            target_language: "中文".to_string(),
            record_shortcut: default_record_shortcut(),
            shortcut_enabled: true,
            polish_prompt: String::new(),
        }
    }
}

#[derive(Debug, Serialize)]
struct AppConfigView {
    whisper_cli_path: String,
    whisper_model_path: String,
    whisper_model_profiles: Vec<WhisperModelProfile>,
    whisper_threads: String,
    asr_engine: String,
    funasr_endpoint: String,
    funasr_model: String,
    funasr_device: String,
    deepseek_api_key: String,
    deepseek_model: String,
    deepseek_endpoint: String,
    deepseek_key_configured: bool,
    translation_enabled: bool,
    target_language: String,
    config_path: String,
    record_shortcut: String,
    shortcut_enabled: bool,
    polish_prompt: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct AssistantResult {
    corrected_text: String,
    translation: String,
    notes: Vec<String>,
    confidence: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct CorrectionResult {
    corrected_text: String,
    notes: Vec<String>,
    confidence: String,
}

#[derive(Debug, Serialize)]
struct FunAsrHealthView {
    ok: bool,
    message: String,
    model: String,
    device: String,
}

#[derive(Debug, Serialize)]
struct AccessibilityPermissionView {
    trusted: bool,
    platform: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct VoiceHistoryItem {
    id: String,
    text: String,
    created_at: u64,
}

#[derive(Debug, Deserialize)]
struct DeepSeekChoice {
    message: DeepSeekMessage,
}

#[derive(Debug, Deserialize)]
struct DeepSeekMessage {
    content: String,
}

#[derive(Debug, Deserialize)]
struct DeepSeekResponse {
    choices: Vec<DeepSeekChoice>,
}

#[derive(Default)]
struct RecorderState {
    controller: Mutex<Option<RecordingController>>,
    #[cfg(target_os = "macos")]
    target_pid: Mutex<Option<i32>>,
}

struct RecordingController {
    command_tx: mpsc::Sender<RecorderCommand>,
    result_rx: mpsc::Receiver<Result<Vec<u8>, String>>,
    handle: thread::JoinHandle<()>,
}

enum RecorderCommand {
    Stop,
    Cancel,
}

#[tauri::command]
fn get_app_config(app: AppHandle) -> Result<AppConfigView, String> {
    let config = load_or_create_config(&app)?;
    Ok(config.to_view(config_path(&app)?))
}

#[tauri::command]
fn load_config(app: AppHandle) -> Result<AppConfigView, String> {
    let config = load_or_create_config(&app)?;
    Ok(config.to_view(config_path(&app)?))
}

#[tauri::command]
fn save_config(app: AppHandle, mut config: AppConfig) -> Result<AppConfigView, String> {
    normalize_config(&app, &mut config);
    save_app_config(&app, &config)?;
    register_record_shortcut(&app, &config)?;
    Ok(config.to_view(config_path(&app)?))
}

#[tauri::command]
fn output_text_to_cursor(app: AppHandle, text: String) -> Result<(), String> {
    output_text_to_cursor_inner(&app, text).map_err(|error| error.to_string())
}

#[tauri::command]
fn check_accessibility_permission() -> AccessibilityPermissionView {
    AccessibilityPermissionView {
        trusted: accessibility_permission_trusted(),
        platform: env::consts::OS.to_string(),
    }
}

#[tauri::command]
fn open_accessibility_settings() -> Result<(), String> {
    open_accessibility_settings_inner()
}

#[tauri::command]
fn copy_text_to_clipboard(text: String) -> Result<(), String> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(());
    }
    write_text_to_clipboard(text).map_err(|error| error.to_string())
}

#[tauri::command]
fn record_voice_history(app: AppHandle, text: String) -> Result<VoiceHistoryItem, String> {
    record_voice_history_inner(&app, text).map_err(|error| error.to_string())
}

#[tauri::command]
fn list_voice_history(app: AppHandle) -> Result<Vec<VoiceHistoryItem>, String> {
    read_voice_history(&app).map_err(|error| error.to_string())
}

#[tauri::command]
fn delete_voice_history(app: AppHandle, id: String) -> Result<Vec<VoiceHistoryItem>, String> {
    let mut items = read_voice_history(&app).map_err(|error| error.to_string())?;
    items.retain(|item| item.id != id);
    write_voice_history(&app, &items).map_err(|error| error.to_string())?;
    Ok(items)
}

#[tauri::command]
fn clear_voice_history(app: AppHandle) -> Result<(), String> {
    write_voice_history(&app, &[]).map_err(|error| error.to_string())
}

#[tauri::command]
fn start_native_recording(
    app: AppHandle,
    state: tauri::State<RecorderState>,
) -> Result<(), String> {
    start_recording(app, &state).map_err(|error| error.to_string())
}

#[tauri::command]
fn cancel_native_recording(state: tauri::State<RecorderState>) -> Result<(), String> {
    cancel_recording(&state).map_err(|error| error.to_string())
}

#[tauri::command]
fn close_voice_overlay(app: AppHandle, state: tauri::State<RecorderState>) -> Result<(), String> {
    let _ = cancel_recording(&state);
    if let Some(overlay) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = overlay.hide();
    }
    Ok(())
}

#[tauri::command]
fn stop_recording_and_transcribe(
    app: AppHandle,
    state: tauri::State<RecorderState>,
) -> Result<String, String> {
    let config = load_or_create_config(&app)?;
    let audio = stop_recording(&state).map_err(|error| error.to_string())?;
    transcribe_audio(audio, &config).map_err(|error| error.to_string())
}

#[tauri::command]
async fn check_funasr_service(app: AppHandle) -> Result<FunAsrHealthView, String> {
    let config = load_or_create_config(&app)?;
    check_funasr_health(&config).await
}

#[tauri::command]
fn start_funasr_service(app: AppHandle) -> Result<String, String> {
    let config = load_or_create_config(&app)?;
    let mut script_path = app
        .path()
        .resolve(
            "scripts/start_funasr_service.sh",
            tauri::path::BaseDirectory::Resource,
        )
        .unwrap_or_else(|_| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../scripts/start_funasr_service.sh")
        });
    if !script_path.is_file() {
        script_path =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../scripts/start_funasr_service.sh");
    }
    if !script_path.is_file() {
        return Err(format!("FunASR 启动脚本不存在：{}", script_path.display()));
    }
    let log_path = app_data_dir(&app)?.join("funasr-service.log");
    let log_file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|error| error.to_string())?;
    let err_file = log_file.try_clone().map_err(|error| error.to_string())?;
    let (host, port) = parse_funasr_endpoint(config.funasr_endpoint.trim());
    Command::new("bash")
        .arg(script_path)
        .env("FUNASR_HOST", host)
        .env("FUNASR_PORT", port)
        .env("FUNASR_MODEL", config.funasr_model.trim())
        .env("FUNASR_DEVICE", config.funasr_device.trim())
        .stdout(log_file)
        .stderr(err_file)
        .spawn()
        .map_err(|error| format!("启动 FunASR 服务失败：{error}"))?;
    Ok(format!("FunASR 服务启动中，日志：{}", log_path.display()))
}

#[tauri::command]
fn default_polish_prompt() -> String {
    build_correction_prompt()
}

#[tauri::command]
async fn polish_and_translate(
    app: AppHandle,
    input: String,
    target_language: Option<String>,
) -> Result<AssistantResult, String> {
    let config = load_or_create_config(&app)?;
    let language = target_language
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| config.target_language.clone());
    call_deepseek(&input, language.as_str(), &config)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn polish_text(app: AppHandle, input: String) -> Result<CorrectionResult, String> {
    let config = load_or_create_config(&app)?;
    call_deepseek_correction(&input, &config)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn translate_text(
    app: AppHandle,
    input: String,
    target_language: Option<String>,
) -> Result<String, String> {
    let config = load_or_create_config(&app)?;
    let language = target_language
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| config.target_language.clone());
    call_deepseek_translation(&input, language.as_str(), &config)
        .await
        .map_err(|error| error.to_string())
}

fn start_recording(app: AppHandle, state: &RecorderState) -> Result<(), AppError> {
    ensure_microphone_permission()?;

    let mut current_controller = state
        .controller
        .lock()
        .map_err(|_| AppError::Audio("录音状态锁定失败".to_string()))?;
    if current_controller.is_some() {
        return Ok(());
    }

    let (command_tx, command_rx) = mpsc::channel::<RecorderCommand>();
    let (init_tx, init_rx) = mpsc::channel::<Result<(), String>>();
    let (result_tx, result_rx) = mpsc::channel::<Result<Vec<u8>, String>>();
    let handle = thread::spawn(move || run_recording_thread(app, command_rx, init_tx, result_tx));
    match init_rx
        .recv_timeout(Duration::from_secs(RECORDING_STARTUP_TIMEOUT_SECONDS))
        .map_err(|_| AppError::Audio("麦克风启动超时".to_string()))?
    {
        Ok(()) => {
            *current_controller = Some(RecordingController {
                command_tx,
                result_rx,
                handle,
            });
            Ok(())
        }
        Err(message) => {
            let _ = handle.join();
            Err(AppError::Audio(message))
        }
    }
}

fn stop_recording(state: &RecorderState) -> Result<Vec<u8>, AppError> {
    let controller = take_controller(state)?;
    controller
        .command_tx
        .send(RecorderCommand::Stop)
        .map_err(|_| AppError::Audio("录音线程已经退出".to_string()))?;
    let audio = controller
        .result_rx
        .recv_timeout(Duration::from_secs(10))
        .map_err(|_| AppError::Audio("读取录音结果超时".to_string()))?
        .map_err(AppError::Audio);
    let _ = controller.handle.join();
    audio
}

fn cancel_recording(state: &RecorderState) -> Result<(), AppError> {
    let controller = take_controller(state)?;
    let _ = controller.command_tx.send(RecorderCommand::Cancel);
    let _ = controller.handle.join();
    Ok(())
}

fn take_controller(state: &RecorderState) -> Result<RecordingController, AppError> {
    state
        .controller
        .lock()
        .map_err(|_| AppError::Audio("录音状态锁定失败".to_string()))?
        .take()
        .ok_or_else(|| AppError::Audio("当前没有正在进行的录音".to_string()))
}

fn run_recording_thread(
    app: AppHandle,
    command_rx: mpsc::Receiver<RecorderCommand>,
    init_tx: mpsc::Sender<Result<(), String>>,
    result_tx: mpsc::Sender<Result<Vec<u8>, String>>,
) {
    let setup = setup_recording_stream(app);
    let (stream, samples, sample_rate, started_at) = match setup {
        Ok(session) => {
            let _ = init_tx.send(Ok(()));
            session
        }
        Err(error) => {
            let _ = init_tx.send(Err(error.to_string()));
            return;
        }
    };

    match command_rx.recv() {
        Ok(RecorderCommand::Stop) => {
            drop(stream);
            let audio = finish_recording(samples, sample_rate, started_at);
            let _ = result_tx.send(audio.map_err(|error| error.to_string()));
        }
        Ok(RecorderCommand::Cancel) | Err(_) => {
            drop(stream);
        }
    }
}

fn setup_recording_stream(
    app: AppHandle,
) -> Result<(cpal::Stream, Arc<Mutex<Vec<f32>>>, u32, Instant), AppError> {
    ensure_microphone_permission()?;

    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| AppError::Audio("未找到默认麦克风输入设备".to_string()))?;
    let supported_config = device
        .default_input_config()
        .map_err(|error| AppError::Audio(error.to_string()))?;
    let sample_rate = supported_config.sample_rate().0;
    let channels = supported_config.channels() as usize;
    let max_samples = sample_rate as usize * MAX_RECORDING_SECONDS;
    let samples = Arc::new(Mutex::new(Vec::<f32>::with_capacity(max_samples)));
    let stream_config = supported_config.config();
    let started_at = Instant::now();
    let stream = match supported_config.sample_format() {
        cpal::SampleFormat::F32 => build_f32_input_stream(
            app.clone(),
            &device,
            &stream_config,
            channels,
            max_samples,
            samples.clone(),
            started_at,
        ),
        cpal::SampleFormat::I16 => build_i16_input_stream(
            app.clone(),
            &device,
            &stream_config,
            channels,
            max_samples,
            samples.clone(),
            started_at,
        ),
        cpal::SampleFormat::U16 => build_u16_input_stream(
            app,
            &device,
            &stream_config,
            channels,
            max_samples,
            samples.clone(),
            started_at,
        ),
        format => Err(AppError::Audio(format!(
            "暂不支持的麦克风采样格式：{format:?}"
        ))),
    }?;

    stream
        .play()
        .map_err(|error| AppError::Audio(error.to_string()))?;
    Ok((stream, samples, sample_rate, started_at))
}

#[cfg(target_os = "macos")]
fn ensure_microphone_permission() -> Result<(), AppError> {
    macos_microphone_permission::ensure_authorized()
}

#[cfg(not(target_os = "macos"))]
fn ensure_microphone_permission() -> Result<(), AppError> {
    Ok(())
}

#[cfg(target_os = "macos")]
mod macos_microphone_permission {
    use super::AppError;
    use block2::{DynBlock, RcBlock};
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, Bool};
    use objc2_foundation::NSString;
    use std::sync::mpsc;
    use std::time::Duration;

    const AV_AUTHORIZATION_STATUS_NOT_DETERMINED: isize = 0;
    const AV_AUTHORIZATION_STATUS_RESTRICTED: isize = 1;
    const AV_AUTHORIZATION_STATUS_DENIED: isize = 2;
    const AV_AUTHORIZATION_STATUS_AUTHORIZED: isize = 3;

    #[link(name = "AVFoundation", kind = "framework")]
    extern "C" {
        static AVMediaTypeAudio: &'static NSString;
    }

    pub fn ensure_authorized() -> Result<(), AppError> {
        let device_class = AnyClass::get(c"AVCaptureDevice").ok_or_else(|| {
            AppError::Audio("获取录音授权显示失败：AVFoundation 不可用".to_string())
        })?;
        let media_type = unsafe { AVMediaTypeAudio };
        let status: isize =
            unsafe { msg_send![device_class, authorizationStatusForMediaType: media_type] };

        match status {
            AV_AUTHORIZATION_STATUS_AUTHORIZED => Ok(()),
            AV_AUTHORIZATION_STATUS_NOT_DETERMINED => request_access(device_class, media_type),
            AV_AUTHORIZATION_STATUS_DENIED => Err(AppError::Audio(
                "麦克风权限已被拒绝：请在 macOS 系统设置 > 隐私与安全性 > 麦克风 中允许本应用访问麦克风，然后重新启动应用。".to_string(),
            )),
            AV_AUTHORIZATION_STATUS_RESTRICTED => Err(AppError::Audio(
                "麦克风权限受系统限制：请检查屏幕使用时间、MDM 或隐私限制后重试。".to_string(),
            )),
            _ => Err(AppError::Audio(format!("获取录音授权显示失败：未知授权状态 {status}"))),
        }
    }

    fn request_access(device_class: &AnyClass, media_type: &NSString) -> Result<(), AppError> {
        let (tx, rx) = mpsc::channel::<bool>();
        let handler = RcBlock::new(move |granted: Bool| {
            let _ = tx.send(granted.as_bool());
        });
        let handler: &DynBlock<dyn Fn(Bool)> = &handler;

        let _: () = unsafe {
            msg_send![
                device_class,
                requestAccessForMediaType: media_type,
                completionHandler: handler
            ]
        };

        let granted = rx
            .recv_timeout(Duration::from_secs(60))
            .map_err(|_| AppError::Audio("获取录音授权显示失败：等待用户授权超时".to_string()))?;
        if granted {
            Ok(())
        } else {
            Err(AppError::Audio(
                "麦克风权限未授权：请在 macOS 系统设置 > 隐私与安全性 > 麦克风 中允许本应用访问麦克风，然后重新启动应用。".to_string(),
            ))
        }
    }
}

#[cfg(target_os = "macos")]
mod macos_input {
    use core_foundation::base::TCFType;
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::{CFDictionary, CFDictionaryRef};
    use core_foundation::string::{CFString, CFStringRef};
    use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::thread;
    use std::time::Duration;

    // kVK_ANSI_V，用于模拟 Command+V 粘贴。
    const KEY_CODE_V: u16 = 0x09;
    // kVK_Command，用于按下左 Command 修饰键。
    const KEY_CODE_COMMAND: u16 = 0x37;
    static ACCESSIBILITY_PROMPTED: AtomicBool = AtomicBool::new(false);

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        static kAXTrustedCheckOptionPrompt: CFStringRef;
        fn AXIsProcessTrustedWithOptions(options: CFDictionaryRef) -> bool;
        fn AXIsProcessTrusted() -> bool;
    }

    #[link(name = "AppKit", kind = "framework")]
    extern "C" {}

    pub fn accessibility_trusted() -> bool {
        unsafe { AXIsProcessTrusted() }
    }

    // 触发系统辅助功能授权引导框，并把当前 app 加入辅助功能列表。
    pub fn prompt_accessibility() -> bool {
        unsafe {
            let key = CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt);
            let value = CFBoolean::true_value();
            let options = CFDictionary::from_CFType_pairs(&[(key.as_CFType(), value.as_CFType())]);
            AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef())
        }
    }

    pub fn prompt_accessibility_once() -> bool {
        if ACCESSIBILITY_PROMPTED.swap(true, Ordering::SeqCst) {
            return false;
        }
        prompt_accessibility()
    }

    pub fn frontmost_application_pid() -> Option<i32> {
        let workspace_class = AnyClass::get(c"NSWorkspace")?;
        let workspace: *mut AnyObject = unsafe { msg_send![workspace_class, sharedWorkspace] };
        if workspace.is_null() {
            return None;
        }
        let app: *mut AnyObject = unsafe { msg_send![workspace, frontmostApplication] };
        if app.is_null() {
            return None;
        }
        let pid: i32 = unsafe { msg_send![app, processIdentifier] };
        (pid > 0).then_some(pid)
    }

    pub fn activate_application(pid: i32) -> bool {
        if pid <= 0 {
            return false;
        }
        let app_class = match AnyClass::get(c"NSRunningApplication") {
            Some(class) => class,
            None => return false,
        };
        let app: *mut AnyObject =
            unsafe { msg_send![app_class, runningApplicationWithProcessIdentifier: pid] };
        if app.is_null() {
            return false;
        }
        let activated: Bool = unsafe { msg_send![app, activateWithOptions: 2usize] };
        activated.as_bool()
    }

    // 进程内直接发送 Command+V，权限归属当前 app 而非子进程 osascript。
    pub fn send_command_v() -> Result<(), String> {
        let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState)
            .map_err(|_| "创建键盘事件源失败".to_string())?;
        let command_down = CGEvent::new_keyboard_event(source.clone(), KEY_CODE_COMMAND, true)
            .map_err(|_| "创建 Command 按下事件失败".to_string())?;
        command_down.set_flags(CGEventFlags::CGEventFlagCommand);
        command_down.post(CGEventTapLocation::HID);
        thread::sleep(Duration::from_millis(30));

        let key_down = CGEvent::new_keyboard_event(source.clone(), KEY_CODE_V, true)
            .map_err(|_| "创建按键事件失败".to_string())?;
        key_down.set_flags(CGEventFlags::CGEventFlagCommand);
        key_down.post(CGEventTapLocation::HID);
        thread::sleep(Duration::from_millis(30));

        let key_up = CGEvent::new_keyboard_event(source.clone(), KEY_CODE_V, false)
            .map_err(|_| "创建按键事件失败".to_string())?;
        key_up.set_flags(CGEventFlags::CGEventFlagCommand);
        key_up.post(CGEventTapLocation::HID);
        thread::sleep(Duration::from_millis(30));

        let command_up = CGEvent::new_keyboard_event(source, KEY_CODE_COMMAND, false)
            .map_err(|_| "创建 Command 松开事件失败".to_string())?;
        command_up.post(CGEventTapLocation::HID);
        Ok(())
    }
}

#[cfg(target_os = "windows")]
mod windows_input {
    use std::mem::size_of;
    use std::ptr;
    use std::thread;
    use std::time::Duration;
    use windows_sys::Win32::Foundation::GlobalFree;
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
    };
    use windows_sys::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE,
    };
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_CONTROL, VK_V,
    };

    const CF_UNICODETEXT: u32 = 13;

    pub fn write_clipboard_text(text: &str) -> Result<(), String> {
        let mut utf16: Vec<u16> = text.encode_utf16().collect();
        utf16.push(0);
        let byte_len = utf16.len() * size_of::<u16>();

        unsafe {
            if OpenClipboard(ptr::null_mut()) == 0 {
                return Err("打开剪贴板失败".to_string());
            }

            let result = write_open_clipboard(&utf16, byte_len);
            CloseClipboard();
            result
        }
    }

    unsafe fn write_open_clipboard(utf16: &[u16], byte_len: usize) -> Result<(), String> {
        if EmptyClipboard() == 0 {
            return Err("清空剪贴板失败".to_string());
        }

        let memory = GlobalAlloc(GMEM_MOVEABLE, byte_len);
        if memory.is_null() {
            return Err("分配剪贴板内存失败".to_string());
        }

        let locked = GlobalLock(memory) as *mut u16;
        if locked.is_null() {
            GlobalFree(memory);
            return Err("锁定剪贴板内存失败".to_string());
        }

        ptr::copy_nonoverlapping(utf16.as_ptr(), locked, utf16.len());
        GlobalUnlock(memory);

        if SetClipboardData(CF_UNICODETEXT, memory).is_null() {
            GlobalFree(memory);
            return Err("设置剪贴板数据失败".to_string());
        }

        Ok(())
    }

    pub fn send_ctrl_v() -> Result<(), String> {
        let inputs = [
            keyboard_input(VK_CONTROL, false),
            keyboard_input(VK_V, false),
            keyboard_input(VK_V, true),
            keyboard_input(VK_CONTROL, true),
        ];
        let sent = unsafe {
            SendInput(
                inputs.len() as u32,
                inputs.as_ptr(),
                size_of::<INPUT>() as i32,
            )
        };
        if sent != inputs.len() as u32 {
            return Err(format!(
                "发送 Ctrl+V 失败：已发送 {sent}/{} 个键盘事件",
                inputs.len()
            ));
        }
        thread::sleep(Duration::from_millis(30));
        Ok(())
    }

    fn keyboard_input(key: u16, key_up: bool) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: key,
                    wScan: 0,
                    dwFlags: if key_up { KEYEVENTF_KEYUP } else { 0 },
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }
}

fn finish_recording(
    samples: Arc<Mutex<Vec<f32>>>,
    sample_rate: u32,
    started_at: Instant,
) -> Result<Vec<u8>, AppError> {
    let elapsed_ms = started_at.elapsed().as_millis();
    let samples = samples
        .lock()
        .map_err(|_| AppError::Audio("录音数据读取失败".to_string()))?
        .clone();
    if samples.is_empty() || elapsed_ms < 300 {
        return Err(AppError::Audio("没有采集到有效麦克风音频".to_string()));
    }

    encode_wav(samples, sample_rate)
}

fn build_f32_input_stream(
    app: AppHandle,
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: usize,
    max_samples: usize,
    samples: Arc<Mutex<Vec<f32>>>,
    started_at: Instant,
) -> Result<cpal::Stream, AppError> {
    let mut last_level_emit = Instant::now() - Duration::from_millis(200);
    device
        .build_input_stream(
            config,
            move |data: &[f32], _| {
                let level = push_samples(data.iter().copied(), channels, max_samples, &samples);
                emit_recording_level(&app, started_at, &mut last_level_emit, level);
            },
            move |error| eprintln!("audio stream error: {error}"),
            None,
        )
        .map_err(|error| AppError::Audio(error.to_string()))
}

fn build_i16_input_stream(
    app: AppHandle,
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: usize,
    max_samples: usize,
    samples: Arc<Mutex<Vec<f32>>>,
    started_at: Instant,
) -> Result<cpal::Stream, AppError> {
    let mut last_level_emit = Instant::now() - Duration::from_millis(200);
    device
        .build_input_stream(
            config,
            move |data: &[i16], _| {
                let level = push_samples(
                    data.iter().map(|sample| *sample as f32 / i16::MAX as f32),
                    channels,
                    max_samples,
                    &samples,
                );
                emit_recording_level(&app, started_at, &mut last_level_emit, level);
            },
            move |error| eprintln!("audio stream error: {error}"),
            None,
        )
        .map_err(|error| AppError::Audio(error.to_string()))
}

fn build_u16_input_stream(
    app: AppHandle,
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: usize,
    max_samples: usize,
    samples: Arc<Mutex<Vec<f32>>>,
    started_at: Instant,
) -> Result<cpal::Stream, AppError> {
    let mut last_level_emit = Instant::now() - Duration::from_millis(200);
    device
        .build_input_stream(
            config,
            move |data: &[u16], _| {
                let level = push_samples(
                    data.iter()
                        .map(|sample| (*sample as f32 - 32768.0) / 32768.0),
                    channels,
                    max_samples,
                    &samples,
                );
                emit_recording_level(&app, started_at, &mut last_level_emit, level);
            },
            move |error| eprintln!("audio stream error: {error}"),
            None,
        )
        .map_err(|error| AppError::Audio(error.to_string()))
}

fn push_samples<I>(
    data: I,
    channels: usize,
    max_samples: usize,
    samples: &Arc<Mutex<Vec<f32>>>,
) -> f64
where
    I: Iterator<Item = f32>,
{
    let mut sum = 0.0_f64;
    let mut count = 0_usize;
    if let Ok(mut target) = samples.lock() {
        for (index, sample) in data.enumerate() {
            if channels == 0 || index % channels == 0 {
                let value = sample.clamp(-1.0, 1.0);
                sum += (value as f64) * (value as f64);
                count += 1;
                if target.len() < max_samples {
                    target.push(value);
                }
            }
        }
    }
    if count == 0 {
        return 0.0;
    }
    ((sum / count as f64).sqrt() * 4.5).clamp(0.0, 1.0)
}

fn emit_recording_level(app: &AppHandle, started_at: Instant, last_emit: &mut Instant, level: f64) {
    if last_emit.elapsed() < Duration::from_millis(120) {
        return;
    }
    *last_emit = Instant::now();
    if let Some(overlay) = app.get_webview_window(OVERLAY_LABEL) {
        emit_overlay_state_to_window(
            &overlay,
            "recording",
            "正在监听语音",
            (started_at.elapsed().as_secs_f64() * 10.0).round() / 10.0,
            if level > 0.08 {
                "检测到语音输入"
            } else {
                "等待说话，按快捷键停止录音"
            },
            level,
        );
    }
}

fn encode_wav(samples: Vec<f32>, sample_rate: u32) -> Result<Vec<u8>, AppError> {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut cursor = Cursor::new(Vec::<u8>::new());
    {
        let mut writer = hound::WavWriter::new(&mut cursor, spec)
            .map_err(|error| AppError::Audio(error.to_string()))?;
        for sample in samples {
            let value = (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
            writer
                .write_sample(value)
                .map_err(|error| AppError::Audio(error.to_string()))?;
        }
        writer
            .finalize()
            .map_err(|error| AppError::Audio(error.to_string()))?;
    }
    Ok(cursor.into_inner())
}

impl AppConfig {
    fn to_view(&self, config_path: PathBuf) -> AppConfigView {
        AppConfigView {
            whisper_cli_path: self.whisper_cli_path.clone(),
            whisper_model_path: self.whisper_model_path.clone(),
            whisper_model_profiles: self.whisper_model_profiles.clone(),
            whisper_threads: self.whisper_threads.clone(),
            asr_engine: self.asr_engine.clone(),
            funasr_endpoint: self.funasr_endpoint.clone(),
            funasr_model: self.funasr_model.clone(),
            funasr_device: self.funasr_device.clone(),
            deepseek_api_key: self.deepseek_api_key.clone(),
            deepseek_model: self.deepseek_model.clone(),
            deepseek_endpoint: self.deepseek_endpoint.clone(),
            deepseek_key_configured: is_configured_secret(&self.deepseek_api_key)
                || !normalize_endpoint(&self.deepseek_endpoint).is_empty(),
            translation_enabled: self.translation_enabled,
            target_language: self.target_language.clone(),
            config_path: config_path.display().to_string(),
            record_shortcut: self.record_shortcut.clone(),
            shortcut_enabled: self.shortcut_enabled,
            polish_prompt: self.polish_prompt.clone(),
        }
    }
}

fn load_or_create_config(app: &AppHandle) -> Result<AppConfig, String> {
    load_dotenv();
    let path = config_path(app)?;
    if !path.exists() {
        let mut config = AppConfig::default();
        normalize_config(app, &mut config);
        save_app_config(app, &config)?;
        return Ok(config);
    }
    let text = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let mut config = serde_json::from_str::<AppConfig>(&text).map_err(|error| error.to_string())?;
    normalize_config(app, &mut config);
    save_app_config(app, &config)?;
    Ok(config)
}

fn normalize_config(_app: &AppHandle, config: &mut AppConfig) {
    if config.asr_engine.trim().is_empty() {
        config.asr_engine = "funasr".to_string();
    }
    if config.polish_prompt.trim().is_empty() {
        config.polish_prompt = build_correction_prompt();
    }
    if config.funasr_endpoint.trim().is_empty() {
        config.funasr_endpoint = "http://10.254.81.32:10095".to_string();
    }
    if config.funasr_model.trim().is_empty() {
        config.funasr_model = "iic/SenseVoiceSmall".to_string();
    }
    if config.funasr_device.trim().is_empty() {
        config.funasr_device = "cpu".to_string();
    }
    if config.deepseek_endpoint.trim().is_empty() && config.deepseek_api_key.trim().is_empty() {
        config.deepseek_endpoint = "http://10.254.81.32:10095".to_string();
    }
    if config.deepseek_api_key.trim().is_empty() {
        config.deepseek_api_key = DEFAULT_DEEPSEEK_API_KEY.to_string();
    }
    config
        .whisper_model_profiles
        .retain(|profile| !is_legacy_voice_transcriber_model_path(profile.path.trim()));
    if is_legacy_voice_transcriber_model_path(config.whisper_model_path.trim()) {
        config.whisper_model_path.clear();
    }
    if !config.whisper_model_path.trim().is_empty()
        && !Path::new(config.whisper_model_path.trim()).is_file()
    {
        if let Some(profile) = first_existing_model_profile(&config.whisper_model_profiles) {
            config.whisper_model_path = profile.path.clone();
        } else {
            config.whisper_model_path.clear();
        }
    }
    upsert_current_model_profile(config);
}

fn is_legacy_voice_transcriber_model_path(path: &str) -> bool {
    path.contains(LEGACY_VOICE_TRANSCRIBER_MODEL_DIR)
}

fn upsert_current_model_profile(config: &mut AppConfig) {
    let model_path = config.whisper_model_path.trim();
    if model_path.is_empty()
        || config
            .whisper_model_profiles
            .iter()
            .any(|profile| profile.path.trim() == model_path)
    {
        return;
    }
    config.whisper_model_profiles.push(WhisperModelProfile {
        name: model_name_from_path(model_path),
        path: model_path.to_string(),
        speed_hint: "自定义".to_string(),
    });
}

fn first_existing_model_profile(profiles: &[WhisperModelProfile]) -> Option<&WhisperModelProfile> {
    profiles
        .iter()
        .find(|profile| Path::new(profile.path.trim()).is_file())
        .or_else(|| profiles.first())
}

fn register_record_shortcut(app: &AppHandle, config: &AppConfig) -> Result<(), String> {
    app.global_shortcut()
        .unregister_all()
        .map_err(|error| format!("快捷键清理失败：{error}"))?;
    if !config.shortcut_enabled || config.record_shortcut.trim().is_empty() {
        return Ok(());
    }
    let shortcut_text = config.record_shortcut.trim().to_string();
    let shortcut = parse_record_shortcut(&shortcut_text)?;
    app.global_shortcut()
        .on_shortcut(shortcut, move |app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                if is_recording(app) {
                    show_voice_overlay(app, "stop");
                    let _ = app.emit(RECORD_SHORTCUT_EVENT, json!({ "action": "stop" }));
                    let app = app.clone();
                    thread::spawn(move || transcribe_recording_from_hotkey(app));
                    return;
                }

                #[cfg(target_os = "macos")]
                remember_frontmost_target_app(app);
                let result = app
                    .try_state::<RecorderState>()
                    .ok_or_else(|| "录音状态未初始化".to_string())
                    .and_then(|state| {
                        start_recording(app.clone(), &state).map_err(|error| error.to_string())
                    });
                match result {
                    Ok(()) => {
                        show_voice_overlay(app, "start");
                        let _ = app.emit(RECORD_SHORTCUT_EVENT, json!({ "action": "start" }));
                    }
                    Err(error) => {
                        emit_overlay_state(app, "error", "录音启动失败", 0.0, &error, 0.1);
                        let _ = app.emit(
                            RECORD_SHORTCUT_EVENT,
                            json!({
                                "action": "error",
                                "error": error
                            }),
                        );
                    }
                }
            }
        })
        .map_err(|error| format!("Unable to register hotkey: {error}"))
}

#[cfg(target_os = "macos")]
fn remember_frontmost_target_app(app: &AppHandle) {
    let Some(pid) = macos_input::frontmost_application_pid() else {
        return;
    };
    if pid == process::id() as i32 {
        return;
    }
    if let Some(state) = app.try_state::<RecorderState>() {
        if let Ok(mut target_pid) = state.target_pid.lock() {
            *target_pid = Some(pid);
        }
    }
}

#[cfg(target_os = "macos")]
fn activate_recording_target_app(app: &AppHandle) -> bool {
    let Some(state) = app.try_state::<RecorderState>() else {
        return false;
    };
    let pid = state
        .target_pid
        .lock()
        .ok()
        .and_then(|mut target_pid| target_pid.take());
    pid.is_some_and(macos_input::activate_application)
}

fn parse_record_shortcut(shortcut: &str) -> Result<Shortcut, String> {
    let shortcut = shortcut.trim();
    if shortcut.is_empty() {
        return Err("快捷键不能为空".to_string());
    }
    if let Ok(parsed) = shortcut.parse::<Shortcut>() {
        return Ok(parsed);
    }
    parse_physical_code_shortcut(shortcut)
}

fn parse_physical_code_shortcut(shortcut: &str) -> Result<Shortcut, String> {
    let tokens: Vec<&str> = shortcut
        .split('+')
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .collect();
    let (key_token, modifier_tokens) = tokens
        .split_last()
        .ok_or_else(|| format!("快捷键格式不支持：{shortcut}"))?;
    let code = key_token
        .parse::<Code>()
        .map_err(|_| format!("快捷键格式不支持：{shortcut}"))?;
    let mut modifiers = Modifiers::empty();
    for token in modifier_tokens {
        match token.to_uppercase().as_str() {
            "OPTION" | "ALT" => modifiers |= Modifiers::ALT,
            "CONTROL" | "CTRL" => modifiers |= Modifiers::CONTROL,
            "COMMAND" | "CMD" | "SUPER" => modifiers |= Modifiers::SUPER,
            "SHIFT" => modifiers |= Modifiers::SHIFT,
            "COMMANDORCONTROL" | "COMMANDORCTRL" | "CMDORCTRL" | "CMDORCONTROL" => {
                #[cfg(target_os = "macos")]
                {
                    modifiers |= Modifiers::SUPER;
                }
                #[cfg(not(target_os = "macos"))]
                {
                    modifiers |= Modifiers::CONTROL;
                }
            }
            _ => return Err(format!("快捷键格式不支持：{shortcut}")),
        }
    }
    let modifiers = if modifiers.is_empty() {
        None
    } else {
        Some(modifiers)
    };
    Ok(Shortcut::new(modifiers, code))
}

fn transcribe_recording_from_hotkey(app: AppHandle) {
    let started_at = Instant::now();
    emit_overlay_state(
        &app,
        "transcribing",
        "本地识别中",
        0.0,
        "正在处理录音",
        0.28,
    );
    let result = (|| -> Result<String, String> {
        let config = load_or_create_config(&app)?;
        let state = app
            .try_state::<RecorderState>()
            .ok_or_else(|| "录音状态未初始化".to_string())?;
        let audio = stop_recording(&state).map_err(|error| error.to_string())?;
        transcribe_audio(audio, &config).map_err(|error| error.to_string())
    })();
    let transcribe_seconds = (started_at.elapsed().as_secs_f64() * 10.0).round() / 10.0;
    match result {
        Ok(text) => {
            emit_overlay_state(
                &app,
                "recognized",
                "识别完成",
                transcribe_seconds,
                "正在准备 AI 处理",
                0.05,
            );
            let _ = app.emit(
                RECORD_TRANSCRIBED_EVENT,
                json!({
                    "ok": true,
                    "text": text,
                    "transcribeSeconds": transcribe_seconds
                }),
            );
        }
        Err(error) => {
            emit_overlay_state(&app, "error", "处理失败", transcribe_seconds, &error, 0.1);
            let _ = app.emit(
                RECORD_TRANSCRIBED_EVENT,
                json!({
                    "ok": false,
                    "error": error,
                    "transcribeSeconds": transcribe_seconds
                }),
            );
        }
    }
}

fn is_recording(app: &AppHandle) -> bool {
    app.try_state::<RecorderState>()
        .and_then(|state| {
            state
                .controller
                .lock()
                .ok()
                .map(|controller| controller.is_some())
        })
        .unwrap_or(false)
}

fn show_voice_overlay(app: &AppHandle, action: &str) {
    if let Some(overlay) = app.get_webview_window(OVERLAY_LABEL) {
        prepare_voice_overlay(&overlay);
        let _ = overlay.show();
        let _ = overlay.set_always_on_top(true);
        let (stage, status, text, level) = if action == "stop" {
            ("stopping", "正在停止录音", "正在收束音频并准备识别", 0.18)
        } else {
            ("recording", "正在监听语音", "再次按下快捷键停止录音", 0.42)
        };
        emit_overlay_state_to_window(&overlay, stage, status, 0.0, text, level);
    }
}

fn emit_overlay_state(
    app: &AppHandle,
    stage: &str,
    status: &str,
    seconds: f64,
    text: &str,
    level: f64,
) {
    if let Some(overlay) = app.get_webview_window(OVERLAY_LABEL) {
        prepare_voice_overlay(&overlay);
        let _ = overlay.show();
        let _ = overlay.set_always_on_top(true);
        emit_overlay_state_to_window(&overlay, stage, status, seconds, text, level);
    }
}

fn prepare_voice_overlay(overlay: &tauri::WebviewWindow) {
    #[cfg(target_os = "macos")]
    let _ = overlay.set_focusable(false);
    #[cfg(not(target_os = "macos"))]
    let _ = overlay;
}

fn emit_overlay_state_to_window(
    overlay: &tauri::WebviewWindow,
    stage: &str,
    status: &str,
    seconds: f64,
    text: &str,
    level: f64,
) {
    let _ = overlay.emit(
        OVERLAY_STATE_EVENT,
        json!({
            "stage": stage,
            "status": status,
            "seconds": seconds,
            "text": text,
            "level": level
        }),
    );
}

fn save_app_config(app: &AppHandle, config: &AppConfig) -> Result<(), String> {
    let path = config_path(app)?;
    ensure_parent(&path)?;
    let text = serde_json::to_string_pretty(config).map_err(|error| error.to_string())?;
    fs::write(path, text).map_err(|error| error.to_string())
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法获取应用数据目录：{error}"))?;
    fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    Ok(dir)
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("config.json"))
}

fn voice_history_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("voice-history.json"))
}

fn read_voice_history(app: &AppHandle) -> Result<Vec<VoiceHistoryItem>, AppError> {
    let path = voice_history_path(app).map_err(AppError::Io)?;
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let text = fs::read_to_string(path).map_err(|error| AppError::Io(error.to_string()))?;
    let mut items: Vec<VoiceHistoryItem> =
        serde_json::from_str(&text).map_err(|error| AppError::Io(error.to_string()))?;
    normalize_voice_history(&mut items);
    Ok(items)
}

fn write_voice_history(app: &AppHandle, items: &[VoiceHistoryItem]) -> Result<(), AppError> {
    let path = voice_history_path(app).map_err(AppError::Io)?;
    ensure_parent(&path).map_err(AppError::Io)?;
    let mut next_items = items.to_vec();
    normalize_voice_history(&mut next_items);
    let text = serde_json::to_string_pretty(&next_items)
        .map_err(|error| AppError::Io(error.to_string()))?;
    fs::write(path, text).map_err(|error| AppError::Io(error.to_string()))
}

fn record_voice_history_inner(app: &AppHandle, text: String) -> Result<VoiceHistoryItem, AppError> {
    let text = text.trim();
    if text.is_empty() {
        return Err(AppError::Io("历史文本为空".to_string()));
    }
    let created_at = current_timestamp_millis();
    let item = VoiceHistoryItem {
        id: format!("voice-{created_at}-{}", text.len()),
        text: text.to_string(),
        created_at,
    };
    let mut items = read_voice_history(app)?;
    items.insert(0, item.clone());
    normalize_voice_history(&mut items);
    write_voice_history(app, &items)?;
    Ok(item)
}

fn normalize_voice_history(items: &mut Vec<VoiceHistoryItem>) {
    items.retain(|item| !item.text.trim().is_empty());
    items.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    items.dedup_by(|left, right| left.id == right.id);
    if items.len() > MAX_VOICE_HISTORY_ITEMS {
        items.truncate(MAX_VOICE_HISTORY_ITEMS);
    }
}

fn current_timestamp_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn output_text_to_cursor_inner(app: &AppHandle, text: String) -> Result<(), AppError> {
    let text = text.trim();
    if text.is_empty() {
        return Ok(());
    }
    write_text_to_clipboard(text)?;
    if let Some(overlay) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = overlay.hide();
    }
    #[cfg(target_os = "macos")]
    {
        let restored = activate_recording_target_app(app);
        thread::sleep(Duration::from_millis(if restored { 360 } else { 240 }));
    }
    #[cfg(not(target_os = "macos"))]
    thread::sleep(Duration::from_millis(180));
    paste_clipboard_to_frontmost_app()
}

#[cfg(target_os = "macos")]
fn write_text_to_clipboard(text: &str) -> Result<(), AppError> {
    let mut child = Command::new("pbcopy")
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|error| AppError::Output(format!("写入剪贴板失败：{error}")))?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(text.as_bytes())
            .map_err(|error| AppError::Output(format!("写入剪贴板失败：{error}")))?;
    }
    let status = child
        .wait()
        .map_err(|error| AppError::Output(format!("等待剪贴板写入失败：{error}")))?;
    if !status.success() {
        return Err(AppError::Output(format!("pbcopy 退出异常：{status}")));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn write_text_to_clipboard(text: &str) -> Result<(), AppError> {
    windows_input::write_clipboard_text(text)
        .map_err(|error| AppError::Output(format!("写入剪贴板失败：{error}")))
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn write_text_to_clipboard(text: &str) -> Result<(), AppError> {
    let mut child = Command::new("pbcopy")
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|error| AppError::Output(format!("写入剪贴板失败：{error}")))?;
    if let Some(stdin) = child.stdin.as_mut() {
        stdin
            .write_all(text.as_bytes())
            .map_err(|error| AppError::Output(format!("写入剪贴板失败：{error}")))?;
    }
    let status = child
        .wait()
        .map_err(|error| AppError::Output(format!("等待剪贴板写入失败：{error}")))?;
    if !status.success() {
        return Err(AppError::Output(format!("pbcopy 退出异常：{status}")));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn paste_clipboard_to_frontmost_app() -> Result<(), AppError> {
    if !macos_input::accessibility_trusted() {
        macos_input::prompt_accessibility_once();
        return Err(AppError::Output(
            "自动粘贴需要辅助功能权限：请在系统设置中打开“鱼泡语音助手”。文本已写入剪贴板。"
                .to_string(),
        ));
    }
    macos_input::send_command_v().map_err(AppError::Output)
}

#[cfg(target_os = "macos")]
fn accessibility_permission_trusted() -> bool {
    macos_input::accessibility_trusted()
}

#[cfg(not(target_os = "macos"))]
fn accessibility_permission_trusted() -> bool {
    true
}

#[cfg(target_os = "macos")]
fn open_accessibility_settings_inner() -> Result<(), String> {
    let status = Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
        .status()
        .map_err(|error| format!("打开辅助功能设置失败：{error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("打开辅助功能设置失败：{status}"))
    }
}

#[cfg(not(target_os = "macos"))]
fn open_accessibility_settings_inner() -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "windows")]
fn paste_clipboard_to_frontmost_app() -> Result<(), AppError> {
    windows_input::send_ctrl_v().map_err(AppError::Output)
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn paste_clipboard_to_frontmost_app() -> Result<(), AppError> {
    run_osascript(
        r#"tell application "System Events" to keystroke "v" using command down"#,
        "自动粘贴失败，请在系统设置里给应用开启辅助功能权限",
    )
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn run_osascript(script: &str, context: &str) -> Result<(), AppError> {
    let output = Command::new("osascript")
        .args(["-e", script])
        .output()
        .map_err(|error| AppError::Output(format!("{context}：{error}")))?;
    if output.status.success() {
        return Ok(());
    }
    let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(AppError::Output(if message.is_empty() {
        context.to_string()
    } else {
        format!("{context}：{message}")
    }))
}

fn ensure_parent(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn transcribe_audio(audio: Vec<u8>, config: &AppConfig) -> Result<String, AppError> {
    if config.asr_engine.trim().eq_ignore_ascii_case("funasr") {
        return transcribe_with_funasr(audio, config);
    }
    if !has_valid_whisper_model(config) {
        return transcribe_with_funasr(audio, config);
    }
    transcribe_with_whisper(audio, config)
}

fn has_valid_whisper_model(config: &AppConfig) -> bool {
    let model_path = config.whisper_model_path.trim();
    !model_path.is_empty() && Path::new(model_path).is_file()
}

fn transcribe_with_whisper(audio: Vec<u8>, config: &AppConfig) -> Result<String, AppError> {
    let model_path = config.whisper_model_path.trim();
    if model_path.is_empty() || !Path::new(model_path).is_file() {
        return Err(AppError::MissingWhisperModel);
    }
    let whisper_cli_path = config.whisper_cli_path.trim();
    if whisper_cli_path.is_empty() {
        return Err(AppError::WhisperFailed(
            "请先配置 whisper.cpp 可执行文件路径".to_string(),
        ));
    }

    let temp_dir = Builder::new()
        .prefix("local-voice-assistant-")
        .tempdir()
        .map_err(|error| AppError::Io(error.to_string()))?;
    let audio_path = temp_dir.path().join("input.wav");
    let output_prefix = temp_dir.path().join("transcript");
    fs::write(&audio_path, audio).map_err(|error| AppError::Io(error.to_string()))?;

    let args = vec![
        "-m".to_string(),
        model_path.to_string(),
        "-f".to_string(),
        path_to_str(&audio_path)?.to_string(),
        "-l".to_string(),
        "auto".to_string(),
        "-t".to_string(),
        config.whisper_threads.trim().to_string(),
        "-fa".to_string(),
        "-otxt".to_string(),
        "-of".to_string(),
        path_to_str(&output_prefix)?.to_string(),
    ];

    let output = Command::new(whisper_cli_path)
        .args(args)
        .output()
        .map_err(|error| AppError::WhisperFailed(error.to_string()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(AppError::WhisperFailed(stderr));
    }

    let transcript_path = PathBuf::from(format!("{}.txt", output_prefix.display()));
    let transcript = fs::read_to_string(&transcript_path)
        .unwrap_or_else(|_| String::from_utf8_lossy(&output.stdout).to_string());
    Ok(clean_whisper_text(&transcript))
}

fn transcribe_with_funasr(audio: Vec<u8>, config: &AppConfig) -> Result<String, AppError> {
    let endpoint = normalize_endpoint(config.funasr_endpoint.trim());
    if endpoint.is_empty() {
        return Err(AppError::WhisperFailed(
            "请先配置 FunASR 服务地址".to_string(),
        ));
    }
    let temp_dir = Builder::new()
        .prefix("local-voice-assistant-funasr-")
        .tempdir()
        .map_err(|error| AppError::Io(error.to_string()))?;
    let audio_path = temp_dir.path().join("input.wav");
    fs::write(&audio_path, audio).map_err(|error| AppError::Io(error.to_string()))?;

    let form = reqwest::blocking::multipart::Form::new()
        .file("file", &audio_path)
        .map_err(|error| AppError::Io(error.to_string()))?;
    let response = reqwest::blocking::Client::new()
        .post(format!("{endpoint}/transcribe"))
        .multipart(form)
        .send()
        .map_err(|error| AppError::WhisperFailed(format!("FunASR 服务请求失败：{error}")))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().unwrap_or_default();
        return Err(AppError::WhisperFailed(format!(
            "FunASR 服务返回错误：{status} {body}"
        )));
    }
    let data = response
        .json::<Value>()
        .map_err(|error| AppError::WhisperFailed(error.to_string()))?;
    let text = data
        .get("text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if text.is_empty() {
        return Err(AppError::WhisperFailed("FunASR 未返回识别文本".to_string()));
    }
    Ok(clean_whisper_text(&text))
}

async fn check_funasr_health(config: &AppConfig) -> Result<FunAsrHealthView, String> {
    let endpoint = normalize_endpoint(config.funasr_endpoint.trim());
    let response = Client::new()
        .get(format!("{endpoint}/health"))
        .send()
        .await
        .map_err(|error| format!("FunASR 服务不可用：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("FunASR 服务异常：{}", response.status()));
    }
    let value = response
        .json::<Value>()
        .await
        .map_err(|error| error.to_string())?;
    Ok(FunAsrHealthView {
        ok: value.get("ok").and_then(Value::as_bool).unwrap_or(false),
        message: "FunASR 服务可用".to_string(),
        model: value
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        device: value
            .get("device")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    })
}

fn normalize_endpoint(endpoint: &str) -> String {
    endpoint.trim().trim_end_matches('/').to_string()
}

fn parse_funasr_endpoint(endpoint: &str) -> (String, String) {
    let endpoint = endpoint
        .trim()
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .trim_end_matches('/');
    let mut parts = endpoint.split(':');
    let host = parts
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or("127.0.0.1");
    let port = parts
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or("10095");
    (host.to_string(), port.to_string())
}

async fn call_deepseek(
    input: &str,
    target_language: &str,
    config: &AppConfig,
) -> Result<AssistantResult, AppError> {
    let correction = call_deepseek_correction(input, config).await?;
    let translation =
        call_deepseek_translation(correction.corrected_text.as_str(), target_language, config)
            .await?;
    Ok(AssistantResult {
        corrected_text: correction.corrected_text,
        translation,
        notes: correction.notes,
        confidence: correction.confidence,
    })
}

async fn call_deepseek_correction(
    input: &str,
    config: &AppConfig,
) -> Result<CorrectionResult, AppError> {
    let prompt = effective_polish_prompt(config);
    let endpoint = normalize_endpoint(config.deepseek_endpoint.trim());
    if !endpoint.is_empty() {
        return call_cloud_deepseek_correction(input, &prompt, &endpoint).await;
    }

    let api_key = config.deepseek_api_key.trim();
    if !is_configured_secret(api_key) {
        return Err(AppError::MissingDeepSeekKey);
    }

    let payload = json!({
        "model": config.deepseek_model.trim(),
        "temperature": 0.1,
        "response_format": { "type": "json_object" },
        "messages": [
            { "role": "system", "content": prompt },
            { "role": "user", "content": input }
        ]
    });

    let response = Client::new()
        .post("https://api.deepseek.com/chat/completions")
        .bearer_auth(api_key.to_string())
        .json(&payload)
        .send()
        .await
        .map_err(|error| AppError::DeepSeekFailed(error.to_string()))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(AppError::DeepSeekFailed(format!("{} {}", status, body)));
    }

    let data = response
        .json::<DeepSeekResponse>()
        .await
        .map_err(|error| AppError::DeepSeekFailed(error.to_string()))?;
    let content = data
        .choices
        .first()
        .map(|choice| choice.message.content.trim().to_string())
        .unwrap_or_default();

    if content.trim().is_empty() {
        return Ok(fallback_correction_result(
            input,
            "AI 润色返回空内容，已保留识别文本。",
        ));
    }

    parse_correction_result(&content).or_else(|error| {
        Ok(fallback_correction_result(
            input,
            format!("AI 润色结果不是有效 JSON，已保留识别文本：{error}").as_str(),
        ))
    })
}

async fn call_deepseek_translation(
    input: &str,
    target_language: &str,
    config: &AppConfig,
) -> Result<String, AppError> {
    let endpoint = normalize_endpoint(config.deepseek_endpoint.trim());
    if !endpoint.is_empty() {
        return call_cloud_deepseek_translation(input, target_language, &endpoint).await;
    }

    let api_key = config.deepseek_api_key.trim();
    if !is_configured_secret(api_key) {
        return Err(AppError::MissingDeepSeekKey);
    }

    let prompt = build_translation_prompt(target_language);
    let payload = json!({
        "model": config.deepseek_model.trim(),
        "temperature": 0.1,
        "response_format": { "type": "json_object" },
        "messages": [
            { "role": "system", "content": prompt },
            { "role": "user", "content": input }
        ]
    });

    let response = Client::new()
        .post("https://api.deepseek.com/chat/completions")
        .bearer_auth(api_key.to_string())
        .json(&payload)
        .send()
        .await
        .map_err(|error| AppError::DeepSeekFailed(error.to_string()))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(AppError::DeepSeekFailed(format!("{} {}", status, body)));
    }

    let data = response
        .json::<DeepSeekResponse>()
        .await
        .map_err(|error| AppError::DeepSeekFailed(error.to_string()))?;
    let content = data
        .choices
        .first()
        .map(|choice| choice.message.content.trim().to_string())
        .unwrap_or_default();

    if content.trim().is_empty() {
        return Ok(String::new());
    }
    parse_translation_result(&content).or_else(|_| Ok(String::new()))
}

async fn call_cloud_deepseek_correction(
    input: &str,
    prompt: &str,
    endpoint: &str,
) -> Result<CorrectionResult, AppError> {
    let response = Client::new()
        .post(format!("{endpoint}/polish"))
        .json(&json!({ "input": input, "prompt": prompt }))
        .send()
        .await
        .map_err(|error| {
            AppError::DeepSeekFailed(format!("服务端 DeepSeek 代理不可用：{error}"))
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(AppError::DeepSeekFailed(format!(
            "服务端 DeepSeek 代理返回错误：{status} {body}"
        )));
    }

    response
        .json::<CorrectionResult>()
        .await
        .map_err(|error| AppError::DeepSeekFailed(error.to_string()))
}

async fn call_cloud_deepseek_translation(
    input: &str,
    target_language: &str,
    endpoint: &str,
) -> Result<String, AppError> {
    let response = Client::new()
        .post(format!("{endpoint}/translate"))
        .json(&json!({
            "input": input,
            "target_language": target_language
        }))
        .send()
        .await
        .map_err(|error| {
            AppError::DeepSeekFailed(format!("服务端 DeepSeek 代理不可用：{error}"))
        })?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(AppError::DeepSeekFailed(format!(
            "服务端 DeepSeek 代理返回错误：{status} {body}"
        )));
    }

    let value = response
        .json::<Value>()
        .await
        .map_err(|error| AppError::DeepSeekFailed(error.to_string()))?;
    Ok(value
        .get("translation")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string())
}

fn effective_polish_prompt(config: &AppConfig) -> String {
    let custom = config.polish_prompt.trim();
    if custom.is_empty() {
        build_correction_prompt()
    } else {
        custom.to_string()
    }
}

fn build_correction_prompt() -> String {
    r#"你是一个语音识别润色助手。
你的任务：
1. 修正 ASR 语音识别导致的错字、同音词、断句错误和口语停顿。
2. 保留说话人的原意，不扩写、不编造事实。
3. 专有名词、代码标识符、产品名、英文缩写尽量保持原文。
4. 只返回 JSON，不要返回 Markdown。

JSON 字段：
- corrected_text: string，纠正后的原文。
- notes: string[]，最多 3 条，说明关键润色点；没有就返回空数组。
- confidence: string，只能是 high / medium / low。
"#
    .to_string()
}

fn build_translation_prompt(target_language: &str) -> String {
    format!(
        r#"你是一个实时翻译助手。
你的任务：
1. 将用户输入翻译为：{target_language}。
2. 保留原文含义，不扩写、不编造事实。
3. 专有名词、代码标识符、产品名、英文缩写尽量保持原文。
4. 只返回 JSON，不要返回 Markdown。

JSON 字段：
- translation: string，翻译结果。
"#
    )
}

fn parse_correction_result(content: &str) -> Result<CorrectionResult, AppError> {
    serde_json::from_str::<CorrectionResult>(content).or_else(|_| {
        let value = serde_json::from_str::<Value>(content)
            .map_err(|error| AppError::DeepSeekFailed(error.to_string()))?;
        serde_json::from_value::<CorrectionResult>(value)
            .map_err(|error| AppError::DeepSeekFailed(error.to_string()))
    })
}

fn fallback_correction_result(input: &str, note: &str) -> CorrectionResult {
    CorrectionResult {
        corrected_text: input.trim().to_string(),
        notes: vec![note.to_string()],
        confidence: "low".to_string(),
    }
}

fn parse_translation_result(content: &str) -> Result<String, AppError> {
    let value = serde_json::from_str::<Value>(content)
        .map_err(|error| AppError::DeepSeekFailed(error.to_string()))?;
    value
        .get("translation")
        .and_then(Value::as_str)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::DeepSeekFailed("翻译结果缺少 translation 字段".to_string()))
}

fn clean_whisper_text(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn load_dotenv() {
    let _ = dotenvy::from_filename(".env.local");
    let _ = dotenvy::dotenv();
}

fn whisper_cli_path_from_env() -> String {
    env::var("WHISPER_CLI_PATH").unwrap_or_else(|_| {
        first_existing_path(&[
            "/opt/homebrew/bin/whisper-cli",
            "/usr/local/bin/whisper-cli",
            "whisper-cli",
        ])
    })
}

fn default_record_shortcut() -> String {
    "CommandOrControl+1".to_string()
}

fn default_translation_enabled() -> bool {
    false
}

fn default_whisper_model_path() -> String {
    env::var("WHISPER_MODEL_PATH").unwrap_or_default()
}

fn default_model_profiles() -> Vec<WhisperModelProfile> {
    let path = default_whisper_model_path();
    if path.trim().is_empty() {
        return Vec::new();
    }
    vec![WhisperModelProfile {
        name: model_name_from_path(&path),
        path,
        speed_hint: "用户配置".to_string(),
    }]
}

fn model_name_from_path(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .and_then(|name| name.to_str())
        .map(|name| name.to_string())
        .unwrap_or_else(|| "自定义模型".to_string())
}

fn first_existing_path(candidates: &[&str]) -> String {
    candidates
        .iter()
        .find(|path| Path::new(path).exists())
        .or_else(|| candidates.last())
        .map(|path| path.to_string())
        .unwrap_or_default()
}

fn is_configured_secret(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty() && !trimmed.eq_ignore_ascii_case("REPLACE_WITH_YOUR_DEEPSEEK_KEY")
}

fn path_to_str(path: &Path) -> Result<&str, AppError> {
    path.to_str()
        .ok_or_else(|| AppError::Io("路径包含无法识别的字符".to_string()))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();
            let config = load_or_create_config(&handle)?;
            if let Err(error) = register_record_shortcut(&handle, &config) {
                eprintln!("record shortcut register failed: {error}");
            }
            #[cfg(target_os = "macos")]
            if !macos_input::accessibility_trusted() {
                macos_input::prompt_accessibility_once();
            }
            Ok(())
        })
        .manage(RecorderState::default())
        .invoke_handler(tauri::generate_handler![
            get_app_config,
            load_config,
            save_config,
            output_text_to_cursor,
            check_accessibility_permission,
            open_accessibility_settings,
            copy_text_to_clipboard,
            record_voice_history,
            list_voice_history,
            delete_voice_history,
            clear_voice_history,
            start_native_recording,
            cancel_native_recording,
            close_voice_overlay,
            stop_recording_and_transcribe,
            check_funasr_service,
            start_funasr_service,
            polish_text,
            translate_text,
            polish_and_translate,
            default_polish_prompt
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
