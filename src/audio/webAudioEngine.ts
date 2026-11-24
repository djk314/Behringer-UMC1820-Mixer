import {
  DspEffectType,
  InputSourceKind,
  InsertPluginSlot,
  MeterLevel,
  StripState,
} from '../types/mixer';

export function dbToGain(db: number): number {
  if (db <= -59.5) return 0;
  return Math.pow(10, db / 20);
}

export function gainToDb(gain: number): number {
  if (gain <= 0.0001) return -60;
  return Math.max(-60, Math.min(12, 20 * Math.log10(gain)));
}

interface InsertNodeBundle {
  input: AudioNode;
  output: AudioNode;
  dspType: DspEffectType;
  updateParams: (params: Record<string, number>, bypassed: boolean) => void;
  dispose: () => void;
}

interface StripAudioChain {
  inputSum: GainNode;
  trimGain: GainNode;
  insertsInput: GainNode;
  insertsOutput: GainNode;
  eqLow: BiquadFilterNode;
  eqLowMid: BiquadFilterNode;
  eqHighMid: BiquadFilterNode;
  eqHigh: BiquadFilterNode;
  muteSoloGain: GainNode;
  faderGain: GainNode;
  analyserL: AnalyserNode;
  analyserR: AnalyserNode;
  splitter: ChannelSplitterNode;
  auxSends: [GainNode, GainNode, GainNode, GainNode];
  activeInserts: InsertNodeBundle[];
  sourceStopper: (() => void) | null;
  currentSource: InputSourceKind;
  clipHoldUntil: number;
}

function createSaturationCurve(amount: number): Float32Array<ArrayBuffer> {
  const k = Math.max(0.1, amount) * 1.4;
  const n = 2048;
  const buffer = new ArrayBuffer(n * 4);
  const curve = new Float32Array(buffer);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((3 + k) * x * 20 * (Math.PI / 180)) / (Math.PI + k * Math.abs(x));
  }
  return curve;
}

function createImpulseBuffer(ctx: AudioContext, seconds = 1.6, decay = 2.4): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * seconds);
  const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
    }
  }
  return impulse;
}

function buildInsertNode(ctx: AudioContext, slot: InsertPluginSlot): InsertNodeBundle | null {
  if (!slot.plugin) return null;
  const dspType = slot.plugin.dspType;
  const dryGain = ctx.createGain();
  const wetGain = ctx.createGain();
  const input = ctx.createGain();
  const output = ctx.createGain();

  let cleanup: () => void = () => {};
  let update: (params: Record<string, number>, bypassed: boolean) => void = () => {};

  if (dspType === 'compressor' || dspType === 'limiter') {
    const comp = ctx.createDynamicsCompressor();
    input.connect(dryGain);
    input.connect(comp);
    comp.connect(wetGain);
    dryGain.connect(output);
    wetGain.connect(output);

    update = (params, bypassed) => {
      if (bypassed) {
        dryGain.gain.setTargetAtTime(1, ctx.currentTime, 0.015);
        wetGain.gain.setTargetAtTime(0, ctx.currentTime, 0.015);
      } else {
        dryGain.gain.setTargetAtTime(0, ctx.currentTime, 0.015);
        wetGain.gain.setTargetAtTime(1, ctx.currentTime, 0.015);
      }
      if (dspType === 'limiter') {
        comp.threshold.setTargetAtTime(params.threshold ?? -6, ctx.currentTime, 0.02);
        comp.ratio.setTargetAtTime(20, ctx.currentTime, 0.02);
        comp.attack.setTargetAtTime(0.002, ctx.currentTime, 0.02);
        comp.release.setTargetAtTime(0.08, ctx.currentTime, 0.02);
      } else {
        comp.threshold.setTargetAtTime(params.threshold ?? -18, ctx.currentTime, 0.02);
        comp.ratio.setTargetAtTime(params.ratio ?? 4, ctx.currentTime, 0.02);
        comp.attack.setTargetAtTime((params.attackMs ?? 12) / 1000, ctx.currentTime, 0.02);
        comp.release.setTargetAtTime((params.releaseMs ?? 120) / 1000, ctx.currentTime, 0.02);
      }
    };
  } else if (dspType === 'saturator') {
    const shaper = ctx.createWaveShaper();
    shaper.oversample = '2x';
    input.connect(dryGain);
    input.connect(shaper);
    shaper.connect(wetGain);
    dryGain.connect(output);
    wetGain.connect(output);

    update = (params, bypassed) => {
      const mix = bypassed ? 0 : (params.mix ?? 70) / 100;
      shaper.curve = createSaturationCurve(params.drive ?? 35);
      dryGain.gain.setTargetAtTime(1 - mix, ctx.currentTime, 0.015);
      wetGain.gain.setTargetAtTime(mix, ctx.currentTime, 0.015);
    };
  } else if (dspType === 'hpf') {
    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    input.connect(dryGain);
    input.connect(filter);
    filter.connect(wetGain);
    dryGain.connect(output);
    wetGain.connect(output);

    update = (params, bypassed) => {
      filter.frequency.setTargetAtTime(params.freq ?? 85, ctx.currentTime, 0.02);
      filter.Q.setTargetAtTime(params.q ?? 0.7, ctx.currentTime, 0.02);
      dryGain.gain.setTargetAtTime(bypassed ? 1 : 0, ctx.currentTime, 0.015);
      wetGain.gain.setTargetAtTime(bypassed ? 0 : 1, ctx.currentTime, 0.015);
    };
  } else if (dspType === 'chorus') {
    const delay = ctx.createDelay(0.1);
    delay.delayTime.value = 0.018;
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = 1.4;
    lfoGain.gain.value = 0.004;
    lfo.connect(lfoGain);
    lfoGain.connect(delay.delayTime);
    lfo.start();

    input.connect(dryGain);
    input.connect(delay);
    delay.connect(wetGain);
    dryGain.connect(output);
    wetGain.connect(output);

    update = (params, bypassed) => {
      const mix = bypassed ? 0 : (params.mix ?? 35) / 100;
      lfo.frequency.setTargetAtTime(params.rate ?? 1.4, ctx.currentTime, 0.02);
      lfoGain.gain.setTargetAtTime(((params.depth ?? 45) / 100) * 0.008, ctx.currentTime, 0.02);
      dryGain.gain.setTargetAtTime(1 - mix * 0.5, ctx.currentTime, 0.015);
      wetGain.gain.setTargetAtTime(mix, ctx.currentTime, 0.015);
    };
    cleanup = () => {
      try {
        lfo.stop();
        lfo.disconnect();
      } catch {
        // ignore
      }
    };
  } else if (dspType === 'delay') {
    const delay = ctx.createDelay(1.5);
    const fb = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3400;

    input.connect(dryGain);
    input.connect(delay);
    delay.connect(lp);
    lp.connect(fb);
    fb.connect(delay);
    lp.connect(wetGain);
    dryGain.connect(output);
    wetGain.connect(output);

    update = (params, bypassed) => {
      const mix = bypassed ? 0 : (params.mix ?? 25) / 100;
      delay.delayTime.setTargetAtTime((params.timeMs ?? 320) / 1000, ctx.currentTime, 0.02);
      fb.gain.setTargetAtTime(Math.min(0.85, (params.feedback ?? 35) / 100), ctx.currentTime, 0.02);
      dryGain.gain.setTargetAtTime(1, ctx.currentTime, 0.015);
      wetGain.gain.setTargetAtTime(mix, ctx.currentTime, 0.015);
    };
  } else if (dspType === 'reverb') {
    const convolver = ctx.createConvolver();
    convolver.buffer = createImpulseBuffer(ctx, 1.8, 2.5);
    input.connect(dryGain);
    input.connect(convolver);
    convolver.connect(wetGain);
    dryGain.connect(output);
    wetGain.connect(output);

    update = (params, bypassed) => {
      const mix = bypassed ? 0 : (params.mix ?? 28) / 100;
      dryGain.gain.setTargetAtTime(1, ctx.currentTime, 0.015);
      wetGain.gain.setTargetAtTime(mix, ctx.currentTime, 0.015);
    };
  }

  update(slot.params, slot.bypassed);
  return {
    input,
    output,
    dspType,
    updateParams: update,
    dispose: () => {
      cleanup();
      input.disconnect();
      output.disconnect();
    },
  };
}

export class WebAudioMixerEngine {
  private ctx: AudioContext | null = null;
  private chains = new Map<string, StripAudioChain>();
  private timeDomainBuffer = new Float32Array(512);
  private running = false;

  public isRunning(): boolean {
    return this.running && this.ctx?.state === 'running';
  }

  public getSampleRate(): number {
    return this.ctx?.sampleRate ?? 48000;
  }

  public async start(strips: StripState[]): Promise<void> {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx({ latencyHint: 'interactive' });
      this.buildGraph(strips);
    }
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
    this.running = true;
    this.syncAll(strips);
  }

  public async stop(): Promise<void> {
    this.running = false;
    if (this.ctx && this.ctx.state === 'running') {
      await this.ctx.suspend();
    }
  }

  private createStripChain(ctx: AudioContext): StripAudioChain {
    const inputSum = ctx.createGain();
    const trimGain = ctx.createGain();
    const insertsInput = ctx.createGain();
    const insertsOutput = ctx.createGain();
    insertsInput.connect(insertsOutput);

    const eqLow = ctx.createBiquadFilter();
    eqLow.type = 'lowshelf';
    eqLow.frequency.value = 80;

    const eqLowMid = ctx.createBiquadFilter();
    eqLowMid.type = 'peaking';
    eqLowMid.frequency.value = 400;
    eqLowMid.Q.value = 1.0;

    const eqHighMid = ctx.createBiquadFilter();
    eqHighMid.type = 'peaking';
    eqHighMid.frequency.value = 2500;
    eqHighMid.Q.value = 1.0;

    const eqHigh = ctx.createBiquadFilter();
    eqHigh.type = 'highshelf';
    eqHigh.frequency.value = 10000;

    const muteSoloGain = ctx.createGain();
    const faderGain = ctx.createGain();

    const splitter = ctx.createChannelSplitter(2);
    const analyserL = ctx.createAnalyser();
    analyserL.fftSize = 512;
    const analyserR = ctx.createAnalyser();
    analyserR.fftSize = 512;

    const auxSends: [GainNode, GainNode, GainNode, GainNode] = [
      ctx.createGain(),
      ctx.createGain(),
      ctx.createGain(),
      ctx.createGain(),
    ];

    inputSum.connect(trimGain);
    trimGain.connect(insertsInput);
    insertsOutput.connect(eqLow);
    eqLow.connect(eqLowMid);
    eqLowMid.connect(eqHighMid);
    eqHighMid.connect(eqHigh);
    eqHigh.connect(muteSoloGain);
    muteSoloGain.connect(faderGain);

    // Post-fader metering & Aux sends
    faderGain.connect(splitter);
    splitter.connect(analyserL, 0);
    splitter.connect(analyserR, 1);

    for (const aux of auxSends) {
      faderGain.connect(aux);
    }

    return {
      inputSum,
      trimGain,
      insertsInput,
      insertsOutput,
      eqLow,
      eqLowMid,
      eqHighMid,
      eqHigh,
      muteSoloGain,
      faderGain,
      analyserL,
      analyserR,
      splitter,
      auxSends,
      activeInserts: [],
      sourceStopper: null,
      currentSource: 'none',
      clipHoldUntil: 0,
    };
  }

  private buildGraph(strips: StripState[]) {
    if (!this.ctx) return;
    const ctx = this.ctx;

    for (const strip of strips) {
      this.chains.set(strip.id, this.createStripChain(ctx));
    }

    const masterStrip = strips.find((s) => s.kind === 'master');
    const auxStrips = strips.filter((s) => s.kind === 'aux');
    const inputStrips = strips.filter((s) => s.kind === 'input');

    const masterChain = masterStrip ? this.chains.get(masterStrip.id) : undefined;
    if (masterChain) {
      masterChain.faderGain.connect(ctx.destination);
    }

    // Connect 4 Aux strips -> Master
    auxStrips.forEach((auxStrip) => {
      const auxChain = this.chains.get(auxStrip.id);
      if (auxChain && masterChain) {
        auxChain.faderGain.connect(masterChain.inputSum);
      }
    });

    // Connect 8 Input strips -> Master & 4 Aux buses
    inputStrips.forEach((inStrip) => {
      const inChain = this.chains.get(inStrip.id);
      if (!inChain) return;
      if (masterChain) {
        inChain.faderGain.connect(masterChain.inputSum);
      }
      auxStrips.forEach((auxStrip, auxIdx) => {
        const auxChain = this.chains.get(auxStrip.id);
        if (auxChain && auxIdx < 4) {
          inChain.auxSends[auxIdx].connect(auxChain.inputSum);
        }
      });
    });
  }

  public syncAll(strips: StripState[]) {
    if (!this.ctx) return;
    const ctx = this.ctx;

    const anyInputSolo = strips.some((s) => s.kind === 'input' && s.solo);
    const anyAuxSolo = strips.some((s) => s.kind === 'aux' && s.solo);
    const anySolo = anyInputSolo || anyAuxSolo;

    for (const strip of strips) {
      const chain = this.chains.get(strip.id);
      if (!chain) continue;

      // Gain (Input strips only; Aux and Master stay at unity 0 dB)
      const trimLinear = strip.kind === 'input' ? dbToGain(strip.gainDb) : 1;
      chain.trimGain.gain.setTargetAtTime(trimLinear, ctx.currentTime, 0.015);

      // 4-Band EQ
      const eqBypass = strip.eq.bypassed;
      chain.eqLow.gain.setTargetAtTime(eqBypass ? 0 : strip.eq.lowGainDb, ctx.currentTime, 0.02);
      chain.eqLowMid.gain.setTargetAtTime(eqBypass ? 0 : strip.eq.lowMidGainDb, ctx.currentTime, 0.02);
      chain.eqHighMid.gain.setTargetAtTime(eqBypass ? 0 : strip.eq.highMidGainDb, ctx.currentTime, 0.02);
      chain.eqHigh.gain.setTargetAtTime(eqBypass ? 0 : strip.eq.highGainDb, ctx.currentTime, 0.02);

      // Mute / Solo (Master has no Solo!)
      let isAudible = !strip.mute;
      if (strip.kind !== 'master' && anySolo) {
        isAudible = strip.solo && !strip.mute;
      }
      chain.muteSoloGain.gain.setTargetAtTime(isAudible ? 1 : 0, ctx.currentTime, 0.01);

      // Volume Fader
      chain.faderGain.gain.setTargetAtTime(dbToGain(strip.volumeDb), ctx.currentTime, 0.015);

      // 4 Aux Sends (0..100% -> 0.0..1.0)
      for (let i = 0; i < 4; i++) {
        chain.auxSends[i].gain.setTargetAtTime(strip.auxSends[i] / 100, ctx.currentTime, 0.015);
      }

      // Sync Inserts if plugin list changed
      this.syncInserts(chain, strip.inserts);

      // Sync Input Source
      if (strip.kind === 'input' && chain.currentSource !== strip.source) {
        this.attachSource(chain, strip.source);
      }
    }
  }

  private syncInserts(chain: StripAudioChain, slots: InsertPluginSlot[]) {
    if (!this.ctx) return;
    const ctx = this.ctx;

    const activeSlots = slots.filter((s) => s.plugin !== null);
    const sameChain =
      activeSlots.length === chain.activeInserts.length &&
      activeSlots.every((s, idx) => s.plugin?.dspType === chain.activeInserts[idx].dspType);

    if (sameChain) {
      activeSlots.forEach((slot, idx) => {
        chain.activeInserts[idx].updateParams(slot.params, slot.bypassed);
      });
      return;
    }

    // Rebuild insert chain cleanly
    chain.insertsInput.disconnect();
    for (const bundle of chain.activeInserts) {
      bundle.dispose();
    }
    chain.activeInserts = [];

    let prev: AudioNode = chain.insertsInput;
    for (const slot of activeSlots) {
      const bundle = buildInsertNode(ctx, slot);
      if (bundle) {
        prev.connect(bundle.input);
        prev = bundle.output;
        chain.activeInserts.push(bundle);
      }
    }
    prev.connect(chain.insertsOutput);
  }

  private attachSource(chain: StripAudioChain, kind: InputSourceKind) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    if (chain.sourceStopper) {
      chain.sourceStopper();
      chain.sourceStopper = null;
    }
    chain.currentSource = kind;
    if (kind === 'none') return;

    if (kind === 'sine_1k') {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 440;
      g.gain.value = 0.14;
      osc.connect(g);
      g.connect(chain.inputSum);
      osc.start();
      chain.sourceStopper = () => {
        osc.stop();
        osc.disconnect();
        g.disconnect();
      };
    } else if (kind === 'pink_noise') {
      const len = ctx.sampleRate * 2;
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = buf.getChannelData(0);
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < len; i++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.96900 * b2 + white * 0.1538520;
        b3 = 0.86650 * b3 + white * 0.3104856;
        b4 = 0.55000 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.0168980;
        data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.04;
        b6 = white * 0.115926;
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(chain.inputSum);
      src.start();
      chain.sourceStopper = () => {
        src.stop();
        src.disconnect();
      };
    } else if (kind === 'kick_groove') {
      let step = 0;
      const id = window.setInterval(() => {
        if (ctx.state !== 'running') return;
        const now = ctx.currentTime;
        if (step % 4 === 0) {
          // Punchy kick
          const osc = ctx.createOscillator();
          const g = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(135, now);
          osc.frequency.exponentialRampToValueAtTime(42, now + 0.14);
          g.gain.setValueAtTime(0.45, now);
          g.gain.exponentialRampToValueAtTime(0.001, now + 0.28);
          osc.connect(g);
          g.connect(chain.inputSum);
          osc.start(now);
          osc.stop(now + 0.3);
        } else if (step % 4 === 2) {
          // Crisp hat/snare pulse
          const osc = ctx.createOscillator();
          const g = ctx.createGain();
          osc.type = 'triangle';
          osc.frequency.setValueAtTime(220, now);
          osc.frequency.exponentialRampToValueAtTime(110, now + 0.08);
          g.gain.setValueAtTime(0.22, now);
          g.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
          osc.connect(g);
          g.connect(chain.inputSum);
          osc.start(now);
          osc.stop(now + 0.13);
        }
        step = (step + 1) % 16;
      }, 145);
      chain.sourceStopper = () => window.clearInterval(id);
    } else if (kind === 'bass_synth') {
      const notes = [55, 55, 65.41, 73.42, 55, 55, 82.41, 73.42];
      let step = 0;
      const id = window.setInterval(() => {
        if (ctx.state !== 'running') return;
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const filt = ctx.createBiquadFilter();
        const g = ctx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.value = notes[step % notes.length];
        filt.type = 'lowpass';
        filt.frequency.setValueAtTime(520, now);
        filt.frequency.exponentialRampToValueAtTime(160, now + 0.22);
        g.gain.setValueAtTime(0.22, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.26);
        osc.connect(filt);
        filt.connect(g);
        g.connect(chain.inputSum);
        osc.start(now);
        osc.stop(now + 0.27);
        step++;
      }, 290);
      chain.sourceStopper = () => window.clearInterval(id);
    } else if (kind === 'epiano_chord') {
      const chords = [
        [220, 261.63, 329.63, 392.0],
        [174.61, 220, 261.63, 329.63],
        [196, 246.94, 293.66, 349.23],
      ];
      let step = 0;
      const id = window.setInterval(() => {
        if (ctx.state !== 'running') return;
        const now = ctx.currentTime;
        const chord = chords[step % chords.length];
        chord.forEach((freq) => {
          const osc = ctx.createOscillator();
          const g = ctx.createGain();
          osc.type = 'triangle';
          osc.frequency.value = freq;
          g.gain.setValueAtTime(0.06, now);
          g.gain.exponentialRampToValueAtTime(0.001, now + 1.05);
          osc.connect(g);
          g.connect(chain.inputSum);
          osc.start(now);
          osc.stop(now + 1.1);
        });
        step++;
      }, 1160);
      chain.sourceStopper = () => window.clearInterval(id);
    } else if (kind === 'lead_arp') {
      const notes = [440, 523.25, 659.25, 783.99, 659.25, 523.25];
      let step = 0;
      const id = window.setInterval(() => {
        if (ctx.state !== 'running') return;
        const now = ctx.currentTime;
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = notes[step % notes.length];
        g.gain.setValueAtTime(0.14, now);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
        osc.connect(g);
        g.connect(chain.inputSum);
        osc.start(now);
        osc.stop(now + 0.19);
        step++;
      }, 193);
      chain.sourceStopper = () => window.clearInterval(id);
    } else if (kind === 'microphone') {
      let stopped = false;
      let streamRef: MediaStream | null = null;
      let mediaNode: MediaStreamAudioSourceNode | null = null;
      navigator.mediaDevices
        .getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
        .then((stream) => {
          if (stopped) {
            stream.getTracks().forEach((t) => t.stop());
            return;
          }
          streamRef = stream;
          mediaNode = ctx.createMediaStreamSource(stream);
          mediaNode.connect(chain.inputSum);
        })
        .catch(() => {
          // Graceful fallback if mic permission denied
        });
      chain.sourceStopper = () => {
        stopped = true;
        if (mediaNode) mediaNode.disconnect();
        if (streamRef) streamRef.getTracks().forEach((t) => t.stop());
      };
    }
  }

  public readMeters(): Record<string, MeterLevel> {
    const result: Record<string, MeterLevel> = {};
    const now = performance.now();

    for (const [id, chain] of this.chains.entries()) {
      const readAnalyser = (analyser: AnalyserNode): { peakDb: number; rmsDb: number } => {
        analyser.getFloatTimeDomainData(this.timeDomainBuffer);
        let peak = 0;
        let sumSq = 0;
        for (let i = 0; i < this.timeDomainBuffer.length; i++) {
          const v = Math.abs(this.timeDomainBuffer[i]);
          if (v > peak) peak = v;
          sumSq += v * v;
        }
        const rms = Math.sqrt(sumSq / this.timeDomainBuffer.length);
        const peakDb = peak > 0.0001 ? Math.max(-60, 20 * Math.log10(peak)) : -60;
        const rmsDb = rms > 0.0001 ? Math.max(-60, 20 * Math.log10(rms)) : -60;
        return { peakDb, rmsDb };
      };

      const l = readAnalyser(chain.analyserL);
      const r = readAnalyser(chain.analyserR);
      if (l.peakDb >= -0.3 || r.peakDb >= -0.3) {
        chain.clipHoldUntil = now + 1500;
      }

      result[id] = {
        peakDbL: l.peakDb,
        peakDbR: r.peakDb,
        rmsDbL: l.rmsDb,
        rmsDbR: r.rmsDb,
        clip: now < chain.clipHoldUntil,
      };
    }
    return result;
  }
}
