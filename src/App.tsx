import {
  Bot,
  BarChart3,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  History,
  Home,
  Keyboard,
  Languages,
  Loader2,
  Mic,
  Pause,
  RotateCcw,
  Save,
  Server,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  X
} from "lucide-react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow, Window } from "@tauri-apps/api/window";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AssistantResult,
  AppConfig,
  AccessibilityPermissionView,
  VoiceHistoryItem,
  WhisperModelProfile,
  cancelNativeRecording,
  checkAccessibilityPermission,
  resolveFunasrService,
  checkNativeRecording,
  closeVoiceOverlay,
  clearUsageStats,
  clearVoiceHistory,
  copyTextToClipboard,
  deleteVoiceHistory,
  getDefaultPolishPrompt,
  getUsageStats,
  listVoiceHistory,
  loadConfig,
  openAccessibilitySettings,
  outputTextToCursor,
  polishText,
  recordVoiceSession,
  saveConfig,
  startFunasrService,
  startNativeRecording,
  stopRecordingAndTranscribe,
  translateText,
  UsageStatsSummary
} from "./tauri";
import {
  SERVICE_PROFILE_OPTIONS,
  SERVICE_PROFILE_CUSTOM,
  SERVICE_PROFILE_FAST,
  SERVICE_PROFILE_STABLE,
  getServiceProfileEndpoints,
  getServiceProfileLabel,
  isCustomServiceProfile,
  normalizeServiceProfile,
  type ServiceProfile
} from "./serviceProfiles";

type Stage = "idle" | "recording" | "stopping" | "transcribing" | "recognized" | "polishing" | "translating" | "done" | "error";
type Section = "home" | "permission" | "hotkey" | "ai" | "model" | "history" | "stats";
type VoiceOverlayState = {
  stage: Stage;
  status: string;
  seconds: number;
  text?: string;
  level?: number;
  transcribeSeconds?: number;
  correctionSeconds?: number;
  translationSeconds?: number;
};
type ShortcutAction = "start" | "stop" | "error";
type ShortcutPayload = {
  action?: ShortcutAction;
  error?: string;
};
type TranscribedPayload = {
  ok: boolean;
  processed?: boolean;
  text?: string;
  result?: AssistantResult;
  error?: string;
  transcribeSeconds?: number;
  correctionSeconds?: number;
  translationSeconds?: number;
};

const MAX_SECONDS = 60;
const HISTORY_PAGE_SIZE = 10;
const PROCESSING_STAGES: Stage[] = ["stopping", "transcribing", "recognized", "polishing", "translating"];
const MAIN_LABEL = "main";
const OVERLAY_LABEL = "voice-overlay";
const OVERLAY_STATE_EVENT = "voice-overlay-state";
const OVERLAY_CANCEL_EVENT = "voice-overlay-cancel";
const RECORD_SHORTCUT_EVENT = "record-shortcut-pressed";
const RECORD_TRANSCRIBED_EVENT = "record-transcribed";
const ACTIVE_VOICE_LEVEL = 0.025;
const DEFAULT_CONFIG: AppConfig = {
  whisper_cli_path: "/usr/local/bin/whisper-cli",
  whisper_model_path: "",
  whisper_model_profiles: [],
  whisper_threads: "8",
  asr_engine: "funasr",
  service_profile: SERVICE_PROFILE_FAST,
  funasr_endpoint: "http://10.254.10.76:10095",
  funasr_model: "iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
  funasr_device: "cpu",
  deepseek_api_key: "sk-5ccffb5099bb43cc9e98d85386b25cec",
  deepseek_model: "deepseek-v4-flash",
  deepseek_endpoint: "http://10.254.10.76:10095",
  llm_base_url: "",
  deepseek_key_configured: true,
  translation_enabled: false,
  polish_enabled: false,
  target_language: "中文",
  config_path: "",
  record_shortcut: "CommandOrControl+1",
  shortcut_enabled: true,
  polish_prompt: "",
  typing_speed_cpm: 28
};
const SHORTCUT_PRESETS = ["F2", "F3", "F4", "F8", "CapsLock", "CommandOrControl+1", "CommandOrControl+Shift+Space", "CommandOrControl+Alt+Space"];

export function App() {
  if (getSafeWindowLabel() === OVERLAY_LABEL) {
    return <VoiceOverlayWindow />;
  }
  return <MainApp />;
}

function MainApp() {
  const stageRef = useRef<Stage>("idle");
  const timerRef = useRef<number>();
  const processingTimerRef = useRef<number>();
  const overlayHideTimerRef = useRef<number>();
  const recordingStartedAtRef = useRef<number>();
  const shortcutActionRef = useRef<(action?: ShortcutAction) => void>(() => undefined);
  const configRef = useRef<AppConfig>(DEFAULT_CONFIG);
  const targetLanguageRef = useRef("中文");
  const lastHandledTranscriptionRef = useRef("");
  const voiceInputCanceledRef = useRef(false);
  const [stage, setStage] = useState<Stage>("idle");
  const [seconds, setSeconds] = useState(0);
  const [processingSeconds, setProcessingSeconds] = useState(0);
  const [transcribeSeconds, setTranscribeSeconds] = useState<number>();
  const [correctionSeconds, setCorrectionSeconds] = useState<number>();
  const [translationSeconds, setTranslationSeconds] = useState<number>();
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const [activeSection, setActiveSection] = useState<Section>("home");
  const [configMessage, setConfigMessage] = useState("");
  const [funasrBusy, setFunasrBusy] = useState(false);
  const [recordingCheckBusy, setRecordingCheckBusy] = useState(false);
  const [recordingCheckMessage, setRecordingCheckMessage] = useState("");
  const [recordingCheckOk, setRecordingCheckOk] = useState<boolean>();
  const [shortcutError, setShortcutError] = useState("");
  const [isCapturingShortcut, setIsCapturingShortcut] = useState(false);
  const [modelNameDraft, setModelNameDraft] = useState("");
  const [modelPathDraft, setModelPathDraft] = useState("");
  const [transcript, setTranscript] = useState("");
  const [historyItems, setHistoryItems] = useState<VoiceHistoryItem[]>([]);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyMessage, setHistoryMessage] = useState("");
  const [usageStats, setUsageStats] = useState<UsageStatsSummary | null>(null);
  const [statsBusy, setStatsBusy] = useState(false);
  const [statsMessage, setStatsMessage] = useState("");
  const [typingSpeedInput, setTypingSpeedInput] = useState("28");
  const sessionRecordingSecondsRef = useRef(0);
  const [targetLanguage, setTargetLanguage] = useState("中文");
  const [result, setResult] = useState<AssistantResult>();
  const [accessibilityStatus, setAccessibilityStatus] = useState<AccessibilityPermissionView>();
  const [appVersion, setAppVersion] = useState("");
  const [funasrHealthOk, setFunasrHealthOk] = useState<boolean | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    loadConfig()
      .then((nextConfig) => {
        setConfig(nextConfig);
        configRef.current = nextConfig;
        setTargetLanguage(nextConfig.target_language || "中文");
        targetLanguageRef.current = nextConfig.target_language || "中文";
        if (nextConfig.asr_engine === "funasr") {
          void refreshFunasrHealth();
        }
      })
      .catch((err) => setError(toUserFacingError(err)));
    void refreshAccessibilityStatus();
    void getVersion()
      .then(setAppVersion)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    setTypingSpeedInput(String(config.typing_speed_cpm ?? 28));
  }, [config.typing_speed_cpm]);

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  useEffect(() => {
    targetLanguageRef.current = targetLanguage;
  }, [targetLanguage]);

  useEffect(() => {
    if (activeSection === "history") {
      void refreshHistory();
    }
    if (activeSection === "stats") {
      void refreshUsageStats();
    }
    if (activeSection === "permission") {
      void refreshAccessibilityStatus();
    }
    if (activeSection === "model" && configRef.current.asr_engine === "funasr") {
      void refreshFunasrHealth();
    }
  }, [activeSection]);

  useEffect(() => {
    stageRef.current = stage;
  }, [stage]);

  function transitionStage(nextStage: Stage) {
    stageRef.current = nextStage;
    setStage(nextStage);
  }

  useEffect(() => {
    shortcutActionRef.current = (action) => {
      if (PROCESSING_STAGES.includes(stageRef.current)) {
        return;
      }
      if (action === "error") {
        return;
      }
      if (action === "stop") {
        prepareHotkeyStop();
        return;
      }
      if (stageRef.current === "recording") {
        prepareHotkeyStop();
        return;
      }
      beginRecordingUi();
    };
  });

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<ShortcutPayload>(RECORD_SHORTCUT_EVENT, (event) => {
      if (event.payload?.action === "error") {
        const message = event.payload.error || "全局快捷键启动录音失败，请回到主窗口重试。";
        transitionStage("error");
        setError(message);
        void showOverlayState("error", "录音启动失败", 0, message);
        scheduleOverlayHide();
        return;
      }
      shortcutActionRef.current(event.payload?.action);
    }).then((handler) => {
      unlisten = handler;
    });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void listen(OVERLAY_CANCEL_EVENT, () => {
      cancelCurrentVoiceInput();
    }).then((handler) => {
      if (disposed) {
        handler();
        return;
      }
      unlisten = handler;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void listen<TranscribedPayload>(RECORD_TRANSCRIBED_EVENT, (event) => {
      void handleTranscribedPayload(event.payload);
    }).then((handler) => {
      if (disposed) {
        handler();
        return;
      }
      unlisten = handler;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!isCapturingShortcut) {
      return;
    }
    const captureState = {
      pressedModifiers: new Set<string>(),
      chordModifiers: new Set<string>(),
      chordCommitted: false
    };
    const resetCaptureState = () => {
      captureState.pressedModifiers.clear();
      captureState.chordModifiers.clear();
      captureState.chordCommitted = false;
    };
    const commitShortcut = (shortcut: string) => {
      resetCaptureState();
      void saveShortcut(shortcut);
    };
    const handler = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) {
        return;
      }
      const key = normalizeKey(event);
      if (!key) {
        return;
      }
      if (isPhysicalModifierKey(key)) {
        captureState.pressedModifiers.add(key);
        captureState.chordModifiers.add(key);
        return;
      }
      const shortcut = normalizeShortcut(event);
      if (!shortcut) {
        return;
      }
      captureState.chordCommitted = true;
      commitShortcut(shortcut);
    };
    const releaseHandler = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const key = normalizeKey(event);
      if (!key || !isPhysicalModifierKey(key)) {
        return;
      }
      captureState.pressedModifiers.delete(key);
      if (captureState.chordCommitted || captureState.pressedModifiers.size > 0) {
        return;
      }
      const shortcut = buildModifierOnlyShortcut(captureState.chordModifiers);
      if (shortcut) {
        commitShortcut(shortcut);
      } else {
        resetCaptureState();
      }
    };
    const blurHandler = () => resetCaptureState();
    window.addEventListener("keydown", handler, true);
    window.addEventListener("keyup", releaseHandler, true);
    window.addEventListener("blur", blurHandler, true);
    return () => {
      window.removeEventListener("keydown", handler, true);
      window.removeEventListener("keyup", releaseHandler, true);
      window.removeEventListener("blur", blurHandler, true);
    };
  }, [isCapturingShortcut, config]);

  const progress = useMemo(() => `${Math.min(100, (seconds / MAX_SECONDS) * 100)}%`, [seconds]);
  const busy = PROCESSING_STAGES.includes(stage);
  const isMacos = accessibilityStatus?.platform === "macos";

  async function refreshAccessibilityStatus() {
    try {
      const status = await checkAccessibilityPermission();
      setAccessibilityStatus(status);
    } catch {
      setAccessibilityStatus(undefined);
    }
  }

  async function openMacosAccessibilitySettings() {
    try {
      await openAccessibilitySettings();
      await refreshAccessibilityStatus();
    } catch (err) {
      setError(toUserFacingError(err));
    }
  }

  async function startRecording() {
    if (stageRef.current === "recording" || PROCESSING_STAGES.includes(stageRef.current)) {
      return;
    }
    setError("");
    voiceInputCanceledRef.current = false;
    try {
      await startNativeRecording();
      beginRecordingUi();
    } catch (err) {
      transitionStage("error");
      const message = toUserFacingError(err);
      setError(message);
      void showOverlayState("error", "录音启动失败", 0, message);
      scheduleOverlayHide();
    }
  }

  function beginRecordingUi() {
    if (stageRef.current === "recording" || PROCESSING_STAGES.includes(stageRef.current)) {
      return;
    }
    clearTimer();
    clearProcessingTimer();
    stageRef.current = "recording";
    setError("");
    setResult(undefined);
    setTranscript("");
    lastHandledTranscriptionRef.current = "";
    voiceInputCanceledRef.current = false;
    setSeconds(0);
    setProcessingSeconds(0);
    setTranscribeSeconds(undefined);
    setCorrectionSeconds(undefined);
    setTranslationSeconds(undefined);
    transitionStage("recording");
    const startedAt = Date.now();
    recordingStartedAtRef.current = startedAt;
    void showOverlayState("recording", "正在监听语音", 0, "等待说话，按快捷键停止录音", 0.02);
    timerRef.current = window.setInterval(() => {
      const nextSeconds = Math.min(MAX_SECONDS, (Date.now() - startedAt) / 1000);
      setSeconds(nextSeconds);
      if (nextSeconds >= MAX_SECONDS) {
        void stopRecordingFromUi();
      }
    }, 200);
  }

  function prepareHotkeyStop() {
    if (stageRef.current !== "recording") {
      return;
    }
    const finalSeconds = recordingStartedAtRef.current
      ? Math.min(MAX_SECONDS, (Date.now() - recordingStartedAtRef.current) / 1000)
      : seconds;
    sessionRecordingSecondsRef.current = finalSeconds;
    clearTimer();
    recordingStartedAtRef.current = undefined;
    setSeconds(finalSeconds);
    startProcessingTimer();
    transitionStage("transcribing");
    void showOverlayState("transcribing", "本地识别中", 0, `${asrEngineName(configRef.current)} 正在处理录音`, 0.28);
  }

  async function stopRecordingFromUi() {
    if (stageRef.current !== "recording") {
      return;
    }
    sessionRecordingSecondsRef.current = seconds;
    clearTimer();
    recordingStartedAtRef.current = undefined;
    startProcessingTimer();
    transitionStage("stopping");
    void showOverlayState("stopping", "正在停止录音", seconds, "正在收束音频并准备识别", 0.18);
    try {
      await nextPaint();
      transitionStage("transcribing");
      void showOverlayState("transcribing", "本地识别中", 0, `${asrEngineName(configRef.current)} 正在处理录音`, 0.28);
      const transcribeStartedAt = performance.now();
      const text = await stopRecordingAndTranscribe();
      const nextTranscribeSeconds = elapsedSeconds(transcribeStartedAt);
      if (voiceInputCanceledRef.current) {
        return;
      }
      await handleTranscribedText(text, nextTranscribeSeconds);
    } catch (err) {
      if (voiceInputCanceledRef.current) {
        return;
      }
      transitionStage("error");
      const message = toUserFacingError(err);
      setError(message);
      void showOverlayState("error", "处理失败", processingSeconds, message);
      scheduleOverlayHide();
    } finally {
      clearProcessingTimer();
    }
  }

  async function handleTranscribedPayload(payload: TranscribedPayload) {
    if (payload.processed) {
      handleProcessedHotkeyPayload(payload);
      return;
    }
    clearTimer();
    recordingStartedAtRef.current = undefined;
    if (voiceInputCanceledRef.current) {
      clearProcessingTimer();
      return;
    }
    transitionStage(payload.ok ? "recognized" : "error");
    if (!payload.ok) {
      clearProcessingTimer();
      const message = payload.error || "识别失败";
      setError(message);
      void showOverlayState("error", "处理失败", payload.transcribeSeconds ?? processingSeconds, message);
      scheduleOverlayHide();
      return;
    }
    const text = (payload.text || "").trim();
    const dedupeKey = `${payload.transcribeSeconds ?? ""}:${text}`;
    if (text && lastHandledTranscriptionRef.current === dedupeKey) {
      return;
    }
    lastHandledTranscriptionRef.current = dedupeKey;
    try {
      await handleTranscribedText(text, payload.transcribeSeconds ?? processingSeconds);
    } catch (err) {
      transitionStage("error");
      const message = toUserFacingError(err);
      setError(message);
      void showOverlayState("error", "处理失败", processingSeconds, message);
      scheduleOverlayHide();
    } finally {
      clearProcessingTimer();
    }
  }

  function handleProcessedHotkeyPayload(payload: TranscribedPayload) {
    clearTimer();
    clearProcessingTimer();
    recordingStartedAtRef.current = undefined;
    if (voiceInputCanceledRef.current) {
      return;
    }
    setTranscribeSeconds(payload.transcribeSeconds);
    setCorrectionSeconds(payload.correctionSeconds);
    setTranslationSeconds(payload.translationSeconds);
    if (!payload.ok) {
      transitionStage("error");
      const message = payload.error || "处理失败";
      setError(message);
      return;
    }
    const text = (payload.text || "").trim();
    const finalResult =
      payload.result ||
      ({
        corrected_text: text,
        translation: "",
        notes: [],
        confidence: "medium"
      } satisfies AssistantResult);
    setError("");
    setTranscript(text);
    setResult(finalResult);
    transitionStage("done");
    void refreshAccessibilityStatus();
    if (activeSection === "history") {
      void refreshHistory();
    }
  }

  async function handleTranscribedText(text: string, nextTranscribeSeconds: number) {
    if (voiceInputCanceledRef.current) {
      return;
    }
    const currentConfig = configRef.current;
    const currentTargetLanguage = targetLanguageRef.current;
    setTranscribeSeconds(nextTranscribeSeconds);
    setTranscript(text);
    if (!currentConfig.deepseek_key_configured) {
      setResult({
        corrected_text: text,
        translation: "",
        notes: [`未配置 DeepSeek API Key，已输出 ${asrEngineName(currentConfig)} 转写文本。`],
        confidence: "medium"
      });
      const outputOk = await outputFinalText(text);
      transitionStage("done");
      if (outputOk) {
        void showOverlayState("done", "已输出到光标位置", nextTranscribeSeconds, previewOverlayText(text), 0.1, {
          transcribeSeconds: nextTranscribeSeconds
        });
      }
      scheduleOverlayHide();
      return;
    }
    transitionStage("polishing");
    await showOverlayState("polishing", "AI 正在润色", 0, "正在润色文本、整理断句和标点", 0.45, {
      transcribeSeconds: nextTranscribeSeconds
    });
    await settleOverlayStage();
    const correctionStartedAt = performance.now();
    const correction = await polishText(text);
    if (voiceInputCanceledRef.current) {
      return;
    }
    const nextCorrectionSeconds = elapsedSeconds(correctionStartedAt);
    setCorrectionSeconds(nextCorrectionSeconds);
    setResult({
      ...correction,
      translation: ""
    });

    if (!currentConfig.translation_enabled) {
      const outputOk = await outputFinalText(correction.corrected_text);
      transitionStage("done");
      if (outputOk) {
        void showOverlayState("done", "已输出到光标位置", nextCorrectionSeconds, previewOverlayText(correction.corrected_text), 0.1, {
          transcribeSeconds: nextTranscribeSeconds,
          correctionSeconds: nextCorrectionSeconds
        });
      }
      scheduleOverlayHide();
      return;
    }

    transitionStage("translating");
    await showOverlayState("translating", "实时翻译中", 0, `正在翻译为${currentTargetLanguage}`, 0.5, {
      transcribeSeconds: nextTranscribeSeconds,
      correctionSeconds: nextCorrectionSeconds
    });
    await settleOverlayStage();
    const translationStartedAt = performance.now();
    const translation = await translateText(correction.corrected_text, currentTargetLanguage);
    if (voiceInputCanceledRef.current) {
      return;
    }
    const nextTranslationSeconds = elapsedSeconds(translationStartedAt);
    setTranslationSeconds(nextTranslationSeconds);
    setResult({
      ...correction,
      translation
    });
    const outputOk = await outputFinalText(correction.corrected_text);
    transitionStage("done");
    if (outputOk) {
      void showOverlayState("done", "已输出到光标位置", nextTranslationSeconds, previewOverlayText(correction.corrected_text), 0.1, {
        transcribeSeconds: nextTranscribeSeconds,
        correctionSeconds: nextCorrectionSeconds,
        translationSeconds: nextTranslationSeconds
      });
    }
    scheduleOverlayHide();
  }

  async function outputFinalText(text: string) {
    if (voiceInputCanceledRef.current) {
      return false;
    }
    const finalText = text.trim();
    if (!finalText) {
      return true;
    }
    await saveHistoryText(finalText);
    try {
      await outputTextToCursor(finalText);
      void refreshAccessibilityStatus();
      return true;
    } catch (err) {
      const message = toUserFacingError(err);
      const pasteShortcut = manualPasteShortcut();
      void refreshAccessibilityStatus();
      setError(formatPasteFailureMessage(message, pasteShortcut));
      void showOverlayState("error", "自动粘贴失败", processingSeconds, `已尝试写入剪贴板，可手动 ${pasteShortcut}`, 0.1, {
        transcribeSeconds,
        correctionSeconds,
        translationSeconds
      });
      return false;
    }
  }

  async function saveHistoryText(text: string) {
    try {
      const item = await recordVoiceSession(text, {
        recording_seconds: sessionRecordingSecondsRef.current,
        transcribe_seconds: transcribeSeconds ?? 0,
        polish_seconds: correctionSeconds ?? 0,
        translation_seconds: translationSeconds ?? 0
      });
      setHistoryItems((items) => [item, ...items.filter((current) => current.id !== item.id)].slice(0, 100));
      if (activeSection === "stats") {
        void refreshUsageStats();
      }
    } catch (err) {
      setHistoryMessage(`历史记录保存失败：${toUserFacingError(err)}`);
    }
  }

  async function commitTypingSpeedInput() {
    const parsed = Number(typingSpeedInput.trim());
    const value = Number.isFinite(parsed) ? Math.min(100, Math.max(20, Math.round(parsed))) : 28;
    setTypingSpeedInput(String(value));
    updateConfig({ typing_speed_cpm: value });
    try {
      const saved = await saveConfig({ ...configRef.current, typing_speed_cpm: value });
      setConfig(saved);
      configRef.current = saved;
    } catch (err) {
      setStatsMessage(`手打速度保存失败：${toUserFacingError(err)}`);
    }
  }

  async function refreshUsageStats() {
    setStatsBusy(true);
    setStatsMessage("");
    try {
      const stats = await getUsageStats();
      setUsageStats(stats);
    } catch (err) {
      setStatsMessage(toUserFacingError(err));
    } finally {
      setStatsBusy(false);
    }
  }

  async function resetUsageStats() {
    if (!usageStats?.total_sessions) {
      return;
    }
    if (!window.confirm("确认清空全部使用统计数据？历史语音记录不会删除。")) {
      return;
    }
    setStatsBusy(true);
    setStatsMessage("");
    try {
      await clearUsageStats();
      setUsageStats(null);
      await refreshUsageStats();
      setStatsMessage("统计数据已清空");
    } catch (err) {
      setStatsMessage(toUserFacingError(err));
    } finally {
      setStatsBusy(false);
    }
  }

  async function refreshHistory() {
    setHistoryBusy(true);
    setHistoryMessage("");
    try {
      const items = await listVoiceHistory();
      setHistoryItems(items);
      setHistoryPage((page) => clampHistoryPage(page, items.length));
    } catch (err) {
      setHistoryMessage(toUserFacingError(err));
    } finally {
      setHistoryBusy(false);
    }
  }

  async function copyHistoryText(text: string) {
    setHistoryMessage("");
    try {
      await copyTextToClipboard(text);
      setHistoryMessage("已复制到剪贴板");
    } catch (err) {
      setHistoryMessage(toUserFacingError(err));
    }
  }

  async function removeHistoryItem(id: string) {
    setHistoryBusy(true);
    setHistoryMessage("");
    try {
      const items = await deleteVoiceHistory(id);
      setHistoryItems(items);
      setHistoryPage((page) => clampHistoryPage(page, items.length));
    } catch (err) {
      setHistoryMessage(toUserFacingError(err));
    } finally {
      setHistoryBusy(false);
    }
  }

  async function removeAllHistory() {
    if (!historyItems.length) {
      return;
    }
    if (!window.confirm("确认清空全部历史语音记录？")) {
      return;
    }
    setHistoryBusy(true);
    setHistoryMessage("");
    try {
      await clearVoiceHistory();
      setHistoryItems([]);
      setHistoryPage(1);
      setHistoryMessage("历史记录已清空");
    } catch (err) {
      setHistoryMessage(toUserFacingError(err));
    } finally {
      setHistoryBusy(false);
    }
  }

  function reset() {
    clearTimer();
    clearProcessingTimer();
    recordingStartedAtRef.current = undefined;
    lastHandledTranscriptionRef.current = "";
    voiceInputCanceledRef.current = false;
    void cancelNativeRecording();
    transitionStage("idle");
    setSeconds(0);
    setProcessingSeconds(0);
    setTranscribeSeconds(undefined);
    setCorrectionSeconds(undefined);
    setTranslationSeconds(undefined);
    setTranscript("");
    setResult(undefined);
    setError("");
    hideOverlay();
  }

  function cancelCurrentVoiceInput() {
    voiceInputCanceledRef.current = true;
    lastHandledTranscriptionRef.current = "";
    recordingStartedAtRef.current = undefined;
    clearTimer();
    clearProcessingTimer();
    void cancelNativeRecording().catch(() => undefined);
    transitionStage("idle");
    setSeconds(0);
    setProcessingSeconds(0);
    setTranscribeSeconds(undefined);
    setCorrectionSeconds(undefined);
    setTranslationSeconds(undefined);
    setTranscript("");
    setResult(undefined);
    setError("");
    hideOverlay();
  }

  function clearTimer() {
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = undefined;
    }
  }

  function startProcessingTimer() {
    clearProcessingTimer();
    const startedAt = Date.now();
    setProcessingSeconds(0);
    processingTimerRef.current = window.setInterval(() => {
      const nextSeconds = (Date.now() - startedAt) / 1000;
      setProcessingSeconds(nextSeconds);
      const currentStage = stageRef.current;
      if (PROCESSING_STAGES.includes(currentStage)) {
        void showOverlayState(
          currentStage,
          overlayStatus(currentStage),
          nextSeconds,
          overlayText(currentStage),
          currentStage === "polishing" ? 0.55 : 0.3,
          {
            transcribeSeconds,
            correctionSeconds,
            translationSeconds
          }
        );
      }
    }, 250);
  }

  function clearProcessingTimer() {
    if (processingTimerRef.current) {
      window.clearInterval(processingTimerRef.current);
      processingTimerRef.current = undefined;
    }
  }

  function updateConfig(patch: Partial<AppConfig>) {
    setConfig((current) => ({ ...current, ...patch }));
    setConfigMessage("");
  }

  function selectServiceProfile(profile: ServiceProfile) {
    const endpoints = getServiceProfileEndpoints(profile);
    if (!endpoints) {
      updateConfig({ service_profile: profile });
      return;
    }
    updateConfig({
      service_profile: profile,
      funasr_endpoint: endpoints.funasr_endpoint,
      deepseek_endpoint: endpoints.deepseek_endpoint
    });
  }

  async function persistConfig() {
    setError("");
    setConfigMessage("正在保存配置");
    try {
      const saved = await saveConfig(config);
      setConfig(saved);
      setTargetLanguage(saved.target_language || targetLanguage);
      setConfigMessage("配置已保存");
    } catch (err) {
      setConfigMessage("");
      setError(toUserFacingError(err));
    }
  }

  async function resetPolishPrompt() {
    setError("");
    try {
      const defaultPrompt = await getDefaultPolishPrompt();
      updateConfig({ polish_prompt: defaultPrompt });
      setConfigMessage("已载入默认润色提示词，请点击保存使其生效");
    } catch (err) {
      setConfigMessage("");
      setError(toUserFacingError(err));
    }
  }

  async function saveShortcut(shortcut: string) {
    setIsCapturingShortcut(false);
    setShortcutError("");
    setConfigMessage("正在保存快捷键");
    const nextConfig = {
      ...config,
      record_shortcut: shortcut,
      shortcut_enabled: true
    };
    setConfig(nextConfig);
    try {
      const saved = await saveConfig(nextConfig);
      setConfig(saved);
      setConfigMessage("快捷键已保存");
    } catch (err) {
      setShortcutError(toUserFacingError(err));
      setConfigMessage("");
    }
  }

  async function selectModel(modelPath: string) {
    if (!modelPath) {
      return;
    }
    const nextConfig = {
      ...config,
      whisper_model_path: modelPath
    };
    setConfig(nextConfig);
    setConfigMessage("正在切换模型");
    try {
      const saved = await saveConfig(nextConfig);
      setConfig(saved);
      setConfigMessage("模型已切换");
    } catch (err) {
      setConfigMessage("");
      setError(toUserFacingError(err));
    }
  }

  async function addModelProfile() {
    const modelPath = modelPathDraft.trim();
    if (!modelPath) {
      setConfigMessage("");
      setError("请先填写模型文件路径。");
      return;
    }
    const profile: WhisperModelProfile = {
      name: modelNameDraft.trim() || modelNameFromPath(modelPath),
      path: modelPath,
      speed_hint: "自定义"
    };
    const nextProfiles = [
      ...config.whisper_model_profiles.filter((item) => item.path.trim() !== modelPath),
      profile
    ];
    const nextConfig = {
      ...config,
      whisper_model_path: modelPath,
      whisper_model_profiles: nextProfiles
    };
    setConfig(nextConfig);
    setModelNameDraft("");
    setModelPathDraft("");
    setConfigMessage("正在保存模型");
    setError("");
    try {
      const saved = await saveConfig(nextConfig);
      setConfig(saved);
      setConfigMessage("模型已添加并切换");
    } catch (err) {
      setConfigMessage("");
      setError(toUserFacingError(err));
    }
  }

  async function removeModelProfile(modelPath: string) {
    const nextProfiles = config.whisper_model_profiles.filter((item) => item.path !== modelPath);
    const fallbackPath = nextProfiles[0]?.path || "";
    const nextConfig = {
      ...config,
      whisper_model_path: config.whisper_model_path === modelPath ? fallbackPath : config.whisper_model_path,
      whisper_model_profiles: nextProfiles
    };
    setConfig(nextConfig);
    setConfigMessage("正在移除模型");
    try {
      const saved = await saveConfig(nextConfig);
      setConfig(saved);
      setConfigMessage("模型已移除");
    } catch (err) {
      setConfigMessage("");
      setError(toUserFacingError(err));
    }
  }

  async function startFunasr() {
    setFunasrBusy(true);
    setConfigMessage("正在保存配置并启动 FunASR 服务，首次启动会安装依赖并下载模型");
    setError("");
    try {
      const saved = await saveConfig(config);
      setConfig(saved);
      const message = await startFunasrService();
      setConfigMessage(message);
    } catch (err) {
      setConfigMessage("");
      setError(toUserFacingError(err));
    } finally {
      setFunasrBusy(false);
    }
  }

  async function refreshFunasrHealth() {
    if (configRef.current.asr_engine !== "funasr") {
      setFunasrHealthOk(null);
      return;
    }
    try {
      const result = await resolveFunasrService();
      setFunasrHealthOk(result.ok);
      if (result.ok) {
        setConfig((current) => {
          const next: AppConfig = {
            ...current,
            service_profile: normalizeServiceProfile(result.service_profile),
            funasr_endpoint: result.funasr_endpoint,
            deepseek_endpoint: result.deepseek_endpoint
          };
          configRef.current = next;
          return next;
        });
      }
    } catch {
      setFunasrHealthOk(false);
    }
  }

  async function checkFunasr() {
    setFunasrBusy(true);
    setConfigMessage("正在保存配置并检测 FunASR 服务");
    setError("");
    try {
      const saved = await saveConfig(config);
      setConfig(saved);
      configRef.current = saved;
      const result = await resolveFunasrService();
      setFunasrHealthOk(result.ok);
      if (result.ok) {
        const next: AppConfig = {
          ...saved,
          service_profile: normalizeServiceProfile(result.service_profile),
          funasr_endpoint: result.funasr_endpoint,
          deepseek_endpoint: result.deepseek_endpoint
        };
        setConfig(next);
        configRef.current = next;
        const fallbackHint = result.fallback_used ? "（已从快速回退到稳定）" : "";
        setConfigMessage(
          `${result.message}${fallbackHint}：${result.model || saved.funasr_model} / ${result.device || saved.funasr_device}`
        );
      } else {
        setConfigMessage(result.message);
      }
    } catch (err) {
      setFunasrHealthOk(false);
      setConfigMessage("");
      setError(toUserFacingError(err));
    } finally {
      setFunasrBusy(false);
    }
  }

  async function checkRecording() {
    setRecordingCheckBusy(true);
    setRecordingCheckMessage("正在检测录音功能");
    setError("");
    try {
      const health = await checkNativeRecording();
      setRecordingCheckOk(health.ok);
      setRecordingCheckMessage(
        health.ok
          ? `${health.message}：${health.device || "默认输入设备"} / ${health.sample_rate}Hz / ${health.channels}ch`
          : health.message
      );
    } catch (err) {
      setRecordingCheckOk(false);
      setRecordingCheckMessage("");
      setError(toUserFacingError(err));
    } finally {
      setRecordingCheckBusy(false);
    }
  }

  async function showOverlayState(
    stage: Stage,
    status: string,
    seconds: number,
    text?: string,
    level = 0,
    timing: Pick<VoiceOverlayState, "transcribeSeconds" | "correctionSeconds" | "translationSeconds"> = {}
  ) {
    const payload: VoiceOverlayState = {
      stage,
      status,
      seconds,
      text,
      level,
      ...timing
    };
    try {
      if (voiceInputCanceledRef.current) {
        return;
      }
      if (overlayHideTimerRef.current) {
        window.clearTimeout(overlayHideTimerRef.current);
        overlayHideTimerRef.current = undefined;
      }
      const overlay = await Window.getByLabel(OVERLAY_LABEL);
      await overlay?.show();
      await overlay?.setAlwaysOnTop(true);
      await emitTo(OVERLAY_LABEL, OVERLAY_STATE_EVENT, payload);
    } catch {
      // 悬浮窗不可用时不影响主录音、识别和 AI 处理流程。
    }
  }

  function scheduleOverlayHide() {
    if (overlayHideTimerRef.current) {
      window.clearTimeout(overlayHideTimerRef.current);
    }
    overlayHideTimerRef.current = window.setTimeout(hideOverlay, 1800);
  }

  function hideOverlay() {
    if (overlayHideTimerRef.current) {
      window.clearTimeout(overlayHideTimerRef.current);
      overlayHideTimerRef.current = undefined;
    }
    void Window.getByLabel(OVERLAY_LABEL)
      .then((overlay) => overlay?.hide())
      .catch(() => undefined);
  }

  return (
    <main className="app-shell">
      <section className="hero-band">
        <div>
          <p className="eyebrow">语音输入 · AI 润色</p>
          <h1>
            鱼泡语音助手
            {appVersion ? <span className="app-version">v{appVersion}</span> : null}
          </h1>
        </div>
        <div className="status-strip">
          <StatusDot
            ok={config.asr_engine !== "funasr" || funasrHealthOk === true}
            error={config.asr_engine === "funasr" && funasrHealthOk === false}
            label="FunASR 服务"
          />
          <StatusDot ok={config.asr_engine === "funasr" || Boolean(config?.whisper_model_path)} label={asrEngineName(config)} />
          <StatusDot ok={Boolean(config?.deepseek_key_configured)} label="DeepSeek" />
          {isMacos ? <StatusDot ok={Boolean(accessibilityStatus?.trusted)} label="辅助功能" /> : null}
        </div>
      </section>

      <nav className="page-tabs">
        <TabButton active={activeSection === "home"} icon={<Home size={16} />} label="首页" onClick={() => setActiveSection("home")} />
        <TabButton active={activeSection === "permission"} icon={<ShieldCheck size={16} />} label="权限设置" onClick={() => setActiveSection("permission")} />
        <TabButton active={activeSection === "hotkey"} icon={<Keyboard size={16} />} label="快捷键设置" onClick={() => setActiveSection("hotkey")} />
        <TabButton active={activeSection === "ai"} icon={<Bot size={16} />} label="AI 设置" onClick={() => setActiveSection("ai")} />
        <TabButton active={activeSection === "model"} icon={<Settings2 size={16} />} label="模型设置" onClick={() => setActiveSection("model")} />
        <TabButton active={activeSection === "history"} icon={<History size={16} />} label="历史语音" onClick={() => setActiveSection("history")} />
        <TabButton active={activeSection === "stats"} icon={<BarChart3 size={16} />} label="使用统计" onClick={() => setActiveSection("stats")} />
      </nav>

      {activeSection === "home" ? (
        <section className="workbench">
          <aside className="control-panel">
            <div className="timer-ring" style={{ "--progress": progress } as React.CSSProperties}>
              <div>
                <span>{seconds.toFixed(1)}</span>
                <small>/ {MAX_SECONDS}s</small>
              </div>
            </div>

            <div className="record-actions">
              {stage === "recording" ? (
                <button className="primary danger" onClick={() => void stopRecordingFromUi()}>
                  <Pause size={18} />
                  结束输入
                </button>
              ) : (
                <button className="primary" disabled={busy} onClick={() => void startRecording()}>
                  <Mic size={18} />
                  开始说话
                </button>
              )}
              <button className="icon-button" disabled={busy} onClick={reset} title="重置">
                <RotateCcw size={18} />
              </button>
            </div>

            <label className="field">
              <span>
                <Languages size={16} />
                翻译目标
              </span>
              <select
                value={targetLanguage}
                onChange={(event) => {
                  setTargetLanguage(event.target.value);
                  updateConfig({ target_language: event.target.value });
                }}
              >
                <option value="中文">中文</option>
                <option value="英文">英文</option>
                <option value="日文">日文</option>
                <option value="韩文">韩文</option>
              </select>
            </label>

            <label className="switch-row panel-switch">
              <input
                type="checkbox"
                checked={config.translation_enabled}
                onChange={(event) => {
                  const nextConfig = { ...config, translation_enabled: event.target.checked };
                  setConfig(nextConfig);
                  void saveConfig(nextConfig).then(setConfig).catch((err) => setError(toUserFacingError(err)));
                }}
              />
              <span>{config.translation_enabled ? "实时翻译已启用" : "如有需要请手动开启"}</span>
            </label>

            <div className="config-box">
              <div className="config-title">
                <Settings2 size={16} />
                当前配置
              </div>
              <dl>
                <dt>{config.asr_engine === "funasr" ? "FunASR 模型" : "模型文件"}</dt>
                <dd>{config.asr_engine === "funasr" ? config.funasr_model : config?.whisper_model_path || "未配置"}</dd>
                <dt>识别引擎</dt>
                <dd>{asrEngineName(config)}</dd>
                <dt>DeepSeek 模型</dt>
                <dd>{config?.deepseek_model ?? "检测中"}</dd>
                <dt>{config.asr_engine === "funasr" ? "服务线路" : "Whisper CLI"}</dt>
                <dd>
                  {config.asr_engine === "funasr"
                    ? getServiceProfileLabel(normalizeServiceProfile(config.service_profile))
                    : config?.whisper_cli_path || "未配置"}
                </dd>
                {config.asr_engine === "funasr" ? (
                  <>
                    <dt>FunASR 地址</dt>
                    <dd className="mono-clip">{config.funasr_endpoint || "未配置"}</dd>
                  </>
                ) : null}
              </dl>
            </div>
          </aside>

          <section className="result-panel">
            <Pipeline stage={stage} />

            <ProcessingNotice stage={stage} seconds={processingSeconds} />
            <TimingStats
              transcribeSeconds={transcribeSeconds}
              correctionSeconds={correctionSeconds}
              translationSeconds={translationSeconds}
            />

            {error ? <div className="error-box">{error}</div> : null}

            <div className="columns">
              <TextBlock title="本地识别" icon={<Mic size={16} />} value={transcript || emptyTranscriptText(stage)} />
              <TextBlock
                title="AI 润色"
                icon={<Sparkles size={16} />}
                value={result?.corrected_text || emptyCorrectedText(stage)}
              />
              <TextBlock
                title="实时翻译"
                icon={<Languages size={16} />}
                value={!config.translation_enabled ? "如有需要请手动开启" : result?.translation || emptyTranslationText(stage)}
              />
            </div>

            {result?.notes.length ? (
              <div className="notes">
                <div className="notes-title">
                  <Check size={16} />
                  润色依据
                </div>
                {result.notes.map((note) => (
                  <p key={note}>{note}</p>
                ))}
              </div>
            ) : null}
          </section>
        </section>
      ) : null}

      {activeSection === "permission" ? (
        <SettingsPanel title="权限设置" subtitle="语音输入需要麦克风权限；自动粘贴到光标处需要辅助功能权限，请确保以下权限已开启">
          {isMacos ? (
            <SettingRow
              title="辅助功能权限"
              desc={
                accessibilityStatus?.trusted
                  ? "已授权，可将识别结果自动粘贴到当前光标位置"
                  : "未授权，授权后才能把语音结果自动粘贴到其他应用"
              }
            >
              <div className="permission-actions">
                {!accessibilityStatus?.trusted ? (
                  <button className="primary" onClick={() => void openMacosAccessibilitySettings()}>
                    打开系统设置
                  </button>
                ) : null}
                <button className="icon-button wide" onClick={() => void refreshAccessibilityStatus()}>
                  <RotateCcw size={16} />
                  重新检测
                </button>
              </div>
            </SettingRow>
          ) : null}

          <SettingRow
            title="麦克风 / 录音"
            desc={recordingCheckMessage || "检测麦克风是否可正常录音，首次检测会触发系统麦克风授权"}
          >
            <div className="permission-actions single">
              <button className="icon-button wide" disabled={recordingCheckBusy || busy} onClick={() => void checkRecording()}>
                {recordingCheckBusy ? <Loader2 size={16} className="spin" /> : <Mic size={16} />}
                {recordingCheckBusy ? "检测中" : "检测录音"}
              </button>
            </div>
          </SettingRow>
        </SettingsPanel>
      ) : null}

      {activeSection === "history" ? (
        <section className="history-panel">
          <header className="history-head">
            <div>
              <h2>历史语音</h2>
              <p>自动保留最近 100 条 AI 润色文本，可复制或删除。</p>
            </div>
            <div className="history-actions">
              <button className="icon-button wide" disabled={historyBusy} onClick={() => void refreshHistory()}>
                {historyBusy ? <Loader2 size={16} className="spin" /> : <RotateCcw size={16} />}
                刷新
              </button>
              <button className="icon-button wide danger-text" disabled={historyBusy || !historyItems.length} onClick={() => void removeAllHistory()}>
                <Trash2 size={16} />
                清空
              </button>
            </div>
          </header>

          {historyMessage ? <div className={historyMessage.includes("失败") ? "error-box" : "info-box"}>{historyMessage}</div> : null}

          {historyItems.length ? (
            <>
              <div className="history-list">
                {paginatedHistoryItems(historyItems, historyPage).map((item) => (
                  <article className="history-item" key={item.id}>
                    <div className="history-item-meta">
                      <span>{formatHistoryTime(item.created_at)}</span>
                      <small>{item.text.length} 字</small>
                    </div>
                    <p>{item.text}</p>
                    <div className="history-item-actions">
                      <button className="icon-button wide" onClick={() => void copyHistoryText(item.text)}>
                        <Copy size={16} />
                        复制
                      </button>
                      <button className="icon-button wide danger-text" disabled={historyBusy} onClick={() => void removeHistoryItem(item.id)}>
                        <Trash2 size={16} />
                        删除
                      </button>
                    </div>
                  </article>
                ))}
              </div>
              <HistoryPager
                page={historyPage}
                total={historyItems.length}
                pageSize={HISTORY_PAGE_SIZE}
                onPrev={() => setHistoryPage((page) => Math.max(1, page - 1))}
                onNext={() => setHistoryPage((page) => Math.min(historyPageCount(historyItems.length), page + 1))}
              />
            </>
          ) : (
            <div className="history-empty">
              <History size={30} />
              <strong>暂无历史语音</strong>
              <span>完成一次语音输入后，AI 润色文本会自动出现在这里。</span>
            </div>
          )}
        </section>
      ) : null}

      {activeSection === "stats" ? (
        <section className="stats-panel">
          <header className="stats-head">
            <div>
              <h2>使用统计</h2>
              <p>数据仅保存在本机，用于了解语音输入习惯与大致效率。</p>
            </div>
            <div className="stats-actions">
              <button className="icon-button wide" disabled={statsBusy} onClick={() => void refreshUsageStats()}>
                {statsBusy ? <Loader2 size={16} className="spin" /> : <RotateCcw size={16} />}
                刷新
              </button>
              <button className="icon-button wide danger-text" disabled={statsBusy || !usageStats?.total_sessions} onClick={() => void resetUsageStats()}>
                <Trash2 size={16} />
                清空统计
              </button>
            </div>
          </header>

          <div className="info-box stats-note">
            预计节省时间按「假设手打速度 − 实际语音流程耗时」估算，并打 7 折、单次上限 2 分钟；短文本会进一步打折，仅供参考。
          </div>

          <div className="stats-setting">
            <label>
              <span>手打速度参考（字/分钟）</span>
              <small>影响节省时间估算，默认 28，范围 20–100</small>
            </label>
            <input
              type="number"
              min={20}
              max={100}
              inputMode="numeric"
              value={typingSpeedInput}
              onChange={(event) => setTypingSpeedInput(event.target.value)}
              onBlur={() => void commitTypingSpeedInput()}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.currentTarget.blur();
                }
              }}
            />
          </div>

          {statsMessage ? <div className={statsMessage.includes("失败") ? "error-box" : "info-box"}>{statsMessage}</div> : null}

          {usageStats && usageStats.total_sessions > 0 ? (
            <>
              <div className="stats-grid">
                <StatsCard title="累计次数" value={`${usageStats.total_sessions}`} hint={`成功 ${usageStats.successful_sessions} 次`} />
                <StatsCard title="今日 / 本周 / 本月" value={`${usageStats.today_sessions} / ${usageStats.week_sessions} / ${usageStats.month_sessions}`} hint={`活跃 ${usageStats.active_days} 天`} />
                <StatsCard title="累计字数" value={formatNumber(usageStats.total_chars)} hint={`均每次 ${Math.round(usageStats.avg_chars_per_session)} 字`} />
                <StatsCard title="今日字数" value={formatNumber(usageStats.today_chars)} hint={`本周 ${formatNumber(usageStats.week_chars)} · 本月 ${formatNumber(usageStats.month_chars)}`} />
                <StatsCard title="预计节省" value={formatDurationSeconds(usageStats.total_saved_seconds)} hint={`今日 ${formatDurationSeconds(usageStats.today_saved_seconds)}`} accent />
                <StatsCard title="本周 / 本月节省" value={`${formatDurationSeconds(usageStats.week_saved_seconds)} / ${formatDurationSeconds(usageStats.month_saved_seconds)}`} hint={`均每次 ${formatDurationSeconds(usageStats.avg_saved_per_session)}`} />
                <StatsCard title="录音总时长" value={formatDurationSeconds(usageStats.total_recording_seconds)} hint={`处理 ${formatDurationSeconds(usageStats.total_processing_seconds)}`} />
                <StatsCard title="均流程耗时" value={formatDurationSeconds(usageStats.avg_total_seconds)} hint={`识别 ${formatDurationSeconds(usageStats.avg_transcribe_seconds)} · 润色 ${formatDurationSeconds(usageStats.avg_polish_seconds)}`} />
                <StatsCard title="AI 润色使用" value={`${usageStats.polish_usage_count} 次`} hint={`翻译 ${usageStats.translation_usage_count} 次`} />
                <StatsCard title="单次最长" value={`${usageStats.longest_session_chars} 字`} hint={`手打参考 ${usageStats.typing_speed_cpm} 字/分`} />
              </div>

              <div className="stats-charts">
                <article className="stats-chart-card">
                  <h3>近 14 天使用</h3>
                  <div className="stats-bar-chart">
                    {usageStats.daily_last_14_days.map((bucket) => (
                      <div className="stats-bar-col" key={bucket.date} title={`${bucket.date}: ${bucket.sessions} 次, ${bucket.chars} 字, 节省 ${formatDurationSeconds(bucket.saved_seconds)}`}>
                        <div className="stats-bar-stack">
                          <div className="stats-bar sessions" style={{ height: `${barHeight(bucket.sessions, maxDailySessions(usageStats.daily_last_14_days))}%` }} />
                        </div>
                        <span className="stats-bar-label">{formatShortDate(bucket.date)}</span>
                        <small>{bucket.sessions}</small>
                      </div>
                    ))}
                  </div>
                  <p className="stats-chart-legend">柱高 = 当日次数</p>
                </article>

                <article className="stats-chart-card">
                  <h3>时段分布（0–23 点）</h3>
                  <div className="stats-bar-chart hourly">
                    {usageStats.hourly_distribution.map((bucket) => (
                      <div className="stats-bar-col" key={bucket.hour} title={`${bucket.hour} 点: ${bucket.sessions} 次`}>
                        <div className="stats-bar-stack">
                          <div className="stats-bar hourly" style={{ height: `${barHeight(bucket.sessions, maxHourlySessions(usageStats.hourly_distribution))}%` }} />
                        </div>
                        <span className="stats-bar-label">{bucket.hour}</span>
                      </div>
                    ))}
                  </div>
                  <p className="stats-chart-legend">柱高 = 该时段累计次数</p>
                </article>
              </div>

              <div className="stats-recent">
                <h3>最近记录</h3>
                <div className="stats-event-list">
                  {usageStats.recent_events.map((event) => (
                    <article className="stats-event-item" key={event.id}>
                      <div className="stats-event-meta">
                        <span>{formatHistoryTime(event.created_at)}</span>
                        <span>{event.char_count} 字 · 节省 {formatDurationSeconds(event.saved_seconds)}</span>
                      </div>
                      <div className="stats-event-tags">
                        <span>
                          {event.service_profile === "fast"
                            ? "快速"
                            : event.service_profile === "custom"
                              ? "自定义"
                              : "稳定"}
                        </span>
                        {event.polish_enabled ? <span>润色</span> : null}
                        {event.translation_enabled ? <span>翻译</span> : null}
                        <span>录音 {formatDurationSeconds(event.recording_seconds)}</span>
                        <span>流程 {formatDurationSeconds(event.total_seconds)}</span>
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <div className="stats-empty">
              <BarChart3 size={30} />
              <strong>暂无统计数据</strong>
              <span>完成几次语音输入后，这里会显示次数、字数、时段分布和保守估算的节省时间。</span>
            </div>
          )}
        </section>
      ) : null}

      {activeSection === "model" ? (
        <SettingsPanel title="模型设置" subtitle="默认使用 FunASR 服务；本地 Whisper 仅在自行部署后配置">
          <SettingRow title="识别引擎" desc="FunASR 走 HTTP 服务；Whisper 需要自行安装 whisper.cpp 和 ggml 模型">
            <select value={config.asr_engine} onChange={(event) => updateConfig({ asr_engine: event.target.value })}>
              <option value="whisper">Whisper 本地模型</option>
              <option value="funasr">FunASR / Paraformer</option>
            </select>
          </SettingRow>

          {config.asr_engine === "funasr" ? (
            <>
              <SettingRow title="FunASR 服务" desc="检测或启动本机 FunASR；识别与 AI 润色默认走所选服务线路">
                <div className="service-actions">
                  <button className="primary" disabled={funasrBusy} onClick={() => void startFunasr()}>
                    {funasrBusy ? <Loader2 size={16} className="spin" /> : <Server size={16} />}
                    启动服务
                  </button>
                  <button className="icon-button wide" disabled={funasrBusy} onClick={() => void checkFunasr()}>
                    检测服务
                  </button>
                </div>
              </SettingRow>
              <SettingRow title="服务线路" desc="默认快速线路；快速不可用时自动回退稳定；自定义可填写任意地址">
                <select
                  value={normalizeServiceProfile(config.service_profile)}
                  onChange={(event) => selectServiceProfile(event.target.value as ServiceProfile)}
                >
                  {SERVICE_PROFILE_OPTIONS.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </SettingRow>
              {isCustomServiceProfile(config.service_profile) ? (
                <>
                  <SettingRow title="FunASR 服务地址" desc="语音识别 HTTP 服务，例如 http://host:10095">
                    <input
                      value={config.funasr_endpoint}
                      onChange={(event) => updateConfig({ funasr_endpoint: event.target.value.trim() })}
                      placeholder="http://127.0.0.1:10095"
                    />
                  </SettingRow>
                  <SettingRow title="DeepSeek 代理地址" desc="AI 润色/翻译走同一代理时可与 FunASR 相同">
                    <input
                      value={config.deepseek_endpoint}
                      onChange={(event) => updateConfig({ deepseek_endpoint: event.target.value.trim() })}
                      placeholder="http://127.0.0.1:10095"
                    />
                  </SettingRow>
                </>
              ) : (
                <SettingRow title="当前服务地址" desc="预设线路地址由线路自动切换；需自定义请选「自定义」">
                  <input value={config.funasr_endpoint} readOnly />
                </SettingRow>
              )}
              <SettingRow title="FunASR 模型" desc="默认 Paraformer-large；可换成已支持的 ModelScope 模型名或本地路径">
                <input value={config.funasr_model} onChange={(event) => updateConfig({ funasr_model: event.target.value })} />
              </SettingRow>
              <SettingRow title="推理设备" desc="CPU 默认可用；有可用环境时可改为 cuda">
                <select value={config.funasr_device} onChange={(event) => updateConfig({ funasr_device: event.target.value })}>
                  <option value="cpu">cpu</option>
                  <option value="cuda">cuda</option>
                </select>
              </SettingRow>
            </>
          ) : null}

          <SettingRow title="当前 Whisper 模型" desc={activeModelProfile(config)?.speed_hint || "未内置本地模型；需要自行下载并添加 ggml 模型路径"}>
            <select value={config.whisper_model_path} onChange={(event) => void selectModel(event.target.value)}>
              {config.whisper_model_profiles.map((profile) => (
                <option key={profile.path} value={profile.path}>
                  {profile.name}
                </option>
              ))}
              {!config.whisper_model_profiles.length ? <option value="">未配置模型</option> : null}
            </select>
          </SettingRow>
          <SettingRow title="模型档案" desc="仅保存你手动添加的本地模型；安装包不自带 Whisper 模型">
            <div className="model-profile-list">
              {config.whisper_model_profiles.map((profile) => (
                <button
                  key={profile.path}
                  className={profile.path === config.whisper_model_path ? "model-profile active" : "model-profile"}
                  onClick={() => void selectModel(profile.path)}
                >
                  <strong>{profile.name}</strong>
                  <span>{profile.speed_hint || "自定义"}</span>
                  <small>{profile.path}</small>
                </button>
              ))}
            </div>
          </SettingRow>
          <SettingRow title="新增模型" desc="填写你自行部署的 ggml 模型文件完整路径，保存后会加入档案并切换过去">
            <div className="model-add-form">
              <input value={modelNameDraft} onChange={(event) => setModelNameDraft(event.target.value)} placeholder="模型名称，例如 Tiny 快速" />
              <input value={modelPathDraft} onChange={(event) => setModelPathDraft(event.target.value)} placeholder="/path/to/ggml-base.bin" />
              <button className="primary" onClick={() => void addModelProfile()}>
                保存并切换
              </button>
            </div>
          </SettingRow>
          <SettingRow title="当前路径" desc="也可以直接编辑当前模型路径">
            <input value={config.whisper_model_path} onChange={(event) => updateConfig({ whisper_model_path: event.target.value })} />
          </SettingRow>
          <SettingRow title="Whisper CLI" desc="填写 whisper.cpp 可执行文件路径">
            <input value={config.whisper_cli_path} onChange={(event) => updateConfig({ whisper_cli_path: event.target.value })} />
          </SettingRow>
          <SettingRow title="线程数" desc="本地识别使用的线程数，默认 8">
            <input value={config.whisper_threads} onChange={(event) => updateConfig({ whisper_threads: event.target.value })} />
          </SettingRow>
          {config.whisper_model_profiles.length > 1 ? (
            <SettingRow title="清理档案" desc="移除当前选中的模型档案，不会删除模型文件">
              <button className="icon-button wide" onClick={() => void removeModelProfile(config.whisper_model_path)}>
                移除当前档案
              </button>
            </SettingRow>
          ) : null}
          <SettingRow title="配置文件" desc={config.config_path || "首次保存后生成"}>
            <button className="primary" onClick={() => void persistConfig()}>
              <Save size={16} />
              保存配置
            </button>
          </SettingRow>
          {configMessage ? <div className="info-box">{configMessage}</div> : null}
          {error ? <div className="error-box">{error}</div> : null}
        </SettingsPanel>
      ) : null}

      {activeSection === "hotkey" ? (
        <SettingsPanel title="快捷键" subtitle="录制任意键位或组合，保存后可在任意窗口触发语音输入">
          <SettingRow title="启用快捷键" desc="关闭后不会监听全局键盘快捷键">
            <label className="switch-row">
              <input
                type="checkbox"
                checked={config.shortcut_enabled}
                onChange={(event) => {
                  const nextConfig = { ...config, shortcut_enabled: event.target.checked };
                  setConfig(nextConfig);
                  void saveConfig(nextConfig).then(setConfig).catch((err) => setShortcutError(toUserFacingError(err)));
                }}
              />
              <span>{config.shortcut_enabled ? "已启用" : "已关闭"}</span>
            </label>
          </SettingRow>
          <SettingRow title="当前快捷键" desc={shortcutError || "支持单键、功能键、符号键、数字键、小键盘、修饰键和组合键"}>
            <div className="shortcut-control">
              <kbd>{config.record_shortcut || "未设置"}</kbd>
              <button className={isCapturingShortcut ? "primary danger" : "primary"} onClick={() => setIsCapturingShortcut(true)}>
                <Keyboard size={16} />
                {isCapturingShortcut ? "按下键位..." : "录制快捷键"}
              </button>
            </div>
          </SettingRow>
          <SettingRow title="快捷键预设" desc="这里只是快捷入口；也可以点击录制后直接按任意键位">
            <div className="shortcut-presets">
              {SHORTCUT_PRESETS.map((shortcut) => (
                <button key={shortcut} className="icon-button wide" onClick={() => void saveShortcut(shortcut)}>
                  {shortcut}
                </button>
              ))}
            </div>
          </SettingRow>
          <SettingRow title="保存方式" desc="录制到有效键位后会自动保存并立即重新注册">
            <button className="primary" onClick={() => void persistConfig()}>
              <Save size={16} />
              保存当前配置
            </button>
          </SettingRow>
          {configMessage ? <div className="info-box">{configMessage}</div> : null}
          {shortcutError ? <div className="error-box">{shortcutError}</div> : null}
        </SettingsPanel>
      ) : null}

      {activeSection === "ai" ? (
        <SettingsPanel title="AI 设置" subtitle="DeepSeek 只处理转写后的文本，可本机直连或服务端代理">
          <SettingRow title="API Key" desc="仅保存在本机配置文件中">
            <input
              type="password"
              value={config.deepseek_api_key}
              onChange={(event) => updateConfig({ deepseek_api_key: event.target.value })}
              placeholder="sk-..."
            />
          </SettingRow>
          <SettingRow title="DeepSeek 模型" desc="用于 AI 润色、补标点和翻译">
            <input value={config.deepseek_model} onChange={(event) => updateConfig({ deepseek_model: event.target.value })} />
          </SettingRow>
          <SettingRow title="服务线路" desc="与模型设置联动；自定义时可分别配置 FunASR 与 DeepSeek 代理">
            <select
              value={normalizeServiceProfile(config.service_profile)}
              onChange={(event) => selectServiceProfile(event.target.value as ServiceProfile)}
            >
              {SERVICE_PROFILE_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </SettingRow>
          {isCustomServiceProfile(config.service_profile) ? (
            <>
              <SettingRow title="FunASR 服务地址" desc="语音识别 HTTP 服务">
                <input
                  value={config.funasr_endpoint}
                  onChange={(event) => updateConfig({ funasr_endpoint: event.target.value.trim() })}
                  placeholder="http://127.0.0.1:10095"
                />
              </SettingRow>
              <SettingRow title="DeepSeek 代理地址" desc="AI 润色与翻译请求地址">
                <input
                  value={config.deepseek_endpoint}
                  onChange={(event) => updateConfig({ deepseek_endpoint: event.target.value.trim() })}
                  placeholder="http://127.0.0.1:10095"
                />
              </SettingRow>
            </>
          ) : null}
          <SettingRow title="AI 润色" desc="关闭后直接将识别原文输出到光标，零 LLM 延迟；翻译仍可独立开启">
            <label className="switch-row">
              <input
                type="checkbox"
                checked={config.polish_enabled}
                onChange={(event) => updateConfig({ polish_enabled: event.target.checked })}
              />
              <span>{config.polish_enabled ? "已启用" : "已关闭（直接输出识别原文）"}</span>
            </label>
          </SettingRow>
          <SettingRow title="实时翻译" desc="关闭后只进行 AI 润色，不再调用翻译接口">
            <label className="switch-row">
              <input
                type="checkbox"
                checked={config.translation_enabled}
                onChange={(event) => updateConfig({ translation_enabled: event.target.checked })}
              />
              <span>{config.translation_enabled ? "已启用" : "已关闭"}</span>
            </label>
          </SettingRow>
          <div className="setting-row wide">
            <div className="setting-copy">
              <strong>AI 润色提示词</strong>
              <span>
                自定义 AI 润色时发给 DeepSeek 的系统提示词，可随时编辑并保存。需保留 JSON 输出约定
                （corrected_text / notes / confidence），否则可能解析失败。走服务端代理时，需要服务端运行最新版才会生效。
              </span>
            </div>
            <div className="setting-control">
              <div className="prompt-editor">
                <textarea
                  className="prompt-textarea"
                  value={config.polish_prompt}
                  onChange={(event) => updateConfig({ polish_prompt: event.target.value })}
                  rows={12}
                  spellCheck={false}
                  placeholder="自定义润色提示词，留空时使用内置默认"
                />
                <div className="prompt-actions">
                  <button className="icon-button wide" onClick={() => void resetPolishPrompt()}>
                    <RotateCcw size={16} />
                    恢复默认
                  </button>
                  <button className="primary" onClick={() => void persistConfig()}>
                    <Save size={16} />
                    保存提示词
                  </button>
                </div>
              </div>
            </div>
          </div>
          <SettingRow title="默认翻译目标" desc="首页也可以临时切换">
            <select
              value={config.target_language}
              onChange={(event) => {
                updateConfig({ target_language: event.target.value });
                setTargetLanguage(event.target.value);
              }}
            >
              <option value="中文">中文</option>
              <option value="英文">英文</option>
              <option value="日文">日文</option>
              <option value="韩文">韩文</option>
            </select>
          </SettingRow>
          <SettingRow title="LLM 服务地址" desc="留空时使用 DeepSeek 官方；填写后走任意 OpenAI 兼容服务（GLM-4-Flash / Qwen / Ollama / vLLM）">
            <input
              value={config.llm_base_url}
              onChange={(event) => updateConfig({ llm_base_url: event.target.value })}
              placeholder="https://open.bigmodel.cn/api/paas/v4"
            />
          </SettingRow>
          <SettingRow title="保存 AI 设置" desc={config.deepseek_endpoint ? "使用服务端 DeepSeek 代理" : config.deepseek_key_configured ? "DeepSeek key 已配置" : "DeepSeek key 未配置"}>
            <button className="primary" onClick={() => void persistConfig()}>
              <Save size={16} />
              保存配置
            </button>
          </SettingRow>
          {configMessage ? <div className="info-box">{configMessage}</div> : null}
          {error ? <div className="error-box">{error}</div> : null}
        </SettingsPanel>
      ) : null}
    </main>
  );
}

function VoiceOverlayWindow() {
  const [overlay, setOverlay] = useState<VoiceOverlayState>({
    stage: "idle",
    status: "准备录音",
    seconds: 0,
    text: "按下快捷键开始语音输入",
    level: 0.2
  });

  useEffect(() => {
    document.documentElement.dataset.window = OVERLAY_LABEL;
    document.body.dataset.window = OVERLAY_LABEL;
    const currentWindow = getCurrentWindow();
    void currentWindow.setAlwaysOnTop(true);
    return () => {
      delete document.documentElement.dataset.window;
      delete document.body.dataset.window;
    };
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void listen<VoiceOverlayState>(OVERLAY_STATE_EVENT, (event) => {
      setOverlay(event.payload);
    }).then((handler) => {
      unlisten = handler;
    });
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    if (overlay.stage !== "done" && overlay.stage !== "error") {
      return;
    }
    const timer = window.setTimeout(() => {
      void getCurrentWindow().hide().catch(() => undefined);
    }, 1800);
    return () => window.clearTimeout(timer);
  }, [overlay.stage]);

  const level = overlay.level ?? 0;
  const isRecording = overlay.stage === "recording";
  const isActiveVoice = isRecording && level > ACTIVE_VOICE_LEVEL;
  const bars = Array.from({ length: 16 }, (_, index) => {
    const base = isRecording ? 10 + ((index % 5) + 1) * 3 : 8 + (index % 4) * 2;
    const wave = isRecording ? Math.abs(Math.sin(index * 0.72 + overlay.seconds * 8.5)) : 0.18;
    const height = Math.round(base + wave * (isActiveVoice ? 22 : 10) + level * 34);
    return <span key={index} style={{ height }} />;
  });

  function closeOverlay(event: React.SyntheticEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    void closeVoiceOverlay().catch(() => undefined);
    void emitTo(MAIN_LABEL, OVERLAY_CANCEL_EVENT).catch(() => undefined);
    void getCurrentWindow().hide().catch(() => undefined);
  }

  function startOverlayDrag(event: React.MouseEvent<HTMLElement>) {
    if (event.button !== 0) {
      return;
    }
    const target = event.target as HTMLElement;
    if (target.closest("button")) {
      return;
    }
    void getCurrentWindow().startDragging().catch(() => undefined);
  }

  return (
    <main className="voice-overlay-frame">
      <section
        className="voice-overlay-shell"
        data-stage={overlay.stage}
        data-active-voice={isActiveVoice ? "true" : "false"}
        onMouseDown={startOverlayDrag}
      >
        <button
          className="voice-overlay-close"
          onMouseDown={closeOverlay}
          onClick={closeOverlay}
          title="关闭悬浮窗"
          aria-label="关闭悬浮窗"
        >
          <X size={14} />
        </button>
        <div className="voice-ripple" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        <div className="voice-orb" aria-hidden="true">{overlayStageIcon(overlay.stage)}</div>
        <div className="voice-overlay-copy">
          <strong>{overlay.status}</strong>
          <span>{overlayTimeText(overlay)}</span>
        </div>
        <div className="voice-wave" aria-hidden="true">{bars}</div>
        <p>{overlay.text || overlayText(overlay.stage)}</p>
      </section>
    </main>
  );
}

function nextPaint() {
  return new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
}

async function settleOverlayStage() {
  await nextPaint();
  await new Promise<void>((resolve) => window.setTimeout(resolve, 180));
}

function elapsedSeconds(startedAt: number) {
  return Number(((performance.now() - startedAt) / 1000).toFixed(1));
}

function getSafeWindowLabel() {
  try {
    return getCurrentWindow().label;
  } catch {
    return "main";
  }
}

function asrEngineName(config: AppConfig) {
  return config.asr_engine === "funasr" ? "FunASR" : "Whisper";
}

function overlayStatus(stage: Stage) {
  const status: Record<Stage, string> = {
    idle: "准备录音",
    recording: "正在监听语音",
    stopping: "正在停止录音",
    transcribing: "本地识别中",
    recognized: "识别完成",
    polishing: "AI 正在润色",
    translating: "实时翻译中",
    done: "处理完成",
    error: "处理失败"
  };
  return status[stage];
}

function overlayText(stage: Stage) {
  const text: Record<Stage, string> = {
    idle: "按下快捷键开始语音输入",
    recording: "再次按下快捷键停止录音",
    stopping: "正在收束音频并准备识别",
    transcribing: "Whisper 正在处理录音",
    recognized: "识别完成，准备后续处理",
    polishing: "正在润色文本、整理标点",
    translating: "正在生成目标语言版本",
    done: "结果已经写回主窗口",
    error: "请回到主窗口查看错误详情"
  };
  return text[stage];
}

function overlayTimeText(overlay: VoiceOverlayState) {
  const parts = [`${overlay.seconds.toFixed(1)}s`];
  if (overlay.transcribeSeconds !== undefined) {
    parts.push(`识别 ${overlay.transcribeSeconds.toFixed(1)}s`);
  }
  if (overlay.correctionSeconds !== undefined) {
    parts.push(`润色 ${overlay.correctionSeconds.toFixed(1)}s`);
  }
  if (overlay.translationSeconds !== undefined) {
    parts.push(`翻译 ${overlay.translationSeconds.toFixed(1)}s`);
  }
  return parts.join(" · ");
}

function previewOverlayText(text: string) {
  const compactText = text.replace(/\s+/g, " ").trim();
  if (!compactText) {
    return "处理完成";
  }
  return compactText.length > 34 ? `${compactText.slice(0, 34)}...` : compactText;
}

function historyPageCount(total: number) {
  return Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE));
}

function clampHistoryPage(page: number, total: number) {
  return Math.min(Math.max(1, page), historyPageCount(total));
}

function paginatedHistoryItems(items: VoiceHistoryItem[], page: number) {
  const start = (page - 1) * HISTORY_PAGE_SIZE;
  return items.slice(start, start + HISTORY_PAGE_SIZE);
}

function formatHistoryTime(timestamp: number) {
  return new Date(timestamp).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatDurationSeconds(seconds: number) {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) {
    return `${total} 秒`;
  }
  const minutes = Math.floor(total / 60);
  const remain = total % 60;
  if (minutes < 60) {
    return remain ? `${minutes} 分 ${remain} 秒` : `${minutes} 分`;
  }
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  return remainMinutes ? `${hours} 小时 ${remainMinutes} 分` : `${hours} 小时`;
}

function formatNumber(value: number) {
  return value.toLocaleString("zh-CN");
}

function formatShortDate(date: string) {
  const parts = date.split("-");
  if (parts.length === 3) {
    return `${parts[1]}/${parts[2]}`;
  }
  return date;
}

function barHeight(value: number, max: number) {
  if (!max) {
    return 0;
  }
  return Math.max(6, Math.round((value / max) * 100));
}

function maxDailySessions(buckets: UsageStatsSummary["daily_last_14_days"]) {
  return buckets.reduce((max, bucket) => Math.max(max, bucket.sessions), 0);
}

function maxHourlySessions(buckets: UsageStatsSummary["hourly_distribution"]) {
  return buckets.reduce((max, bucket) => Math.max(max, bucket.sessions), 0);
}

function StatsCard({ title, value, hint, accent }: { title: string; value: string; hint: string; accent?: boolean }) {
  return (
    <article className={accent ? "stats-card accent" : "stats-card"}>
      <span>{title}</span>
      <strong>{value}</strong>
      <small>{hint}</small>
    </article>
  );
}

function overlayStageIcon(stage: Stage) {
  if (stage === "stopping") {
    return <Pause size={18} />;
  }
  if (stage === "transcribing") {
    return <Bot size={18} />;
  }
  if (stage === "recognized" || stage === "done") {
    return <Check size={18} />;
  }
  if (stage === "polishing") {
    return <Sparkles size={18} />;
  }
  if (stage === "translating") {
    return <Languages size={18} />;
  }
  if (stage === "error") {
    return <X size={18} />;
  }
  return <Mic size={18} />;
}

function activeModelProfile(config: AppConfig) {
  return config.whisper_model_profiles.find((profile) => profile.path === config.whisper_model_path);
}

function modelNameFromPath(path: string) {
  const name = path.split("/").pop()?.replace(/\.bin$/i, "");
  return name || "自定义模型";
}

function StatusDot({ ok, label, error }: { ok: boolean; label: string; error?: boolean }) {
  const className = ok ? "status-dot ok" : error ? "status-dot error" : "status-dot";
  return (
    <span className={className}>
      <i />
      {label}
    </span>
  );
}

function TabButton({
  active,
  icon,
  label,
  onClick
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button className={active ? "tab-button active" : "tab-button"} onClick={onClick}>
      {icon}
      {label}
    </button>
  );
}

function SettingsPanel({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <section className="settings-panel">
      <header className="settings-head">
        <h2>{title}</h2>
        <p>{subtitle}</p>
      </header>
      <div className="settings-list">{children}</div>
    </section>
  );
}

function SettingRow({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <div className="setting-row">
      <div className="setting-copy">
        <strong>{title}</strong>
        <span>{desc}</span>
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

function HistoryPager({
  page,
  total,
  pageSize,
  onPrev,
  onNext
}: {
  page: number;
  total: number;
  pageSize: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  const pages = historyPageCount(total);
  const start = total ? (page - 1) * pageSize + 1 : 0;
  const end = Math.min(total, page * pageSize);
  return (
    <div className="history-pager">
      <span>
        {start}-{end} / {total}
      </span>
      <div>
        <button className="icon-button" disabled={page <= 1} onClick={onPrev} title="上一页">
          <ChevronLeft size={17} />
        </button>
        <strong>
          {page} / {pages}
        </strong>
        <button className="icon-button" disabled={page >= pages} onClick={onNext} title="下一页">
          <ChevronRight size={17} />
        </button>
      </div>
    </div>
  );
}

function Pipeline({ stage }: { stage: Stage }) {
  const steps = [
    ["recording", "录音"],
    ["stopping", "整理录音"],
    ["transcribing", "本地识别"],
    ["recognized", "识别完成"],
    ["polishing", "AI润色"],
    ["translating", "翻译"]
  ] as const;
  const activeIndex = steps.findIndex(([key]) => key === stage);

  return (
    <div className="pipeline">
      {steps.map(([key, label], index) => (
        <span
          key={key}
          className={stage === key ? "active" : stage === "done" || (activeIndex > index && activeIndex !== -1) ? "done" : ""}
        >
          {stage === key ? <Loader2 className="spin" size={14} /> : <i />}
          {label}
        </span>
      ))}
    </div>
  );
}

function ProcessingNotice({ stage, seconds }: { stage: Stage; seconds: number }) {
  if (stage !== "stopping" && stage !== "transcribing" && stage !== "recognized" && stage !== "polishing" && stage !== "translating") {
    return null;
  }
  const processingCopy: Record<"stopping" | "transcribing" | "recognized" | "polishing" | "translating", [string, string]> = {
    stopping: ["正在整理录音", "正在结束麦克风采集并整理音频，通常只需要几秒。"],
    transcribing: ["本地识别中", "Whisper 模型正在处理录音，模型越大等待越久，界面会保持响应。"],
    recognized: ["识别完成", "本地转写已经完成，正在准备 AI 后续处理。"],
    polishing: ["AI 正在润色", "正在润色文本、整理断句和标点，完成后会继续输出。"],
    translating: ["实时翻译中", "正在生成目标语言版本，完成后会自动写入光标位置。"]
  };
  const copy = processingCopy[stage];
  return (
    <div className="processing-notice">
      <Loader2 className="spin" size={17} />
      <div>
        <strong>{copy[0]}</strong>
        <span>
          {copy[1]} 已处理 {seconds.toFixed(1)}s
        </span>
      </div>
    </div>
  );
}

function TimingStats({
  transcribeSeconds,
  correctionSeconds,
  translationSeconds
}: {
  transcribeSeconds?: number;
  correctionSeconds?: number;
  translationSeconds?: number;
}) {
  if (transcribeSeconds === undefined && correctionSeconds === undefined && translationSeconds === undefined) {
    return null;
  }
  return (
    <div className="timing-stats">
      <span>
        <strong>{transcribeSeconds === undefined ? "--" : `${transcribeSeconds.toFixed(1)}s`}</strong>
        本地识别
      </span>
      <span>
        <strong>{correctionSeconds === undefined ? "--" : `${correctionSeconds.toFixed(1)}s`}</strong>
        AI 润色
      </span>
      <span>
        <strong>{translationSeconds === undefined ? "--" : `${translationSeconds.toFixed(1)}s`}</strong>
        实时翻译
      </span>
    </div>
  );
}

function TextBlock({ title, icon, value }: { title: string; icon: React.ReactNode; value: string }) {
  return (
    <article className="text-block">
      <h2>
        {icon}
        {title}
      </h2>
      <p>{value}</p>
    </article>
  );
}

function emptyTranscriptText(stage: Stage) {
  if (stage === "recording") {
    return "正在收音，结束后会直接在本机执行识别";
  }
  if (stage === "stopping" || stage === "transcribing") {
    return "本地模型正在识别录音，完成后会显示原始转写";
  }
  return `点击开始说话，录音最长 ${MAX_SECONDS} 秒`;
}

function emptyCorrectedText(stage: Stage) {
  if (stage === "polishing") {
    return "正在进行 AI 润色、整理断句和标点";
  }
  if (stage === "stopping" || stage === "transcribing") {
    return "识别完成后会自动进入 AI 润色";
  }
  return "识别完成后自动进行 AI 润色";
}

function emptyTranslationText(stage: Stage) {
  if (stage === "translating") {
    return "正在生成目标语言版本";
  }
  if (stage === "polishing") {
    return "AI 润色完成后会继续翻译";
  }
  if (stage === "stopping" || stage === "transcribing") {
    return "AI 处理完成后会显示翻译结果";
  }
    return "AI 润色完成后自动翻译";
}

function toUserFacingError(error: unknown) {
  const message = String(error);
  if (
    message.includes("Cannot read properties of undefined") ||
    message.includes("__TAURI_INTERNALS__") ||
    message.includes("Tauri API")
  ) {
    return "当前页面未运行在 Tauri 桌面环境中：语音输入需要打开桌面应用，普通浏览器预览只能查看首页布局。";
  }
  if (
    message.includes("not allowed by the user agent") ||
    message.includes("denied permission") ||
    message.includes("Permission denied") ||
    message.includes("not permitted")
  ) {
    return "麦克风权限不可用：请在 macOS 系统设置 > 隐私与安全性 > 麦克风 中允许本应用访问麦克风，然后重新启动应用。";
  }
  if (message.includes("未找到默认麦克风输入设备") || message.includes("No input device")) {
    return "未找到默认麦克风：请连接或启用输入设备，并在系统声音设置中选择默认输入。";
  }
  if (message.includes("Device not available") || message.includes("in use")) {
    return "麦克风暂时不可用：可能被其他应用占用，请关闭占用麦克风的软件后重试。";
  }
  if (message.includes("RegisterEventHotKey failed") || message.includes("Unable to register hotkey")) {
    return "快捷键已被系统或其他软件占用，或当前系统不允许注册该键位：请在“快捷键”页换成另一个键位。";
  }
  if (message.includes("DeepSeek key 未配置")) {
    return "DeepSeek key 未配置：请在 AI 设置中填写本机 API Key，或填写 DeepSeek 服务地址走服务端代理。";
  }
  if (message.includes("WHISPER_MODEL_PATH") || message.includes("本地 Whisper 模型不可用")) {
    return "本地 Whisper 模型不可用：应用会优先使用 FunASR；如需离线识别，可在“模型设置”填写有效模型路径。";
  }
  return message;
}

function formatPasteFailureMessage(message: string, pasteShortcut: string) {
  const cleanMessage = message
    .replace(/。?文本已尽量写入剪贴板，可手动.*?粘贴。?$/u, "")
    .replace(/。?可手动.*?粘贴。?$/u, "")
    .trim();
  const suffix = cleanMessage.includes("文本已写入剪贴板")
    ? `可手动 ${pasteShortcut} 粘贴。`
    : `文本已尽量写入剪贴板，可手动 ${pasteShortcut} 粘贴。`;
  return `${cleanMessage.replace(/。$/u, "")}。${suffix}`;
}

function manualPasteShortcut() {
  const platform = navigator.platform.toLowerCase();
  const userAgent = navigator.userAgent.toLowerCase();
  return platform.includes("mac") || userAgent.includes("mac os") ? "Command+V" : "Ctrl+V";
}

function normalizeShortcut(event: KeyboardEvent) {
  const key = normalizeKey(event);
  if (!key) {
    return "";
  }
  if (isPhysicalModifierKey(key)) {
    const parts: string[] = [];
    if ((event.metaKey || event.ctrlKey) && !key.startsWith("Meta") && !key.startsWith("Control")) {
      parts.push("CommandOrControl");
    }
    if (event.altKey && !key.startsWith("Alt")) {
      parts.push("Alt");
    }
    if (event.shiftKey && !key.startsWith("Shift")) {
      parts.push("Shift");
    }
    parts.push(key);
    return parts.join("+");
  }
  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) {
    parts.push("CommandOrControl");
  }
  if (event.altKey) {
    parts.push("Alt");
  }
  if (event.shiftKey) {
    parts.push("Shift");
  }
  parts.push(key);
  return parts.join("+");
}

function buildModifierOnlyShortcut(modifiers: Set<string>) {
  return ["ControlLeft", "ControlRight", "AltLeft", "AltRight", "ShiftLeft", "ShiftRight", "MetaLeft", "MetaRight"]
    .filter((modifier) => modifiers.has(modifier))
    .join("+");
}

function normalizeKey(event: KeyboardEvent) {
  const { code, key } = event;
  if (isPhysicalModifierKey(code)) {
    return code;
  }
  if (code.startsWith("Numpad")) {
    return code;
  }
  if (PHYSICAL_CODE_KEYS.has(code)) {
    return code;
  }
  if (key === " ") {
    return "Space";
  }
  if (key.length === 1) {
    return key.toUpperCase();
  }
  const keyMap: Record<string, string> = {
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Escape: "Escape",
    Enter: "Enter",
    Tab: "Tab",
    Backspace: "Backspace",
    Delete: "Delete",
    Insert: "Insert",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
    CapsLock: "CapsLock",
    PrintScreen: "PrintScreen",
    ScrollLock: "ScrollLock",
    NumLock: "NumLock",
    ContextMenu: "ContextMenu"
  };
  return keyMap[key] || code || key;
}

const PHYSICAL_CODE_KEYS = new Set([
  "Backquote",
  "Backslash",
  "BracketLeft",
  "BracketRight",
  "Comma",
  "Digit0",
  "Digit1",
  "Digit2",
  "Digit3",
  "Digit4",
  "Digit5",
  "Digit6",
  "Digit7",
  "Digit8",
  "Digit9",
  "Equal",
  "IntlBackslash",
  "IntlRo",
  "IntlYen",
  "KeyA",
  "KeyB",
  "KeyC",
  "KeyD",
  "KeyE",
  "KeyF",
  "KeyG",
  "KeyH",
  "KeyI",
  "KeyJ",
  "KeyK",
  "KeyL",
  "KeyM",
  "KeyN",
  "KeyO",
  "KeyP",
  "KeyQ",
  "KeyR",
  "KeyS",
  "KeyT",
  "KeyU",
  "KeyV",
  "KeyW",
  "KeyX",
  "KeyY",
  "KeyZ",
  "Minus",
  "Period",
  "Quote",
  "Semicolon",
  "Slash"
]);

function isPhysicalModifierKey(code: string) {
  return ["AltLeft", "AltRight", "ControlLeft", "ControlRight", "MetaLeft", "MetaRight", "ShiftLeft", "ShiftRight"].includes(code);
}
