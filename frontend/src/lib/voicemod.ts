const VOICEMOD_PORTS = [
  59129,
  20000,
  39273,
  42152,
  43782,
  46667,
  35679,
  37170,
  38501,
  33952,
  30546,
];

const VOICEMOD_KEY_STORAGE = "emotionguard.voicemod.clientKey";
const DEFAULT_VOICE_ID = "narrator";
const NOFX_VOICE_ID = "nofx";
const NOFX_INTERNAL_ID = "00000000-0000-0000-0000-000000000000";

export type VoicemodStatus = "disabled" | "connecting" | "pending" | "ready" | "active" | "error";

type PendingMessage = {
  action: string;
  payload: Record<string, unknown>;
};

type VoicemodVoice = {
  id?: string;
  friendlyName?: string;
  enabled?: boolean;
};

type VoicemodEvent = {
  action?: string;
  actionType?: string;
  msg?: string;
  actionObject?: {
    value?: boolean;
    enabled?: boolean;
    voiceChangerEnabled?: boolean;
    backgroundEnabled?: boolean;
    voiceID?: string;
    voices?: VoicemodVoice[];
    status?: {
      code?: number;
      description?: string;
    };
  };
  payload?: {
    value?: boolean;
    enabled?: boolean;
    voiceChangerEnabled?: boolean;
    backgroundEnabled?: boolean;
    status?: {
      code?: number;
      description?: string;
    };
  };
};

function requestId() {
  if ("crypto" in window && "randomUUID" in window.crypto) return window.crypto.randomUUID();
  return `eg-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getVoicemodClientKey() {
  return (
    import.meta.env.VITE_VOICEMOD_CLIENT_KEY?.trim() ||
    window.localStorage.getItem(VOICEMOD_KEY_STORAGE)?.trim() ||
    ""
  );
}

function isNoEffectVoice(voiceID: string) {
  return voiceID === NOFX_VOICE_ID || voiceID === NOFX_INTERNAL_ID;
}

function readBooleanStatus(message: VoicemodEvent) {
  const candidates = [
    message.actionObject?.value,
    message.actionObject?.enabled,
    message.actionObject?.voiceChangerEnabled,
    message.actionObject?.backgroundEnabled,
    message.payload?.value,
    message.payload?.enabled,
    message.payload?.voiceChangerEnabled,
    message.payload?.backgroundEnabled,
  ];
  return candidates.find((value): value is boolean => typeof value === "boolean") ?? null;
}

export class VoicemodClient {
  private socket: WebSocket | null = null;
  private connecting: Promise<boolean> | null = null;
  private currentVoice = NOFX_VOICE_ID;
  private requestedVoice = NOFX_VOICE_ID;
  private desiredVoiceChange = false;
  private pending: PendingMessage[] = [];
  private authorized = false;
  private voiceChangerEnabled: boolean | null = null;
  private backgroundEnabled: boolean | null = null;
  private voices: VoicemodVoice[] = [];

  constructor(
    private readonly clientKey = getVoicemodClientKey(),
    private readonly voiceId = import.meta.env.VITE_VOICEMOD_VOICE_ID?.trim() || DEFAULT_VOICE_ID,
    private readonly onStatus?: (status: VoicemodStatus) => void,
  ) {}

  get enabled() {
    return Boolean(this.clientKey);
  }

  async setVoiceChange(enabled: boolean) {
    if (!this.enabled) {
      this.onStatus?.("disabled");
      return false;
    }

    const connected = await this.connect();
    if (!connected) return false;

    this.desiredVoiceChange = enabled;
    this.stopSoundboard();
    this.disableBackgroundEffects();
    if (!enabled) {
      this.disableVoiceChanger();
      this.onStatus?.(this.authorized ? "ready" : "pending");
      return true;
    }

    const nextVoice = this.resolveVoiceId();
    const voiceAlreadySelected = this.currentVoice === nextVoice || this.requestedVoice === nextVoice;
    if (!voiceAlreadySelected) {
      this.requestedVoice = nextVoice;
      this.send("loadVoice", { voiceID: nextVoice });
    } else {
      this.send("getVoiceChangerStatus", {});
      this.enableVoiceChanger();
    }

    this.onStatus?.(this.authorized ? (enabled ? "active" : "ready") : "pending");
    return true;
  }

  close() {
    this.pending = [];
    this.currentVoice = NOFX_VOICE_ID;
    this.requestedVoice = NOFX_VOICE_ID;
    this.desiredVoiceChange = false;
    this.authorized = false;
    this.voiceChangerEnabled = null;
    this.backgroundEnabled = null;
    this.socket?.close();
    this.socket = null;
    this.connecting = null;
  }

  private async connect() {
    if (this.socket?.readyState === WebSocket.OPEN) return true;
    if (this.connecting) return this.connecting;

    this.onStatus?.("connecting");
    this.connecting = this.tryConnectPorts();
    const connected = await this.connecting;
    this.connecting = null;
    if (!connected) this.onStatus?.("error");
    return connected;
  }

  private async tryConnectPorts() {
    for (const port of VOICEMOD_PORTS) {
      const socket = await this.openSocket(port);
      if (!socket) continue;

      this.socket = socket;
      socket.addEventListener("close", () => {
        if (this.socket === socket) {
          this.socket = null;
          this.currentVoice = NOFX_VOICE_ID;
          this.requestedVoice = NOFX_VOICE_ID;
          this.authorized = false;
          this.voiceChangerEnabled = null;
          this.backgroundEnabled = null;
          this.onStatus?.("error");
        }
      });
      socket.addEventListener("message", (event) => this.handleMessage(event));

      this.send("registerClient", { clientKey: this.clientKey });
      return true;
    }

    return false;
  }

  private openSocket(port: number) {
    return new Promise<WebSocket | null>((resolve) => {
      let settled = false;
      const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/`);
      const finish = (value: WebSocket | null) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(value);
      };
      const timer = window.setTimeout(() => {
        socket.close();
        finish(null);
      }, 450);

      socket.addEventListener("open", () => {
        finish(socket);
      }, { once: true });

      socket.addEventListener("error", () => {
        finish(null);
      }, { once: true });
    });
  }

  private send(action: string, payload: Record<string, unknown>) {
    const message = { id: requestId(), action, payload };
    if (this.socket?.readyState !== WebSocket.OPEN) {
      this.pending.push({ action, payload });
      return;
    }
    if (!this.authorized && action !== "registerClient") {
      this.pending.push({ action, payload });
      return;
    }
    const voiceID = typeof payload.voiceID === "string" ? payload.voiceID : "";
    if (action === "loadVoice" && isNoEffectVoice(voiceID)) {
      this.disableVoiceChanger();
      return;
    }
    if (action === "loadVoice" && this.authorized && this.voiceChangerEnabled === false && !isNoEffectVoice(voiceID)) {
      this.enableVoiceChanger();
    }
    this.socket.send(JSON.stringify(message));
    if (action === "loadVoice" && !isNoEffectVoice(voiceID)) {
      this.send("getVoiceChangerStatus", {});
    }
  }

  private flushPending() {
    const pending = [...this.pending];
    this.pending = [];
    pending.forEach((message) => this.send(message.action, message.payload));
  }

  private resolveVoiceId() {
    const preferred = this.voiceId.toLowerCase();
    const exact = this.voices.find((voice) => voice.id?.toLowerCase() === preferred && voice.enabled !== false);
    if (exact?.id) return exact.id;

    const strongCandidate = this.voices.find((voice) => {
      const label = `${voice.id ?? ""} ${voice.friendlyName ?? ""}`.toLowerCase();
      return voice.enabled !== false && /narrator|robot|android|droid|digital|blocks|ai|tech|deep|cave/.test(label);
    });
    if (strongCandidate?.id) return strongCandidate.id;

    return this.voices.find((voice) => voice.enabled !== false && voice.id && voice.id !== NOFX_VOICE_ID)?.id || this.voiceId;
  }

  private disableVoiceChanger() {
    if (this.socket?.readyState !== WebSocket.OPEN || !this.authorized || this.voiceChangerEnabled !== true) return;
    this.socket.send(JSON.stringify({ id: requestId(), action: "toggleVoiceChanger", payload: {} }));
    this.voiceChangerEnabled = false;
  }

  private enableVoiceChanger() {
    if (this.socket?.readyState !== WebSocket.OPEN || !this.authorized || this.voiceChangerEnabled !== false) return;
    this.socket.send(JSON.stringify({ id: requestId(), action: "toggleVoiceChanger", payload: {} }));
    this.voiceChangerEnabled = true;
  }

  private stopSoundboard() {
    if (this.socket?.readyState !== WebSocket.OPEN || !this.authorized) return;
    this.socket.send(JSON.stringify({ id: requestId(), action: "stopAllMemeSounds", payload: {} }));
  }

  private disableBackgroundEffects() {
    if (this.socket?.readyState !== WebSocket.OPEN || !this.authorized || this.backgroundEnabled !== true) return;
    this.socket.send(JSON.stringify({ id: requestId(), action: "toggleBackground", payload: {} }));
    this.backgroundEnabled = false;
  }

  private handleMessage(event: MessageEvent) {
    let message: VoicemodEvent;
    try {
      message = JSON.parse(String(event.data)) as VoicemodEvent;
    } catch {
      return;
    }

    if (message.msg?.toLowerCase().includes("pending authentication")) {
      this.onStatus?.("pending");
      return;
    }

    const actionName = message.actionType || message.action || "";

    if (actionName === "registerClient") {
      this.authorized = (message.payload?.status?.code ?? message.actionObject?.status?.code) === 200;
      this.onStatus?.(this.authorized ? "ready" : "error");
      if (this.authorized) {
        this.stopSoundboard();
        this.send("getVoiceChangerStatus", {});
        this.send("getBackgroundEffectStatus", {});
        this.send("getVoices", {});
        this.flushPending();
      }
      return;
    }

    if (actionName === "getVoiceChangerStatus") {
      const enabled = readBooleanStatus(message);
      if (enabled !== null) this.voiceChangerEnabled = enabled;
      if (this.desiredVoiceChange) this.enableVoiceChanger();
      else this.disableVoiceChanger();
      return;
    }

    if (actionName === "getBackgroundEffectStatus" || actionName === "toggleBackground") {
      const enabled = readBooleanStatus(message);
      if (enabled !== null) this.backgroundEnabled = enabled;
      this.disableBackgroundEffects();
      return;
    }

    if (actionName === "stopAllMemeSounds") return;

    if (
      actionName === "toggleVoiceChanger" ||
      actionName === "voiceChangerEnabledEvent" ||
      actionName === "voiceChangerDisabledEvent"
    ) {
      if (actionName === "voiceChangerEnabledEvent") this.voiceChangerEnabled = true;
      else if (actionName === "voiceChangerDisabledEvent") this.voiceChangerEnabled = false;
      else {
        const enabled = readBooleanStatus(message);
        if (enabled !== null) this.voiceChangerEnabled = enabled;
      }
      if (!this.desiredVoiceChange) this.disableVoiceChanger();
      else this.enableVoiceChanger();
      return;
    }

    if (actionName === "getVoices") {
      this.voices = message.actionObject?.voices ?? [];
      if (this.desiredVoiceChange) {
        const nextVoice = this.resolveVoiceId();
        if (nextVoice !== this.requestedVoice) {
          this.requestedVoice = nextVoice;
          this.send("loadVoice", { voiceID: nextVoice });
        }
      }
      return;
    }

    if (actionName === "voiceChangedEvent") {
      const voiceID = message.actionObject?.voiceID;
      if (voiceID) {
        const noEffect = isNoEffectVoice(voiceID) || !this.desiredVoiceChange;
        this.currentVoice = noEffect ? NOFX_VOICE_ID : voiceID;
        this.onStatus?.(noEffect ? "ready" : "active");
      }
      return;
    }

    if (actionName === "getCurrentVoice") {
      const voiceID = message.actionObject?.voiceID;
      if (voiceID) {
        const noEffect = isNoEffectVoice(voiceID) || !this.desiredVoiceChange;
        this.currentVoice = noEffect ? NOFX_VOICE_ID : voiceID;
        this.onStatus?.(noEffect ? "ready" : "active");
      }
    }
  }
}

export function createVoicemodClient(onStatus?: (status: VoicemodStatus) => void) {
  return new VoicemodClient(undefined, undefined, onStatus);
}
