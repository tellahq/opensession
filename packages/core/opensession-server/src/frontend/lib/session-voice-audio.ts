export interface SessionVoiceLevels {
  current: { input: number; output: number };
}

export function voiceAudioEnergy(samples: Uint8Array): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (const value of samples) sum += ((value - 128) / 128) ** 2;
  return Math.min(1, Math.sqrt(sum / samples.length) * 5);
}

interface MeterChannel {
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  samples: Uint8Array<ArrayBuffer>;
}

/** Observe both streams without routing either to the speakers. The existing
 * audio element owns playback; connecting a destination here would echo it. */
export class SessionVoiceAudioMeter {
  private context: AudioContext | null = null;
  private channels: Partial<Record<"input" | "output", MeterChannel>> = {};
  private frame: number | null = null;
  private closed = false;
  constructor(private levels: SessionVoiceLevels) {}

  attach(stream: MediaStream, side: "input" | "output") {
    if (
      this.closed ||
      !globalThis.AudioContext ||
      !globalThis.requestAnimationFrame
    )
      return;
    try {
      const context = (this.context ??= new AudioContext());
      void context.resume().catch(() => {});
      this.channels[side]?.source.disconnect();
      this.channels[side]?.analyser.disconnect();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      this.channels[side] = {
        source,
        analyser,
        samples: new Uint8Array(analyser.fftSize),
      };
      if (this.frame === null) this.frame = requestAnimationFrame(this.sample);
    } catch {
      // Visualization is optional; never fail a working voice call for it.
      this.levels.current[side] = 0;
    }
  }

  private sample = () => {
    if (this.closed) return;
    for (const side of ["input", "output"] as const) {
      const channel = this.channels[side];
      if (!channel) continue;
      channel.analyser.getByteTimeDomainData(channel.samples);
      this.levels.current[side] = voiceAudioEnergy(channel.samples);
    }
    this.frame = requestAnimationFrame(this.sample);
  };

  stop() {
    this.closed = true;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    for (const channel of Object.values(this.channels)) {
      channel.source.disconnect();
      channel.analyser.disconnect();
    }
    this.channels = {};
    void this.context?.close().catch(() => {});
    this.context = null;
    this.levels.current.input = this.levels.current.output = 0;
  }
}
