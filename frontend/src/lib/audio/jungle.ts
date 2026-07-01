const JUNGLE_DELAY = 0.1;
const JUNGLE_FADE = 0.05;
const JUNGLE_BUF = 0.1;

function createFadeBuffer(ctx: AudioContext, activeTime: number, fadeTime: number): AudioBuffer {
  const len1 = activeTime * ctx.sampleRate;
  const len2 = (activeTime - 2 * fadeTime) * ctx.sampleRate;
  const length = len1 + len2;
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const p = buffer.getChannelData(0);
  const fadeLength = fadeTime * ctx.sampleRate;
  const fadeIndex1 = fadeLength;
  const fadeIndex2 = len1 - fadeLength;

  for (let i = 0; i < len1; i += 1) {
    if (i < fadeIndex1) p[i] = Math.sqrt(i / fadeLength);
    else if (i >= fadeIndex2) p[i] = Math.sqrt(1 - (i - fadeIndex2) / fadeLength);
    else p[i] = 1;
  }
  for (let i = len1; i < length; i += 1) p[i] = 0;

  return buffer;
}

function createDelayTimeBuffer(ctx: AudioContext, activeTime: number, fadeTime: number, shiftUp: boolean): AudioBuffer {
  const len1 = activeTime * ctx.sampleRate;
  const len2 = (activeTime - 2 * fadeTime) * ctx.sampleRate;
  const length = len1 + len2;
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const p = buffer.getChannelData(0);

  for (let i = 0; i < len1; i += 1) p[i] = shiftUp ? (len1 - i) / length : i / len1;
  for (let i = len1; i < length; i += 1) p[i] = 0;

  return buffer;
}

export class Jungle {
  readonly input: GainNode;
  readonly output: GainNode;
  private readonly context: AudioContext;
  private readonly mod1Gain: GainNode;
  private readonly mod2Gain: GainNode;
  private readonly mod3Gain: GainNode;
  private readonly mod4Gain: GainNode;
  private readonly modGain1: GainNode;
  private readonly modGain2: GainNode;

  constructor(ctx: AudioContext) {
    this.context = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();

    const mod1 = ctx.createBufferSource();
    const mod2 = ctx.createBufferSource();
    const mod3 = ctx.createBufferSource();
    const mod4 = ctx.createBufferSource();
    const shiftDown = createDelayTimeBuffer(ctx, JUNGLE_BUF, JUNGLE_FADE, false);
    const shiftUp = createDelayTimeBuffer(ctx, JUNGLE_BUF, JUNGLE_FADE, true);

    mod1.buffer = shiftDown;
    mod2.buffer = shiftDown;
    mod3.buffer = shiftUp;
    mod4.buffer = shiftUp;
    mod1.loop = mod2.loop = mod3.loop = mod4.loop = true;

    this.mod1Gain = ctx.createGain();
    this.mod2Gain = ctx.createGain();
    this.mod3Gain = ctx.createGain();
    this.mod4Gain = ctx.createGain();
    this.mod3Gain.gain.value = 0;
    this.mod4Gain.gain.value = 0;

    mod1.connect(this.mod1Gain);
    mod2.connect(this.mod2Gain);
    mod3.connect(this.mod3Gain);
    mod4.connect(this.mod4Gain);

    this.modGain1 = ctx.createGain();
    this.modGain2 = ctx.createGain();
    const delay1 = ctx.createDelay();
    const delay2 = ctx.createDelay();

    this.mod1Gain.connect(this.modGain1);
    this.mod2Gain.connect(this.modGain2);
    this.mod3Gain.connect(this.modGain1);
    this.mod4Gain.connect(this.modGain2);
    this.modGain1.connect(delay1.delayTime);
    this.modGain2.connect(delay2.delayTime);

    const fade1 = ctx.createBufferSource();
    const fade2 = ctx.createBufferSource();
    const fadeBuffer = createFadeBuffer(ctx, JUNGLE_BUF, JUNGLE_FADE);
    fade1.buffer = fadeBuffer;
    fade2.buffer = fadeBuffer;
    fade1.loop = true;
    fade2.loop = true;

    const mix1 = ctx.createGain();
    const mix2 = ctx.createGain();
    mix1.gain.value = 0;
    mix2.gain.value = 0;
    fade1.connect(mix1.gain);
    fade2.connect(mix2.gain);

    this.input.connect(delay1);
    this.input.connect(delay2);
    delay1.connect(mix1);
    delay2.connect(mix2);
    mix1.connect(this.output);
    mix2.connect(this.output);

    const t = ctx.currentTime + 0.05;
    const t2 = t + JUNGLE_BUF - JUNGLE_FADE;
    mod1.start(t);
    mod2.start(t2);
    mod3.start(t);
    mod4.start(t2);
    fade1.start(t);
    fade2.start(t2);
  }

  setDelay(delay: number): void {
    this.modGain1.gain.setTargetAtTime(0.5 * delay, this.context.currentTime, 0.01);
    this.modGain2.gain.setTargetAtTime(0.5 * delay, this.context.currentTime, 0.01);
  }

  setPitchOffset(multiplier: number): void {
    if (multiplier > 0) {
      this.mod1Gain.gain.value = 0;
      this.mod2Gain.gain.value = 0;
      this.mod3Gain.gain.value = 1;
      this.mod4Gain.gain.value = 1;
    } else {
      this.mod1Gain.gain.value = 1;
      this.mod2Gain.gain.value = 1;
      this.mod3Gain.gain.value = 0;
      this.mod4Gain.gain.value = 0;
    }
    this.setDelay(JUNGLE_DELAY * Math.abs(multiplier));
  }
}

