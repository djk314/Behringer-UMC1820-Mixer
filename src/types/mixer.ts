export type StripKind = 'input' | 'aux' | 'master';

export type PluginFormat = 'AU' | 'VST3' | 'VST2';

export type DspEffectType =
  | 'compressor'
  | 'saturator'
  | 'hpf'
  | 'chorus'
  | 'delay'
  | 'reverb'
  | 'limiter';

export interface PluginDescriptor {
  id: string;
  name: string;
  vendor: string;
  format: PluginFormat;
  category: string;
  dspType: DspEffectType;
  defaultParams: Record<string, number>;
}

export interface InsertPluginSlot {
  slotIndex: number; // 0..4 (max 5 inserts per strip)
  plugin: PluginDescriptor | null;
  bypassed: boolean;
  params: Record<string, number>;
}

export interface FourBandEq {
  lowGainDb: number;     // 80 Hz Low Shelf (-15 .. +15 dB)
  lowMidGainDb: number;  // 400 Hz Peaking (-15 .. +15 dB)
  highMidGainDb: number; // 2.5 kHz Peaking (-15 .. +15 dB)
  highGainDb: number;    // 10 kHz High Shelf (-15 .. +15 dB)
  bypassed: boolean;
}

export type InputSourceKind =
  | 'none'
  | 'kick_groove'
  | 'bass_synth'
  | 'epiano_chord'
  | 'lead_arp'
  | 'pink_noise'
  | 'sine_1k'
  | 'microphone';

export interface StripState {
  id: string;
  index: number;
  kind: StripKind;
  name: string;
  hardwareChannelLabel: string;
  /** Rotary Gain (-12 dB .. +24 dB). Not rendered/active on Master strip. */
  gainDb: number;
  /** Maximum 5 insert plugins per strip (VST2 / VST3 / Apple AU). */
  inserts: InsertPluginSlot[];
  /** 4-band rotary EQ. */
  eq: FourBandEq;
  /** 4 auxiliary rotary sends targeting UMC1820 Stereo Outputs 1/2, 3/4, 5/6, 7/8 (0..100%). */
  auxSends: [number, number, number, number];
  /** Solo push button (On/Off). Absent on Master strip. */
  solo: boolean;
  /** Mute push button (On/Off). */
  mute: boolean;
  /** Fader volume in dB (-60 dB = -inf, up to +12 dB). */
  volumeDb: number;
  /** Simulated / live audio source for Web Audio testing on input strips. */
  source: InputSourceKind;
}

export interface MeterLevel {
  peakDbL: number;
  peakDbR: number;
  rmsDbL: number;
  rmsDbR: number;
  clip: boolean;
}

export const MAX_INSERTS_PER_STRIP = 5;

export const PLUGIN_CATALOG: PluginDescriptor[] = [
  {
    id: 'au-dynamics-comp',
    name: 'AUDynamicsProcessor',
    vendor: 'Apple AudioUnit',
    format: 'AU',
    category: 'Dynamique',
    dspType: 'compressor',
    defaultParams: { threshold: -18, ratio: 4, attackMs: 12, releaseMs: 120 },
  },
  {
    id: 'vst3-tube-sat',
    name: 'ConsoleDrive Tube',
    vendor: 'Studio DSP',
    format: 'VST3',
    category: 'Saturation',
    dspType: 'saturator',
    defaultParams: { drive: 35, mix: 70 },
  },
  {
    id: 'au-hpf-filter',
    name: 'AUFilter HPF 80Hz',
    vendor: 'Apple AudioUnit',
    format: 'AU',
    category: 'Filtre',
    dspType: 'hpf',
    defaultParams: { freq: 85, q: 0.7 },
  },
  {
    id: 'vst3-chorus-dim',
    name: 'Dimension Ensemble',
    vendor: 'OpenAudio',
    format: 'VST3',
    category: 'Modulation',
    dspType: 'chorus',
    defaultParams: { rate: 1.4, depth: 45, mix: 35 },
  },
  {
    id: 'vst2-tape-echo',
    name: 'RE-201 Tape Echo',
    vendor: 'Legacy VST2',
    format: 'VST2',
    category: 'Delay',
    dspType: 'delay',
    defaultParams: { timeMs: 320, feedback: 35, mix: 25 },
  },
  {
    id: 'au-matrix-reverb',
    name: 'AUMatrixReverb Hall',
    vendor: 'Apple AudioUnit',
    format: 'AU',
    category: 'Réverbération',
    dspType: 'reverb',
    defaultParams: { decay: 45, mix: 28 },
  },
  {
    id: 'vst3-brick-limiter',
    name: 'L1 Master Limiter',
    vendor: 'Studio DSP',
    format: 'VST3',
    category: 'Mastering',
    dspType: 'limiter',
    defaultParams: { ceiling: -0.5, threshold: -6 },
  },
];

export const AUX_LABELS: [string, string, string, string] = [
  'Aux 1/2',
  'Aux 3/4',
  'Aux 5/6',
  'Aux 7/8',
];
