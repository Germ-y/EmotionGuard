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
    voiceID?: string;
    voices?: VoicemodVoice[];
    status?: {
      code?: number;
      description?: string;
    };
  };
  payload?: {
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

export class VoicemodClient {
  private socket: WebSocket | null = null;
  private connecting: Promise<boolean> | null = null;
  private currentVoice = NOFX_VOICE_ID;
  private requestedVoice = NOFX_VOICE_ID;
  private desiredVoiceChange = false;
  private pending: PendingMessage[] = [];
  private authorized = false;
  private voiceChangerEnabled: boolean | null = null;
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

    this.desiredVoiceChange = enabled;
    const nextVoice = enabled ? this.resolveVoiceId() : NOFX_VOICE_ID;
    if (this.requestedVoice === nextVoice && this.socket?.readyState === WebSocket.OPEN && this.authorized) return true;

    const connected = await this.connect();
    if (!connected) return false;

    this.requestedVoice = nextVoice;
    this.send("loadVoice", { voiceID: nextVoice });
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
    if (action === "loadVoice" && this.authorized && this.voiceChangerEnabled === false) {
      this.socket.send(JSON.stringify({ id: requestId(), action: "toggleVoiceChanger", payload: {} }));
      this.voiceChangerEnabled = true;
    }
    this.socket.send(JSON.stringify(message));
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

    if (message.action === "registerClient" || message.actionType === "registerClient") {
      this.authorized = (message.payload?.status?.code ?? message.actionObject?.status?.code) === 200;
      this.onStatus?.(this.authorized ? "ready" : "error");
      if (this.authorized) {
        this.send("getVoiceChangerStatus", {});
        this.flushPending();
      }
      return;
    }

    if (
      message.actionType === "toggleVoiceChanger" ||
      message.actionType === "voiceChangerEnabledEvent" ||
      message.actionType === "voiceChangerDisabledEvent"
    ) {
      if (message.actionType === "voiceChangerEnabledEvent") this.voiceChangerEnabled = true;
      else if (message.actionType === "voiceChangerDisabledEvent") this.voiceChangerEnabled = false;
      else if (typeof message.actionObject?.value === "boolean") this.voiceChangerEnabled = message.actionObject.value;
      return;
    }

    if (message.actionType === "getVoices") {
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

    if (message.actionType === "voiceChangedEvent") {
      const voiceID = message.actionObject?.voiceID;
      if (voiceID) {
        const noEffect = isNoEffectVoice(voiceID) || !this.desiredVoiceChange;
        this.currentVoice = noEffect ? NOFX_VOICE_ID : voiceID;
        this.onStatus?.(noEffect ? "ready" : "active");
      }
      return;
    }

    if (message.actionType === "getCurrentVoice") {
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
