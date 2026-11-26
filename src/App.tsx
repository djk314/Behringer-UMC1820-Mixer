import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  Download,
  FolderOpen,
  Music,
  Pause,
  Play,
  RefreshCw,
  Repeat,
  RotateCcw,
  Save,
  Split,
  Square,
} from 'lucide-react';
import { WebAudioMixerEngine } from './audio/webAudioEngine';
import { ChannelStrip } from './components/ChannelStrip';
import { PluginModal } from './components/PluginModal';
import { RemoteControlView, RemoteWsStatus } from './components/RemoteControlView';
import { RoutingMatrixView } from './components/RoutingMatrixView';
import { RustCodeExplorer } from './components/RustCodeExplorer';
import { RUST_PROJECT_FILES } from './data/rustProjectFiles';
import {
  AudioBufferLatencyPreset,
  AuxPairStereoState,
  AuxSendsTuple,
  HardwareInputRoute,
  HardwareOutputRoute,
  InputPairStereoState,
  InsertPluginSlot,
  MAX_AUX_PAIRS,
  MAX_INPUT_PAIRS,
  MAX_INSERTS_PER_STRIP,
  MeterLevel,
  MidiPortInfo,
  MixerSetSnapshot,
  NUM_AUX_BUSES,
  NUM_INPUT_STRIPS,
  PLUGIN_CATALOG,
  PlayerStatus,
  PluginDescriptor,
  StripState,
  formatInputRouteLabel,
  formatOutputRouteLabel,
} from './types/mixer';
import { buildZipArchive } from './utils/zipBuilder';

type ActiveTab = 'console' | 'routing' | 'remote' | 'rust';
type OsDriverProfile = 'macos_coreaudio' | 'linux_alsa';
type StripViewFilter = 'all' | 'inputs' | 'buses';
type InputBankFilter = 'all' | 'b1' | 'b2';
type HardwareProfileId = 'umc1820' | 'stereo_2x2' | 'quad_4x4' | 'studio_16x16';

const BUFFER_LATENCY_PRESETS: AudioBufferLatencyPreset[] = [64, 128, 256, 512, 1024, 2048];
const DEFAULT_INPUT_PAIRS: InputPairStereoState = [true, true, true, true, true, true, true, true];
const DEFAULT_AUX_PAIRS: AuxPairStereoState = [true, true, true, true];

const HARDWARE_PROFILES: Record<
  HardwareProfileId,
  { label: string; in: number; out: number }
> = {
  umc1820: { label: 'Behringer UMC1820 (8 IN / 10 OUT)', in: 8, out: 10 },
  stereo_2x2: { label: 'Interface Standard (2 IN / 2 OUT)', in: 2, out: 2 },
  quad_4x4: { label: 'Interface 4×4 (4 IN / 4 OUT)', in: 4, out: 4 },
  studio_16x16: { label: 'Interface Studio (16 IN / 16 OUT)', in: 16, out: 16 },
};

const EMPTY_AUX_SENDS: AuxSendsTuple = [0, 0, 0, 0, 0, 0, 0, 0];

function createEmptyInserts(): InsertPluginSlot[] {
  return Array.from({ length: MAX_INSERTS_PER_STRIP }, (_, slotIndex) => ({
    slotIndex,
    plugin: null,
    bypassed: false,
    params: {},
  }));
}

function createInitialStrips(): StripState[] {
  const inputs: StripState[] = Array.from({ length: NUM_INPUT_STRIPS }, (_, i) => {
    const pairIdx = Math.floor(i / 2);
    const isPrimary = i % 2 === 0;
    const ch1 = pairIdx * 2 + 1;
    const ch2 = pairIdx * 2 + 2;
    const inputRoute: HardwareInputRoute = isPrimary
      ? { kind: 'stereo', channel: pairIdx * 2 }
      : { kind: 'mono', channel: i };
    return {
      id: `in-${i + 1}`,
      index: i,
      kind: 'input',
      name: isPrimary ? `IN ${ch1}/${ch2}` : `IN ${i + 1}`,
      hardwareChannelLabel: formatInputRouteLabel(inputRoute),
      inputRoute,
      outputRoute: { kind: 'master' },
      gainDb: 0,
      midiDevice: 'all',
      midiChannel: 0,
      inserts: createEmptyInserts(),
      eq: {
        lowGainDb: 0,
        lowMidGainDb: 0,
        midGainDb: 0,
        highMidGainDb: 0,
        highGainDb: 0,
        bypassed: false,
      },
      auxSends: [...EMPTY_AUX_SENDS] as AuxSendsTuple,
      solo: false,
      mute: false,
      volumeDb: -3,
      source:
        i === 0
          ? 'kick_groove'
          : i === 2
            ? 'bass_synth'
            : i === 4
              ? 'epiano_chord'
              : 'none',
    };
  });

  // Preload realistic demo inserts on the first active stereo input pairs (0, 2, 4)
  inputs[0].name = 'Kick / Drums';
  inputs[0].inserts[0] = {
    slotIndex: 0,
    plugin: PLUGIN_CATALOG[0], // AUDynamicsProcessor (AU)
    bypassed: false,
    params: { ...PLUGIN_CATALOG[0].defaultParams },
  };
  inputs[0].eq.lowGainDb = 2.5;
  inputs[0].eq.highGainDb = 1.5;

  inputs[2].name = 'Basse Synth';
  inputs[2].inserts[0] = {
    slotIndex: 0,
    plugin: PLUGIN_CATALOG[2], // AUFilter HPF
    bypassed: false,
    params: { ...PLUGIN_CATALOG[2].defaultParams, freq: 38 },
  };
  inputs[2].inserts[1] = {
    slotIndex: 1,
    plugin: PLUGIN_CATALOG[1], // ConsoleDrive Tube (VST3)
    bypassed: false,
    params: { ...PLUGIN_CATALOG[1].defaultParams },
  };

  inputs[4].name = 'E-Piano';
  inputs[4].auxSends = [30, 0, 15, 0, 0, 0, 0, 0];
  inputs[4].inserts[0] = {
    slotIndex: 0,
    plugin: PLUGIN_CATALOG[3], // Dimension Ensemble (VST3)
    bypassed: false,
    params: { ...PLUGIN_CATALOG[3].defaultParams },
  };

  const auxStrips: StripState[] = Array.from({ length: NUM_AUX_BUSES }, (_, idx) => {
    const pairIdx = Math.floor(idx / 2);
    const isPrimary = idx % 2 === 0;
    const outputRoute: HardwareOutputRoute = isPrimary
      ? { kind: 'stereo', channel: pairIdx * 2 }
      : { kind: 'mono', channel: idx };
    return {
      id: `aux-${idx + 1}`,
      index: NUM_INPUT_STRIPS + idx,
      kind: 'aux',
      name: isPrimary ? `Aux ${pairIdx * 2 + 1}/${pairIdx * 2 + 2}` : `Aux ${idx + 1}`,
      hardwareChannelLabel: formatOutputRouteLabel(outputRoute),
      inputRoute: { kind: 'none' },
      outputRoute,
      gainDb: 0,
      midiDevice: 'none',
      midiChannel: null,
      inserts: createEmptyInserts(),
      eq: {
        lowGainDb: 0,
        lowMidGainDb: 0,
        midGainDb: 0,
        highMidGainDb: 0,
        highGainDb: 0,
        bypassed: false,
      },
      auxSends: [...EMPTY_AUX_SENDS] as AuxSendsTuple,
      solo: false,
      mute: false,
      volumeDb: 0,
      source: 'none',
    };
  });

  auxStrips[0].inserts[0] = {
    slotIndex: 0,
    plugin: PLUGIN_CATALOG[5], // AUMatrixReverb Hall (AU)
    bypassed: false,
    params: { ...PLUGIN_CATALOG[5].defaultParams },
  };

  const masterOut: HardwareOutputRoute = { kind: 'stereo', channel: 0 };
  const master: StripState = {
    id: 'master',
    index: NUM_INPUT_STRIPS + NUM_AUX_BUSES,
    kind: 'master',
    name: 'Master',
    hardwareChannelLabel: formatOutputRouteLabel(masterOut),
    inputRoute: { kind: 'none' },
    outputRoute: masterOut,
    gainDb: 0,
    midiDevice: 'none',
    midiChannel: null,
    inserts: createEmptyInserts(),
    eq: {
      lowGainDb: 0,
      lowMidGainDb: 0,
      midGainDb: 0,
      highMidGainDb: 0,
      highGainDb: 0,
      bypassed: false,
    },
    auxSends: [...EMPTY_AUX_SENDS] as AuxSendsTuple,
    solo: false,
    mute: false,
    volumeDb: 0,
    source: 'none',
  };
  master.inserts[0] = {
    slotIndex: 0,
    plugin: PLUGIN_CATALOG[6], // L1 Master Limiter (VST3)
    bypassed: false,
    params: { ...PLUGIN_CATALOG[6].defaultParams },
  };

  return [...inputs, ...auxStrips, master];
}

function normalizeLoadedSnapshot(raw: unknown): {
  strips: StripState[];
  inputPairStereo: InputPairStereoState;
  auxPairStereo: AuxPairStereoState;
  bufferFrames?: AudioBufferLatencyPreset;
  playerLoop?: boolean;
  playerGain?: number;
  playerTargetStripId?: string | null;
} | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Partial<MixerSetSnapshot>;
  if (!Array.isArray(obj.strips) || obj.strips.length === 0) return null;

  const base = createInitialStrips();
  const baseById = new Map(base.map((s) => [s.id, s]));

  const loadedInputCount = obj.strips.filter((s) => s?.kind === 'input').length;
  const isLegacyV1V2 = (obj.version ?? 1) < 3 && !Array.isArray(obj.inputPairStereo) && loadedInputCount <= 8;
  const inputPairStereo: InputPairStereoState = isLegacyV1V2
    ? [false, false, false, false, true, true, true, true]
    : ([...DEFAULT_INPUT_PAIRS] as InputPairStereoState);

  if (Array.isArray(obj.inputPairStereo)) {
    for (let i = 0; i < MAX_INPUT_PAIRS; i++) {
      if (typeof obj.inputPairStereo[i] === 'boolean') {
        inputPairStereo[i] = obj.inputPairStereo[i];
      }
    }
  }

  const auxPairStereo: AuxPairStereoState = [...DEFAULT_AUX_PAIRS] as AuxPairStereoState;
  if (Array.isArray(obj.auxPairStereo)) {
    for (let i = 0; i < MAX_AUX_PAIRS; i++) {
      if (typeof obj.auxPairStereo[i] === 'boolean') {
        auxPairStereo[i] = obj.auxPairStereo[i];
      }
    }
  }

  for (const loaded of obj.strips) {
    if (!loaded || typeof loaded !== 'object' || typeof loaded.id !== 'string') continue;
    const target = baseById.get(loaded.id);
    if (!target) continue;

    const eqRaw = loaded.eq as Partial<StripState['eq']> | undefined;
    const rawAux = Array.isArray(loaded.auxSends) ? loaded.auxSends : [];
    const normalizedAux: AuxSendsTuple = [...EMPTY_AUX_SENDS] as AuxSendsTuple;
    if (rawAux.length === 4) {
      normalizedAux[0] = Number(rawAux[0]) || 0;
      normalizedAux[2] = Number(rawAux[1]) || 0;
      normalizedAux[4] = Number(rawAux[2]) || 0;
      normalizedAux[6] = Number(rawAux[3]) || 0;
    } else {
      for (let k = 0; k < NUM_AUX_BUSES; k++) {
        normalizedAux[k] = Number(rawAux[k]) || 0;
      }
    }

    const normalizedInserts = createEmptyInserts();
    if (Array.isArray(loaded.inserts)) {
      for (let slotIdx = 0; slotIdx < MAX_INSERTS_PER_STRIP; slotIdx++) {
        const srcSlot = loaded.inserts[slotIdx];
        if (!srcSlot) continue;
        const catalogPlugin = srcSlot.plugin
          ? PLUGIN_CATALOG.find((p) => p.id === srcSlot.plugin?.id) ?? srcSlot.plugin
          : null;
        normalizedInserts[slotIdx] = {
          slotIndex: slotIdx,
          plugin: catalogPlugin,
          bypassed: Boolean(srcSlot.bypassed),
          params:
            srcSlot.params && typeof srcSlot.params === 'object'
              ? { ...srcSlot.params }
              : catalogPlugin
                ? { ...catalogPlugin.defaultParams }
                : {},
        };
      }
    }

    const rawOutRoute = loaded.outputRoute ?? target.outputRoute;
    const outputRoute =
      isLegacyV1V2 && target.kind === 'input' && rawOutRoute.kind === 'none'
        ? ({ kind: 'master' } as HardwareOutputRoute)
        : rawOutRoute;

    const merged: StripState = {
      ...target,
      name: typeof loaded.name === 'string' && loaded.name.trim() ? loaded.name : target.name,
      hardwareChannelLabel:
        typeof loaded.hardwareChannelLabel === 'string'
          ? loaded.hardwareChannelLabel
          : target.hardwareChannelLabel,
      inputRoute: loaded.inputRoute ?? target.inputRoute,
      outputRoute,
      gainDb: typeof loaded.gainDb === 'number' ? loaded.gainDb : target.gainDb,
      midiDevice:
        target.kind === 'input'
          ? typeof loaded.midiDevice === 'string'
            ? loaded.midiDevice
            : target.midiDevice
          : 'none',
      midiChannel:
        target.kind === 'input'
          ? loaded.midiChannel === null
            ? null
            : typeof loaded.midiChannel === 'number' &&
                loaded.midiChannel >= 0 &&
                loaded.midiChannel <= 16
              ? loaded.midiChannel
              : target.midiChannel
          : null,
      inserts: normalizedInserts,
      eq: {
        lowGainDb: eqRaw?.lowGainDb ?? 0,
        lowMidGainDb: eqRaw?.lowMidGainDb ?? 0,
        midGainDb: eqRaw?.midGainDb ?? 0,
        highMidGainDb: eqRaw?.highMidGainDb ?? 0,
        highGainDb: eqRaw?.highGainDb ?? 0,
        bypassed: Boolean(eqRaw?.bypassed),
      },
      auxSends: normalizedAux,
      solo: Boolean(loaded.solo),
      mute: Boolean(loaded.mute),
      volumeDb: typeof loaded.volumeDb === 'number' ? loaded.volumeDb : target.volumeDb,
      source: loaded.source ?? target.source,
    };
    baseById.set(target.id, merged);
  }

  const validBuf =
    typeof obj.bufferFrames === 'number' &&
    BUFFER_LATENCY_PRESETS.includes(obj.bufferFrames as AudioBufferLatencyPreset)
      ? (obj.bufferFrames as AudioBufferLatencyPreset)
      : undefined;

  return {
    strips: base.map((b) => baseById.get(b.id) ?? b),
    inputPairStereo,
    auxPairStereo,
    bufferFrames: validBuf,
    playerLoop: typeof obj.playerLoop === 'boolean' ? obj.playerLoop : undefined,
    playerGain: typeof obj.playerGain === 'number' ? obj.playerGain : undefined,
    playerTargetStripId:
      obj.playerTargetStripId !== undefined ? obj.playerTargetStripId : undefined,
  };
}

function formatDuration(secs: number): string {
  const safe = Math.max(0, Math.floor(secs));
  const mins = Math.floor(safe / 60);
  const rem = safe % 60;
  return `${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

const EMPTY_METER: MeterLevel = {
  peakDbL: -60,
  peakDbR: -60,
  rmsDbL: -60,
  rmsDbR: -60,
  clip: false,
};

const EMPTY_PLAYER_STATUS: PlayerStatus = {
  title: null,
  playing: false,
  posSecs: 0,
  durationSecs: 0,
};

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('console');
  const [driverProfile, setDriverProfile] = useState<OsDriverProfile>('macos_coreaudio');
  const [hardwareProfile, setHardwareProfile] = useState<HardwareProfileId>('umc1820');
  const [strips, setStrips] = useState<StripState[]>(createInitialStrips);
  const [inputPairStereo, setInputPairStereo] = useState<InputPairStereoState>(
    () => [...DEFAULT_INPUT_PAIRS] as InputPairStereoState
  );
  const [auxPairStereo, setAuxPairStereo] = useState<AuxPairStereoState>(
    () => [...DEFAULT_AUX_PAIRS] as AuxPairStereoState
  );
  const [bufferFrames, setBufferFrames] = useState<AudioBufferLatencyPreset>(128);
  const [engineRunning, setEngineRunning] = useState(false);
  const [sampleRate, setSampleRate] = useState(48000);
  const [meters, setMeters] = useState<Record<string, MeterLevel>>({});
  const [insertTarget, setInsertTarget] = useState<{ stripId: string; slotIndex: number } | null>(
    null
  );
  const [uiScaleMode, setUiScaleMode] = useState<'auto' | number>('auto');
  const [autoScale, setAutoScale] = useState<number>(1);
  const [frameBoxSize, setFrameBoxSize] = useState<{ width: number | null; height: number | null }>({
    width: null,
    height: null,
  });
  const consoleViewportRef = useRef<HTMLDivElement | null>(null);
  const [stripView, setStripView] = useState<StripViewFilter>('all');
  const [inputBank, setInputBank] = useState<InputBankFilter>('all');

  // Set Save / Load feedback
  const [setNotice, setSetNotice] = useState<string | null>(null);
  const setFileInputRef = useRef<HTMLInputElement | null>(null);

  // Audio File Player (MP3 / WAV) state
  const audioFileInputRef = useRef<HTMLInputElement | null>(null);
  const [playerStatus, setPlayerStatus] = useState<PlayerStatus>(EMPTY_PLAYER_STATUS);
  const [playerLoop, setPlayerLoop] = useState(false);
  const [playerGain, setPlayerGain] = useState(1.0);
  const [playerTargetStripId, setPlayerTargetStripId] = useState<string | null>(null);
  const [showPlayerBar, setShowPlayerBar] = useState(true);

  // Top Workspace Dropdown Menus
  const [openMenu, setOpenMenu] = useState<'fichier' | 'audio' | 'midi' | 'affichage' | null>(null);
  const menuBarRef = useRef<HTMLDivElement | null>(null);

  // Web MIDI + Remote MIDI state
  const [midiEnabled, setMidiEnabled] = useState(true);
  const [midiSupported, setMidiSupported] = useState(
    () => typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator
  );
  const [midiPorts, setMidiPorts] = useState<MidiPortInfo[]>([]);
  const [remoteMidiPortNames, setRemoteMidiPortNames] = useState<string[]>([]);
  const midiAccessRef = useRef<MIDIAccess | null>(null);
  const latestMidiStateRef = useRef({ strips, inputPairStereo, midiEnabled });

  // Remote WebSocket client state (to connect directly to Mac Rust app)
  const [wsAddress, setWsAddress] = useState('ws://192.168.1.42:8080/ws');
  const [wsStatus, setWsStatus] = useState<RemoteWsStatus>('disconnected');
  const [wsError, setWsError] = useState<string | null>(null);
  const [remoteDeviceName, setRemoteDeviceName] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const engineRef = useRef<WebAudioMixerEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = new WebAudioMixerEngine();
  }

  const sendRemoteCmd = useCallback((payload: Record<string, unknown>) => {
    const sock = wsRef.current;
    if (sock && sock.readyState === WebSocket.OPEN) {
      sock.send(JSON.stringify(payload));
    }
  }, []);

  const disconnectRemoteWs = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.close();
      wsRef.current = null;
    }
    setWsStatus('disconnected');
    setRemoteDeviceName(null);
  }, []);

  const connectRemoteWs = useCallback(() => {
    disconnectRemoteWs();
    setWsError(null);
    setWsStatus('connecting');
    try {
      const sock = new WebSocket(wsAddress.trim());
      wsRef.current = sock;
      sock.onopen = () => {
        setWsStatus('connected');
        setWsError(null);
        sock.send(JSON.stringify({ type: 'request_state' }));
      };
      sock.onerror = () => {
        setWsStatus('error');
        setWsError(
          window.location.protocol === 'https:'
            ? 'Connexion ws:// bloquée depuis HTTPS. Ouvrez directement http://<IP-du-Mac>:8080 sur Safari iPad.'
            : 'Impossible de joindre le serveur WebSocket du Mac.'
        );
      };
      sock.onclose = () => {
        if (wsRef.current === sock) {
          wsRef.current = null;
          setWsStatus((prev) => (prev === 'error' ? 'error' : 'disconnected'));
        }
      };
      sock.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data));
          if (msg.type === 'state' && Array.isArray(msg.strips)) {
            setRemoteDeviceName(typeof msg.device === 'string' ? msg.device : 'Mac');
            if (
              Array.isArray(msg.input_pair_stereo) &&
              msg.input_pair_stereo.length === MAX_INPUT_PAIRS
            ) {
              setInputPairStereo(msg.input_pair_stereo as InputPairStereoState);
            }
            if (Array.isArray(msg.aux_pair_stereo) && msg.aux_pair_stereo.length === MAX_AUX_PAIRS) {
              setAuxPairStereo(msg.aux_pair_stereo as AuxPairStereoState);
            }
            if (
              typeof msg.buffer_frames === 'number' &&
              BUFFER_LATENCY_PRESETS.includes(msg.buffer_frames as AudioBufferLatencyPreset)
            ) {
              setBufferFrames(msg.buffer_frames as AudioBufferLatencyPreset);
            }
              if (Array.isArray(msg.midi_ports)) {
                setRemoteMidiPortNames(
                  msg.midi_ports.filter((p: unknown): p is string => typeof p === 'string')
                );
              }
              setStrips((prev) =>
              prev.map((localStrip, idx) => {
                const remote = msg.strips[idx];
                if (!remote) return localStrip;
                let inputRoute: HardwareInputRoute = localStrip.inputRoute;
                if (remote.input_route === 'None') inputRoute = { kind: 'none' };
                else if (remote.input_route?.Mono !== undefined)
                  inputRoute = { kind: 'mono', channel: remote.input_route.Mono };
                else if (remote.input_route?.StereoPair !== undefined)
                  inputRoute = { kind: 'stereo', channel: remote.input_route.StereoPair };

                let outputRoute: HardwareOutputRoute = localStrip.outputRoute;
                if (remote.output_route === 'None') outputRoute = { kind: 'none' };
                else if (remote.output_route === 'MasterBus') outputRoute = { kind: 'master' };
                else if (remote.output_route?.Mono !== undefined)
                  outputRoute = { kind: 'mono', channel: remote.output_route.Mono };
                else if (remote.output_route?.StereoPair !== undefined)
                  outputRoute = { kind: 'stereo', channel: remote.output_route.StereoPair };

                const auxSends: AuxSendsTuple = [...EMPTY_AUX_SENDS] as AuxSendsTuple;
                if (Array.isArray(remote.aux_sends)) {
                  for (let a = 0; a < NUM_AUX_BUSES; a++) {
                    auxSends[a] = Math.round((Number(remote.aux_sends[a]) || 0) * 100);
                  }
                }

                let midiDevice = localStrip.kind === 'input' ? localStrip.midiDevice : 'none';
                let midiChannel = localStrip.kind === 'input' ? localStrip.midiChannel : null;
                if (localStrip.kind === 'input') {
                  if (remote.midi_device === 'All') midiDevice = 'all';
                  else if (remote.midi_device === 'None') midiDevice = 'none';
                  else if (remote.midi_device?.Port !== undefined)
                    midiDevice = String(remote.midi_device.Port);

                  if (remote.midi_mode === null) midiChannel = null;
                  else if (typeof remote.midi_mode === 'number') midiChannel = remote.midi_mode;
                }

                return {
                  ...localStrip,
                  name: typeof remote.name === 'string' ? remote.name : localStrip.name,
                  inputRoute,
                  outputRoute,
                  hardwareChannelLabel:
                    localStrip.kind === 'input'
                      ? formatInputRouteLabel(inputRoute)
                      : formatOutputRouteLabel(outputRoute),
                  gainDb: typeof remote.gain_db === 'number' ? remote.gain_db : localStrip.gainDb,
                  midiDevice,
                  midiChannel,
                  solo: Boolean(remote.solo),
                  mute: Boolean(remote.mute),
                  volumeDb:
                    typeof remote.volume_db === 'number' ? remote.volume_db : localStrip.volumeDb,
                  eq: {
                    lowGainDb: remote.eq?.low_db ?? localStrip.eq.lowGainDb,
                    lowMidGainDb: remote.eq?.low_mid_db ?? localStrip.eq.lowMidGainDb,
                    midGainDb: remote.eq?.mid_db ?? localStrip.eq.midGainDb,
                    highMidGainDb: remote.eq?.high_mid_db ?? localStrip.eq.highMidGainDb,
                    highGainDb: remote.eq?.high_db ?? localStrip.eq.highGainDb,
                    bypassed: Boolean(remote.eq?.bypassed),
                  },
                  auxSends,
                };
              })
            );
            if (msg.player) {
              setPlayerLoop(Boolean(msg.player.loop_enabled));
              if (typeof msg.player.gain === 'number') setPlayerGain(msg.player.gain);
              setPlayerTargetStripId(
                typeof msg.player.target === 'number' ? `in-${msg.player.target + 1}` : null
              );
              setPlayerStatus({
                title: msg.player.title ?? null,
                playing: Boolean(msg.player.playing),
                posSecs: Number(msg.player.pos_secs) || 0,
                durationSecs: Number(msg.player.duration_secs) || 0,
              });
            }
          } else if (msg.type === 'meters' && Array.isArray(msg.meters)) {
            setMeters((prev) => {
              const next: Record<string, MeterLevel> = { ...prev };
              msg.meters.forEach(
                (m: { pl: number; pr: number; rl: number; rr: number; clip: boolean }, i: number) => {
                  const id =
                    i < NUM_INPUT_STRIPS
                      ? `in-${i + 1}`
                      : i < NUM_INPUT_STRIPS + NUM_AUX_BUSES
                        ? `aux-${i - NUM_INPUT_STRIPS + 1}`
                        : 'master';
                  next[id] = {
                    peakDbL: m.pl,
                    peakDbR: m.pr,
                    rmsDbL: m.rl,
                    rmsDbR: m.rr,
                    clip: Boolean(m.clip),
                  };
                }
              );
              return next;
            });
            if (msg.player) {
              setPlayerStatus((prev) => ({
                ...prev,
                playing: Boolean(msg.player.playing),
                posSecs: Number(msg.player.pos_secs) || 0,
                durationSecs: Number(msg.player.duration_secs) || 0,
              }));
            }
          }
        } catch {
          // ignore malformed remote frame
        }
      };
    } catch {
      setWsStatus('error');
      setWsError('URL WebSocket invalide.');
    }
  }, [disconnectRemoteWs, wsAddress]);

  useEffect(() => () => disconnectRemoteWs(), [disconnectRemoteWs]);

  // Keep latest strips/pairs for live Web MIDI message callbacks
  useEffect(() => {
    latestMidiStateRef.current = { strips, inputPairStereo, midiEnabled };
    if (!midiEnabled) {
      engineRef.current?.stopAllMidiVoices();
    }
  }, [strips, inputPairStereo, midiEnabled]);

  const bindMidiInputs = useCallback((access: MIDIAccess) => {
    const discovered: MidiPortInfo[] = [];
    for (const input of access.inputs.values()) {
      const portName = input.name?.trim() || `Port MIDI ${discovered.length + 1}`;
      discovered.push({ id: input.id, name: portName });
      input.onmidimessage = (event: MIDIMessageEvent) => {
        const snapshot = latestMidiStateRef.current;
        if (!snapshot.midiEnabled || !event.data) return;
        engineRef.current?.handleMidiMessage(
          event.data,
          portName,
          snapshot.strips,
          snapshot.inputPairStereo
        );
      };
    }
    setMidiPorts(discovered);
  }, []);

  const refreshMidiPorts = useCallback(async () => {
    if (typeof navigator === 'undefined' || !('requestMIDIAccess' in navigator)) {
      setMidiSupported(false);
      return;
    }
    try {
      const access = midiAccessRef.current ?? (await navigator.requestMIDIAccess({ sysex: false }));
      midiAccessRef.current = access;
      setMidiSupported(true);
      bindMidiInputs(access);
      access.onstatechange = () => {
        bindMidiInputs(access);
      };
    } catch {
      setMidiSupported(false);
    }
  }, [bindMidiInputs]);

  useEffect(() => {
    void refreshMidiPorts();
  }, [refreshMidiPorts]);

  // Close open top menu on outside click or Escape key
  useEffect(() => {
    if (!openMenu) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (menuBarRef.current && !menuBarRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenMenu(null);
    };
    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [openMenu]);

  // Sync mixer state into Web Audio DSP graph whenever parameters change
  useEffect(() => {
    if (engineRef.current && engineRunning) {
      engineRef.current.syncAll(strips, inputPairStereo, auxPairStereo);
    }
  }, [strips, inputPairStereo, auxPairStereo, engineRunning]);

  // 60fps real-time VU metering & player transport progress loop
  useEffect(() => {
    if (!engineRunning && !playerStatus.playing) {
      if (!engineRunning && wsStatus !== 'connected') setMeters({});
      return;
    }
    let rafId = 0;
    const tick = () => {
      if (engineRef.current) {
        if (engineRunning) {
          setMeters(engineRef.current.readMeters());
        }
        const status = engineRef.current.getPlayerStatus();
        setPlayerStatus(status);
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [engineRunning, playerStatus.playing, wsStatus]);

  const showTemporaryNotice = useCallback((msg: string) => {
    setSetNotice(msg);
    window.setTimeout(() => {
      setSetNotice((current) => (current === msg ? null : current));
    }, 3500);
  }, []);

  const handleToggleAudio = async () => {
    const engine = engineRef.current;
    if (!engine) return;
    if (engineRunning) {
      await engine.stop();
      setEngineRunning(false);
    } else {
      await engine.setBufferSize(bufferFrames, strips, inputPairStereo, auxPairStereo);
      await engine.start(strips, inputPairStereo, auxPairStereo);
      engine.setPlayerLoop(playerLoop);
      engine.setPlayerGain(playerGain);
      engine.setPlayerTarget(playerTargetStripId);
      setSampleRate(engine.getSampleRate());
      setEngineRunning(true);
    }
  };

  const handleUpdateStrip = (stripId: string, updater: (prev: StripState) => StripState) => {
    setStrips((prev) =>
      prev.map((s) => {
        if (s.id !== stripId) return s;
        const next = updater(s);
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          const idx = next.index;
          if (next.volumeDb !== s.volumeDb) {
            sendRemoteCmd({ type: 'set_volume', strip: idx, volume_db: next.volumeDb });
          }
          if (next.gainDb !== s.gainDb) {
            sendRemoteCmd({ type: 'set_gain', strip: idx, gain_db: next.gainDb });
          }
          if (next.mute !== s.mute) {
            sendRemoteCmd({ type: 'set_mute', strip: idx, mute: next.mute });
          }
          if (next.solo !== s.solo) {
            sendRemoteCmd({ type: 'set_solo', strip: idx, solo: next.solo });
          }
          if (next.eq.bypassed !== s.eq.bypassed) {
            sendRemoteCmd({ type: 'set_eq_bypass', strip: idx, bypassed: next.eq.bypassed });
          }
          if (next.eq.lowGainDb !== s.eq.lowGainDb) {
            sendRemoteCmd({ type: 'set_eq_band', strip: idx, band: 'low', value_db: next.eq.lowGainDb });
          }
          if (next.eq.lowMidGainDb !== s.eq.lowMidGainDb) {
            sendRemoteCmd({ type: 'set_eq_band', strip: idx, band: 'low_mid', value_db: next.eq.lowMidGainDb });
          }
          if (next.eq.midGainDb !== s.eq.midGainDb) {
            sendRemoteCmd({ type: 'set_eq_band', strip: idx, band: 'mid', value_db: next.eq.midGainDb });
          }
          if (next.eq.highMidGainDb !== s.eq.highMidGainDb) {
            sendRemoteCmd({ type: 'set_eq_band', strip: idx, band: 'high_mid', value_db: next.eq.highMidGainDb });
          }
          if (next.eq.highGainDb !== s.eq.highGainDb) {
            sendRemoteCmd({ type: 'set_eq_band', strip: idx, band: 'high', value_db: next.eq.highGainDb });
          }
          for (let a = 0; a < NUM_AUX_BUSES; a++) {
            if (next.auxSends[a] !== s.auxSends[a]) {
              sendRemoteCmd({
                type: 'set_aux_send',
                strip: idx,
                aux_idx: a,
                level: (next.auxSends[a] ?? 0) / 100,
              });
            }
          }
          if (JSON.stringify(next.inputRoute) !== JSON.stringify(s.inputRoute)) {
            sendRemoteCmd({
              type: 'set_input_route',
              strip: idx,
              kind: next.inputRoute.kind,
              channel: next.inputRoute.kind === 'none' ? 0 : next.inputRoute.channel,
            });
          }
          if (JSON.stringify(next.outputRoute) !== JSON.stringify(s.outputRoute)) {
            sendRemoteCmd({
              type: 'set_output_route',
              strip: idx,
              kind: next.outputRoute.kind,
              channel:
                next.outputRoute.kind === 'mono' || next.outputRoute.kind === 'stereo'
                  ? next.outputRoute.channel
                  : 0,
            });
          }
          if (next.kind === 'input') {
            if (next.midiDevice !== s.midiDevice) {
              sendRemoteCmd({
                type: 'set_strip_midi_device',
                strip: idx,
                device: next.midiDevice,
              });
            }
            if (next.midiChannel !== s.midiChannel) {
              sendRemoteCmd({
                type: 'set_strip_midi_mode',
                strip: idx,
                mode: next.midiChannel,
              });
            }
          }
        }
        return next;
      })
    );
  };

  const handleAssignAllInputMidiDevice = (device: string) => {
    setStrips((prev) =>
      prev.map((s) => {
        if (s.kind !== 'input') return s;
        sendRemoteCmd({ type: 'set_strip_midi_device', strip: s.index, device });
        return { ...s, midiDevice: device };
      })
    );
    showTemporaryNotice(
      device === 'all'
        ? 'MIDI : Tous les appareils sur les entrées'
        : device === 'none'
          ? 'MIDI coupé sur les entrées'
          : `MIDI entrées → ${device}`
    );
  };

  const handleToggleInputPair = (pairIndex: number) => {
    if (pairIndex < 0 || pairIndex >= MAX_INPUT_PAIRS) return;
    const nextIsStereo = !inputPairStereo[pairIndex];
    sendRemoteCmd({ type: 'set_input_pair_stereo', pair: pairIndex, stereo: nextIsStereo });
    setInputPairStereo((prev) => {
      const next = [...prev] as InputPairStereoState;
      next[pairIndex] = nextIsStereo;
      return next;
    });

    const primaryId = `in-${pairIndex * 2 + 1}`;
    const secondaryId = `in-${pairIndex * 2 + 2}`;
    const ch1 = pairIndex * 2 + 1;
    const ch2 = pairIndex * 2 + 2;

    setStrips((prev) =>
      prev.map((s) => {
        if (s.id === primaryId) {
          const nextRoute: HardwareInputRoute = nextIsStereo
            ? { kind: 'stereo', channel: pairIndex * 2 }
            : { kind: 'mono', channel: pairIndex * 2 };
          const nextName = nextIsStereo
            ? s.name === `IN ${ch1}`
              ? `IN ${ch1}/${ch2}`
              : s.name
            : s.name === `IN ${ch1}/${ch2}`
              ? `IN ${ch1}`
              : s.name;
          return {
            ...s,
            name: nextName,
            inputRoute: nextRoute,
            hardwareChannelLabel: formatInputRouteLabel(nextRoute),
          };
        }
        if (s.id === secondaryId && !nextIsStereo) {
          const nextRoute: HardwareInputRoute = { kind: 'mono', channel: pairIndex * 2 + 1 };
          return {
            ...s,
            inputRoute: nextRoute,
            hardwareChannelLabel: formatInputRouteLabel(nextRoute),
          };
        }
        return s;
      })
    );
  };

  const handleToggleAllInputsMode = () => {
    const anyMono = inputPairStereo.some((v) => !v);
    const targetStereo = anyMono;
    for (let p = 0; p < MAX_INPUT_PAIRS; p++) {
      sendRemoteCmd({ type: 'set_input_pair_stereo', pair: p, stereo: targetStereo });
    }
    setInputPairStereo(
      [targetStereo, targetStereo, targetStereo, targetStereo, targetStereo, targetStereo, targetStereo, targetStereo]
    );
    if (!targetStereo && inputBank === 'all') {
      setInputBank('b1');
    } else if (targetStereo) {
      setInputBank('all');
    }

    setStrips((prev) =>
      prev.map((s) => {
        if (s.kind !== 'input') return s;
        const idx = s.index;
        const pairIdx = Math.floor(idx / 2);
        const ch1 = pairIdx * 2 + 1;
        const ch2 = pairIdx * 2 + 2;
        if (idx % 2 === 0) {
          const nextRoute: HardwareInputRoute = targetStereo
            ? { kind: 'stereo', channel: pairIdx * 2 }
            : { kind: 'mono', channel: pairIdx * 2 };
          const nextName = targetStereo
            ? s.name === `IN ${ch1}`
              ? `IN ${ch1}/${ch2}`
              : s.name
            : s.name === `IN ${ch1}/${ch2}`
              ? `IN ${ch1}`
              : s.name;
          return {
            ...s,
            name: nextName,
            inputRoute: nextRoute,
            hardwareChannelLabel: formatInputRouteLabel(nextRoute),
          };
        } else if (!targetStereo) {
          const nextRoute: HardwareInputRoute = { kind: 'mono', channel: idx };
          return {
            ...s,
            inputRoute: nextRoute,
            hardwareChannelLabel: formatInputRouteLabel(nextRoute),
          };
        }
        return s;
      })
    );
  };

  const handleCycleInputBank = () => {
    setInputBank((prev) => (prev === 'all' ? 'b1' : prev === 'b1' ? 'b2' : 'all'));
  };

  const handleBufferSizeChange = async (nextFrames: AudioBufferLatencyPreset) => {
    setBufferFrames(nextFrames);
    if (engineRef.current && engineRunning) {
      await engineRef.current.setBufferSize(nextFrames, strips, inputPairStereo, auxPairStereo);
      setSampleRate(engineRef.current.getSampleRate());
    }
    const ms = ((nextFrames / Math.max(1, sampleRate)) * 1000).toFixed(1);
    showTemporaryNotice(`Buffer audio : ${nextFrames} smp (~${ms} ms)`);
  };

  const handleToggleAuxPair = (pairIndex: number) => {
    if (pairIndex < 0 || pairIndex >= MAX_AUX_PAIRS) return;
    const nextIsStereo = !auxPairStereo[pairIndex];
    sendRemoteCmd({ type: 'set_aux_pair_stereo', pair: pairIndex, stereo: nextIsStereo });
    setAuxPairStereo((prev) => {
      const next = [...prev] as AuxPairStereoState;
      next[pairIndex] = nextIsStereo;
      return next;
    });

    const primaryId = `aux-${pairIndex * 2 + 1}`;
    const secondaryId = `aux-${pairIndex * 2 + 2}`;
    const ch1 = pairIndex * 2 + 1;
    const ch2 = pairIndex * 2 + 2;

    setStrips((prev) =>
      prev.map((s) => {
        if (s.id === primaryId) {
          const nextRoute: HardwareOutputRoute = nextIsStereo
            ? { kind: 'stereo', channel: pairIndex * 2 }
            : { kind: 'mono', channel: pairIndex * 2 };
          const nextName = nextIsStereo
            ? s.name === `Aux ${ch1}`
              ? `Aux ${ch1}/${ch2}`
              : s.name
            : s.name === `Aux ${ch1}/${ch2}`
              ? `Aux ${ch1}`
              : s.name;
          return {
            ...s,
            name: nextName,
            outputRoute: s.outputRoute.kind === 'master' ? s.outputRoute : nextRoute,
            hardwareChannelLabel:
              s.outputRoute.kind === 'master'
                ? s.hardwareChannelLabel
                : formatOutputRouteLabel(nextRoute),
          };
        }
        if (s.id === secondaryId && !nextIsStereo) {
          const nextRoute: HardwareOutputRoute = { kind: 'mono', channel: pairIndex * 2 + 1 };
          return {
            ...s,
            outputRoute: s.outputRoute.kind === 'master' ? s.outputRoute : nextRoute,
            hardwareChannelLabel:
              s.outputRoute.kind === 'master'
                ? s.hardwareChannelLabel
                : formatOutputRouteLabel(nextRoute),
          };
        }
        return s;
      })
    );
  };

  const handleToggleAllAuxMode = () => {
    const anyMono = auxPairStereo.some((v) => !v);
    const targetStereo = anyMono;
    for (let p = 0; p < MAX_AUX_PAIRS; p++) {
      sendRemoteCmd({ type: 'set_aux_pair_stereo', pair: p, stereo: targetStereo });
    }
    setAuxPairStereo([targetStereo, targetStereo, targetStereo, targetStereo]);
    setStrips((prev) =>
      prev.map((s) => {
        if (s.kind !== 'aux') return s;
        const idx = s.index - NUM_INPUT_STRIPS;
        const pairIdx = Math.floor(idx / 2);
        const ch1 = pairIdx * 2 + 1;
        const ch2 = pairIdx * 2 + 2;
        if (idx % 2 === 0) {
          const nextRoute: HardwareOutputRoute = targetStereo
            ? { kind: 'stereo', channel: pairIdx * 2 }
            : { kind: 'mono', channel: pairIdx * 2 };
          const nextName = targetStereo
            ? s.name === `Aux ${ch1}`
              ? `Aux ${ch1}/${ch2}`
              : s.name
            : s.name === `Aux ${ch1}/${ch2}`
              ? `Aux ${ch1}`
              : s.name;
          return {
            ...s,
            name: nextName,
            outputRoute: s.outputRoute.kind === 'master' ? s.outputRoute : nextRoute,
            hardwareChannelLabel:
              s.outputRoute.kind === 'master'
                ? s.hardwareChannelLabel
                : formatOutputRouteLabel(nextRoute),
          };
        } else if (!targetStereo) {
          const nextRoute: HardwareOutputRoute = { kind: 'mono', channel: idx };
          return {
            ...s,
            outputRoute: s.outputRoute.kind === 'master' ? s.outputRoute : nextRoute,
            hardwareChannelLabel:
              s.outputRoute.kind === 'master'
                ? s.hardwareChannelLabel
                : formatOutputRouteLabel(nextRoute),
          };
        }
        return s;
      })
    );
  };

  const handleSaveSet = () => {
    const snapshot: MixerSetSnapshot = {
      version: 3,
      inputPairStereo,
      auxPairStereo,
      bufferFrames,
      strips,
      playerLoop,
      playerGain,
      playerTargetStripId,
    };
    const json = JSON.stringify(snapshot, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'studio-mixer-set.umcset.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showTemporaryNotice('Set sauvegardé (.umcset.json)');
  };

  const handleLoadSetFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const normalized = normalizeLoadedSnapshot(parsed);
      if (!normalized) {
        showTemporaryNotice('Format de set non reconnu');
        return;
      }
      setStrips(normalized.strips);
      setInputPairStereo(normalized.inputPairStereo);
      setAuxPairStereo(normalized.auxPairStereo);
      if (normalized.bufferFrames !== undefined) {
        setBufferFrames(normalized.bufferFrames);
        if (engineRef.current && engineRunning) {
          await engineRef.current.setBufferSize(
            normalized.bufferFrames,
            normalized.strips,
            normalized.inputPairStereo,
            normalized.auxPairStereo
          );
          setSampleRate(engineRef.current.getSampleRate());
        }
      }
      if (normalized.playerLoop !== undefined) {
        setPlayerLoop(normalized.playerLoop);
        engineRef.current?.setPlayerLoop(normalized.playerLoop);
      }
      if (normalized.playerGain !== undefined) {
        setPlayerGain(normalized.playerGain);
        engineRef.current?.setPlayerGain(normalized.playerGain);
      }
      if (normalized.playerTargetStripId !== undefined) {
        setPlayerTargetStripId(normalized.playerTargetStripId);
        engineRef.current?.setPlayerTarget(normalized.playerTargetStripId);
      }
      showTemporaryNotice(`Set chargé : ${file.name}`);
    } catch {
      showTemporaryNotice('Erreur de lecture du fichier set');
    }
  };

  const handleAudioFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !engineRef.current) return;
    try {
      await engineRef.current.setBufferSize(bufferFrames, strips, inputPairStereo, auxPairStereo);
      const status = await engineRef.current.loadAudioFile(file, strips);
      engineRef.current.syncAll(strips, inputPairStereo, auxPairStereo);
      engineRef.current.setPlayerLoop(playerLoop);
      engineRef.current.setPlayerGain(playerGain);
      engineRef.current.setPlayerTarget(playerTargetStripId);
      setSampleRate(engineRef.current.getSampleRate());
      setEngineRunning(true);
      setPlayerStatus(status);
      showTemporaryNotice(`Piste chargée : ${file.name}`);
    } catch {
      showTemporaryNotice('Impossible de décoder le fichier audio');
    }
  };

  const handleSelectPlugin = (
    stripId: string,
    slotIndex: number,
    plugin: PluginDescriptor | null
  ) => {
    handleUpdateStrip(stripId, (s) => ({
      ...s,
      inserts: s.inserts.map((ins) =>
        ins.slotIndex === slotIndex
          ? {
              ...ins,
              plugin,
              bypassed: false,
              params: plugin ? { ...plugin.defaultParams } : {},
            }
          : ins
      ),
    }));
  };

  const handleUpdatePluginParam = (
    stripId: string,
    slotIndex: number,
    key: string,
    value: number
  ) => {
    handleUpdateStrip(stripId, (s) => ({
      ...s,
      inserts: s.inserts.map((ins) =>
        ins.slotIndex === slotIndex
          ? { ...ins, params: { ...ins.params, [key]: value } }
          : ins
      ),
    }));
  };

  const handleTogglePluginBypass = (stripId: string, slotIndex: number) => {
    handleUpdateStrip(stripId, (s) => ({
      ...s,
      inserts: s.inserts.map((ins) =>
        ins.slotIndex === slotIndex ? { ...ins, bypassed: !ins.bypassed } : ins
      ),
    }));
  };

  const handleResetPluginParams = (stripId: string, slotIndex: number) => {
    handleUpdateStrip(stripId, (s) => ({
      ...s,
      inserts: s.inserts.map((ins) =>
        ins.slotIndex === slotIndex && ins.plugin
          ? { ...ins, params: { ...ins.plugin.defaultParams } }
          : ins
      ),
    }));
  };

  const handleDownloadRustZip = () => {
    const blob = buildZipArchive(
      RUST_PROJECT_FILES.map((f) => ({
        path: `umc1820-studio-mixer/${f.path}`,
        content: f.content,
      }))
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'umc1820-studio-mixer-rust.zip';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const anySoloActive = useMemo(
    () => strips.some((s) => s.kind !== 'master' && s.solo),
    [strips]
  );

  const inputStrips = useMemo(() => strips.filter((s) => s.kind === 'input'), [strips]);
  const auxStrips = useMemo(() => strips.filter((s) => s.kind === 'aux'), [strips]);
  const masterStrip = useMemo(() => strips.find((s) => s.kind === 'master'), [strips]);

  const activeInputStrips = useMemo(() => {
    const visible: StripState[] = [];
    for (let p = 0; p < MAX_INPUT_PAIRS; p++) {
      const primary = inputStrips[p * 2];
      const secondary = inputStrips[p * 2 + 1];
      if (primary) visible.push(primary);
      if (!inputPairStereo[p] && secondary) visible.push(secondary);
    }
    return visible;
  }, [inputStrips, inputPairStereo]);

  const visibleInputStrips = useMemo(() => {
    if (inputBank === 'b1') return activeInputStrips.filter((s) => s.index < 8);
    if (inputBank === 'b2') return activeInputStrips.filter((s) => s.index >= 8);
    return activeInputStrips;
  }, [activeInputStrips, inputBank]);

  const visibleAuxStrips = useMemo(() => {
    const visible: StripState[] = [];
    for (let p = 0; p < MAX_AUX_PAIRS; p++) {
      const primary = auxStrips[p * 2];
      const secondary = auxStrips[p * 2 + 1];
      if (primary) visible.push(primary);
      if (!auxPairStereo[p] && secondary) visible.push(secondary);
    }
    return visible;
  }, [auxStrips, auxPairStereo]);

  const activeModalStrip = insertTarget
    ? strips.find((s) => s.id === insertTarget.stripId) ?? null
    : null;

  const activeHwCaps = HARDWARE_PROFILES[hardwareProfile];
  const anyInputMono = inputPairStereo.some((v) => !v);
  const anyAuxMono = auxPairStereo.some((v) => !v);
  const visibleStripCount =
    (stripView === 'buses' ? 0 : visibleInputStrips.length) +
    (stripView === 'inputs' ? 0 : visibleAuxStrips.length + 1);

  useEffect(() => {
    const el = consoleViewportRef.current;
    if (!el || activeTab !== 'console') return;
    const recomputeScale = (width: number, height: number) => {
      if (width <= 0) return;
      const targetContentW = Math.max(480, visibleStripCount * 146 + 40);
      const scaleW = width / targetContentW;
      const scaleH = height > 0 ? height / 760 : 1;
      const next = Math.max(0.45, Math.min(1.08, Math.min(scaleW, Math.max(scaleH, 0.55))));
      setAutoScale(Math.round(next * 100) / 100);
    };
    const rect = el.getBoundingClientRect();
    recomputeScale(rect.width, rect.height);
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        recomputeScale(entry.contentRect.width, entry.contentRect.height);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [activeTab, visibleStripCount, frameBoxSize.width, frameBoxSize.height]);

  const handleStartCornerResize = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = consoleViewportRef.current;
    if (!el) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const rect = el.getBoundingClientRect();
    const startW = rect.width;
    const startH = rect.height;

    const onMove = (moveEvent: PointerEvent) => {
      const nextW = Math.max(360, Math.round(startW + (moveEvent.clientX - startX)));
      const nextH = Math.max(320, Math.round(startH + (moveEvent.clientY - startY)));
      setFrameBoxSize({ width: nextW, height: nextH });
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const effectiveMidiPorts = useMemo<MidiPortInfo[]>(() => {
    const merged = new Map<string, MidiPortInfo>();
    for (const p of midiPorts) {
      merged.set(p.name, p);
    }
    if (wsStatus === 'connected') {
      for (const name of remoteMidiPortNames) {
        if (!merged.has(name)) {
          merged.set(name, { id: `remote-${name}`, name });
        }
      }
    }
    return Array.from(merged.values());
  }, [midiPorts, remoteMidiPortNames, wsStatus]);

  const effectiveUiScale = uiScaleMode === 'auto' ? autoScale : uiScaleMode;
  const totalVisibleCount = activeInputStrips.length + visibleAuxStrips.length + 1;
  const bufferLatencyMs = ((bufferFrames / Math.max(1, sampleRate)) * 1000).toFixed(1);

  return (
    <div className="min-h-screen flex flex-col bg-[#0B0E14] text-slate-100">
      {/* Hidden file inputs for Set loading & MP3/WAV loading */}
      <input
        ref={setFileInputRef}
        type="file"
        accept=".json,.umcset,.umcset.json,application/json"
        className="hidden"
        onChange={handleLoadSetFile}
      />
      <input
        ref={audioFileInputRef}
        type="file"
        accept=".mp3,.wav,audio/mpeg,audio/wav"
        className="hidden"
        onChange={handleAudioFileSelected}
      />

      {/* 3-Zone Top Bar */}
      <header className="flex items-center justify-between gap-6 px-6 py-3 border-b border-[#232936] bg-[#0E121A] flex-wrap">
        <a
          href="#console"
          onClick={(e) => {
            e.preventDefault();
            setActiveTab('console');
          }}
          className="text-base font-bold tracking-tight text-slate-100 whitespace-nowrap shrink-0"
        >
          UMC1820 Studio Mixer
        </a>

        <nav className="flex items-center gap-6 text-sm font-medium" aria-label="Navigation principale">
          <button
            type="button"
            onClick={() => setActiveTab('console')}
            className={`whitespace-nowrap shrink-0 cursor-pointer transition-colors pb-0.5 border-b-2 ${
              activeTab === 'console'
                ? 'text-white border-amber-400'
                : 'text-slate-400 border-transparent hover:text-slate-200'
            }`}
          >
            Console de mixage
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('routing')}
            className={`whitespace-nowrap shrink-0 cursor-pointer transition-colors pb-0.5 border-b-2 ${
              activeTab === 'routing'
                ? 'text-white border-amber-400'
                : 'text-slate-400 border-transparent hover:text-slate-200'
            }`}
          >
            Matrice Aux &amp; CoreAudio
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('remote')}
            className={`flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors pb-0.5 border-b-2 ${
              activeTab === 'remote'
                ? 'text-white border-amber-400'
                : 'text-slate-400 border-transparent hover:text-slate-200'
            }`}
          >
            <span>Télécommande iPad</span>
            {wsStatus === 'connected' && (
              <span className="w-2 h-2 rounded-full bg-emerald-400" aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('rust')}
            className={`whitespace-nowrap shrink-0 cursor-pointer transition-colors pb-0.5 border-b-2 ${
              activeTab === 'rust'
                ? 'text-white border-amber-400'
                : 'text-slate-400 border-transparent hover:text-slate-200'
            }`}
          >
            Code Rust (egui)
          </button>
        </nav>

        <div className="flex items-center gap-3 shrink-0">
          {setNotice && (
            <span className="text-xs font-mono text-emerald-300 whitespace-nowrap">
              {setNotice}
            </span>
          )}
          <button
            type="button"
            onClick={handleDownloadRustZip}
            className="flex items-center gap-2 px-3.5 py-1.5 text-xs font-semibold bg-amber-400 text-slate-950 rounded hover:bg-amber-300 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            Télécharger Rust (.zip)
          </button>
        </div>
      </header>

      {/* Clean Menu Bar (Fichier, Audio, MIDI, Affichage + essential quick controls) */}
      <div
        ref={menuBarRef}
        className="relative z-30 flex items-center justify-between gap-4 px-6 py-2 border-b border-[#232936] bg-[#11151E]"
      >
        <div className="flex items-center gap-1.5 flex-wrap">
          {/* Menu Fichier */}
          <div className="relative">
            <button
              type="button"
              aria-expanded={openMenu === 'fichier'}
              onClick={() => setOpenMenu((m) => (m === 'fichier' ? null : 'fichier'))}
              className={`flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded border cursor-pointer whitespace-nowrap transition-colors ${
                openMenu === 'fichier'
                  ? 'bg-[#1D2432] text-white border-amber-400/60'
                  : 'bg-[#171C26] text-slate-200 border-[#283040] hover:border-slate-500'
              }`}
            >
              <span>Fichier</span>
              <ChevronDown className="w-3 h-3 text-slate-400" />
            </button>
            {openMenu === 'fichier' && (
              <div className="absolute left-0 top-full mt-1 w-60 rounded-md border border-[#2D3545] bg-[#141923] shadow-xl py-1.5 z-50 text-xs">
                <button
                  type="button"
                  onClick={() => {
                    setOpenMenu(null);
                    handleSaveSet();
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-slate-200 hover:bg-[#1E2636] cursor-pointer"
                >
                  <Save className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                  <span>Sauver Set (.umcset.json)</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setOpenMenu(null);
                    setFileInputRef.current?.click();
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-slate-200 hover:bg-[#1E2636] cursor-pointer"
                >
                  <FolderOpen className="w-3.5 h-3.5 text-amber-300 shrink-0" />
                  <span>Charger un Set...</span>
                </button>
                <div className="my-1 border-t border-[#232936]" />
                <button
                  type="button"
                  onClick={() => {
                    setOpenMenu(null);
                    audioFileInputRef.current?.click();
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-slate-200 hover:bg-[#1E2636] cursor-pointer"
                >
                  <Music className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                  <span>Ouvrir audio MP3 / WAV...</span>
                </button>
                <div className="my-1 border-t border-[#232936]" />
                <button
                  type="button"
                  onClick={() => {
                    setOpenMenu(null);
                    setStrips(createInitialStrips());
                    setInputPairStereo([...DEFAULT_INPUT_PAIRS] as InputPairStereoState);
                    setAuxPairStereo([...DEFAULT_AUX_PAIRS] as AuxPairStereoState);
                    setInputBank('all');
                    setFrameBoxSize({ width: null, height: null });
                    showTemporaryNotice('Console réinitialisée');
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-slate-300 hover:bg-[#1E2636] hover:text-white cursor-pointer"
                >
                  <RotateCcw className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                  <span>Réinitialiser la console</span>
                </button>
              </div>
            )}
          </div>

          {/* Menu Audio */}
          <div className="relative">
            <button
              type="button"
              aria-expanded={openMenu === 'audio'}
              onClick={() => setOpenMenu((m) => (m === 'audio' ? null : 'audio'))}
              className={`flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded border cursor-pointer whitespace-nowrap transition-colors ${
                openMenu === 'audio'
                  ? 'bg-[#1D2432] text-white border-sky-400/60'
                  : 'bg-[#171C26] text-slate-200 border-[#283040] hover:border-slate-500'
              }`}
            >
              <span>Audio</span>
              <ChevronDown className="w-3 h-3 text-slate-400" />
            </button>
            {openMenu === 'audio' && (
              <div className="absolute left-0 top-full mt-1 w-72 rounded-md border border-[#2D3545] bg-[#141923] shadow-xl py-1.5 z-50 text-xs max-h-[75vh] overflow-y-auto">
                <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  Carte son
                </div>
                {Object.entries(HARDWARE_PROFILES).map(([id, prof]) => {
                  const selected = hardwareProfile === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => {
                        setHardwareProfile(id as HardwareProfileId);
                        setOpenMenu(null);
                      }}
                      className="w-full flex items-center justify-between px-3 py-1.5 text-left text-slate-200 hover:bg-[#1E2636] cursor-pointer"
                    >
                      <span className="truncate">{prof.label}</span>
                      {selected && <Check className="w-3.5 h-3.5 text-amber-400 shrink-0" />}
                    </button>
                  );
                })}
                <div className="my-1 border-t border-[#232936]" />
                <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  Pilote OS
                </div>
                {(
                  [
                    ['macos_coreaudio', 'macOS · CoreAudio (AU / VST3 / VST2)'],
                    ['linux_alsa', 'Linux · ALSA / JACK (VST3 / VST2)'],
                  ] as [OsDriverProfile, string][]
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => {
                      setDriverProfile(id);
                      setOpenMenu(null);
                    }}
                    className="w-full flex items-center justify-between px-3 py-1.5 text-left text-slate-200 hover:bg-[#1E2636] cursor-pointer"
                  >
                    <span className="truncate">{label}</span>
                    {driverProfile === id && (
                      <Check className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                    )}
                  </button>
                ))}
                <div className="my-1 border-t border-[#232936]" />
                <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  Latence / Buffer carte son
                </div>
                <div className="grid grid-cols-2 gap-1 px-2.5 py-1">
                  {BUFFER_LATENCY_PRESETS.map((frames) => {
                    const ms = ((frames / Math.max(1, sampleRate)) * 1000).toFixed(1);
                    const active = bufferFrames === frames;
                    return (
                      <button
                        key={`buf-menu-${frames}`}
                        type="button"
                        onClick={() => {
                          void handleBufferSizeChange(frames);
                          setOpenMenu(null);
                        }}
                        className={`px-2 py-1 rounded border text-left font-mono text-[11px] cursor-pointer ${
                          active
                            ? 'bg-sky-500/20 border-sky-400/60 text-sky-200'
                            : 'bg-[#0E121B] border-[#232936] text-slate-300 hover:border-slate-500'
                        }`}
                      >
                        {frames} smp ({ms}ms)
                      </button>
                    );
                  })}
                </div>
                <div className="my-1 border-t border-[#232936]" />
                <button
                  type="button"
                  onClick={() => {
                    handleToggleAllInputsMode();
                    setOpenMenu(null);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-amber-200 hover:bg-[#1E2636] cursor-pointer"
                >
                  <Split className="w-3.5 h-3.5 shrink-0" />
                  <span>
                    {anyInputMono
                      ? `Entrées (${activeInputStrips.length} actifs → 8 Stéréo)`
                      : 'Entrées : 8 Stéréo → 16 Mono'}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    handleToggleAllAuxMode();
                    setOpenMenu(null);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-sky-200 hover:bg-[#1E2636] cursor-pointer"
                >
                  <Split className="w-3.5 h-3.5 shrink-0" />
                  <span>
                    {anyAuxMono
                      ? `Aux (${visibleAuxStrips.length} actifs → 4 Stéréo)`
                      : 'Aux : 4 Stéréo → 8 Mono'}
                  </span>
                </button>
              </div>
            )}
          </div>

          {/* Menu MIDI */}
          <div className="relative">
            <button
              type="button"
              aria-expanded={openMenu === 'midi'}
              onClick={() => setOpenMenu((m) => (m === 'midi' ? null : 'midi'))}
              className={`flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded border cursor-pointer whitespace-nowrap transition-colors ${
                openMenu === 'midi'
                  ? 'bg-[#1D2432] text-white border-emerald-400/60'
                  : 'bg-[#171C26] text-slate-200 border-[#283040] hover:border-slate-500'
              }`}
            >
              <span>MIDI</span>
              {effectiveMidiPorts.length > 0 && (
                <span className="font-mono text-[10px] text-emerald-400">
                  ({effectiveMidiPorts.length})
                </span>
              )}
              <ChevronDown className="w-3 h-3 text-slate-400" />
            </button>
            {openMenu === 'midi' && (
              <div className="absolute left-0 top-full mt-1 w-72 rounded-md border border-[#2D3545] bg-[#141923] shadow-xl py-1.5 z-50 text-xs max-h-[75vh] overflow-y-auto">
                <button
                  type="button"
                  onClick={() => setMidiEnabled((v) => !v)}
                  className="w-full flex items-center justify-between px-3 py-1.5 text-left text-slate-200 hover:bg-[#1E2636] cursor-pointer"
                >
                  <span>Activer l&apos;écoute MIDI</span>
                  <span
                    className={`font-mono text-[10px] ${
                      midiEnabled ? 'text-emerald-400' : 'text-slate-500'
                    }`}
                  >
                    {midiEnabled ? 'ON' : 'OFF'}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void refreshMidiPorts();
                    showTemporaryNotice('Ports MIDI rescannés');
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-slate-200 hover:bg-[#1E2636] cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                  <span>Rescanner les ports MIDI</span>
                </button>
                <div className="my-1 border-t border-[#232936]" />
                <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  Assigner à toutes les pistes d&apos;entrée
                </div>
                <button
                  type="button"
                  onClick={() => {
                    handleAssignAllInputMidiDevice('all');
                    setOpenMenu(null);
                  }}
                  className="w-full px-3 py-1.5 text-left text-slate-200 hover:bg-[#1E2636] cursor-pointer"
                >
                  Tous les appareils
                </button>
                <button
                  type="button"
                  onClick={() => {
                    handleAssignAllInputMidiDevice('none');
                    setOpenMenu(null);
                  }}
                  className="w-full px-3 py-1.5 text-left text-slate-300 hover:bg-[#1E2636] cursor-pointer"
                >
                  Aucun (Couper MIDI)
                </button>
                {effectiveMidiPorts.map((port) => (
                  <button
                    key={`assign-all-${port.id}`}
                    type="button"
                    onClick={() => {
                      handleAssignAllInputMidiDevice(port.name);
                      setOpenMenu(null);
                    }}
                    className="w-full px-3 py-1.5 text-left text-emerald-300 hover:bg-[#1E2636] cursor-pointer truncate"
                  >
                    {port.name}
                  </button>
                ))}
                <div className="my-1 border-t border-[#232936]" />
                <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  Appareils MIDI détectés
                </div>
                {effectiveMidiPorts.length === 0 ? (
                  <div className="px-3 py-1.5 text-[11px] text-slate-500">
                    {midiSupported
                      ? 'Aucun appareil MIDI connecté'
                      : 'Web MIDI indisponible dans ce navigateur (actif sur Mac Rust)'}
                  </div>
                ) : (
                  effectiveMidiPorts.map((port) => (
                    <div
                      key={`list-${port.id}`}
                      className="px-3 py-1 text-[11px] font-mono text-slate-300 truncate"
                    >
                      • {port.name}
                    </div>
                  ))
                )}
                <div className="mt-1 border-t border-[#232936] px-3 pt-1.5 pb-0.5 text-[10px] text-slate-400">
                  Chaque piste d&apos;entrée choisit son appareil MIDI en haut de tranche (aucun sur Aux / Master).
                </div>
              </div>
            )}
          </div>

          {/* Menu Affichage */}
          <div className="relative">
            <button
              type="button"
              aria-expanded={openMenu === 'affichage'}
              onClick={() => setOpenMenu((m) => (m === 'affichage' ? null : 'affichage'))}
              className={`flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded border cursor-pointer whitespace-nowrap transition-colors ${
                openMenu === 'affichage'
                  ? 'bg-[#1D2432] text-white border-amber-400/60'
                  : 'bg-[#171C26] text-slate-200 border-[#283040] hover:border-slate-500'
              }`}
            >
              <span>Affichage</span>
              <ChevronDown className="w-3 h-3 text-slate-400" />
            </button>
            {openMenu === 'affichage' && (
              <div className="absolute left-0 top-full mt-1 w-64 rounded-md border border-[#2D3545] bg-[#141923] shadow-xl py-1.5 z-50 text-xs max-h-[75vh] overflow-y-auto">
                <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  Vue des tranches
                </div>
                {(
                  [
                    ['all', `Toutes (${totalVisibleCount})`],
                    ['inputs', `Entrées uniquement (${visibleInputStrips.length})`],
                    ['buses', `Aux & Master (${visibleAuxStrips.length + 1})`],
                  ] as [StripViewFilter, string][]
                ).map(([val, label]) => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => {
                      setStripView(val);
                      setOpenMenu(null);
                    }}
                    className="w-full flex items-center justify-between px-3 py-1.5 text-left text-slate-200 hover:bg-[#1E2636] cursor-pointer"
                  >
                    <span>{label}</span>
                    {stripView === val && <Check className="w-3.5 h-3.5 text-amber-400" />}
                  </button>
                ))}
                <div className="my-1 border-t border-[#232936]" />
                <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  Banque d&apos;entrées
                </div>
                {(
                  [
                    ['b1', 'Banque IN 1–8'],
                    ['b2', 'Banque IN 9–16'],
                    ['all', `Toutes 1–16 (${activeInputStrips.length})`],
                  ] as [InputBankFilter, string][]
                ).map(([bank, label]) => (
                  <button
                    key={bank}
                    type="button"
                    onClick={() => {
                      setInputBank(bank);
                      setOpenMenu(null);
                    }}
                    className="w-full flex items-center justify-between px-3 py-1.5 text-left text-slate-200 hover:bg-[#1E2636] cursor-pointer"
                  >
                    <span>{label}</span>
                    {inputBank === bank && <Check className="w-3.5 h-3.5 text-amber-400" />}
                  </button>
                ))}
                <div className="my-1 border-t border-[#232936]" />
                <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                  Taille de l&apos;interface
                </div>
                {(
                  [
                    ['auto', `Auto fenêtre (${Math.round(autoScale * 100)}%)`],
                    [1, 'Taille 100%'],
                    [0.88, 'Compact 88%'],
                    [0.76, 'Petit écran 76%'],
                    [0.55, 'Très compact 55%'],
                  ] as ['auto' | number, string][]
                ).map(([mode, label]) => (
                  <button
                    key={String(mode)}
                    type="button"
                    onClick={() => {
                      setUiScaleMode(mode);
                      setOpenMenu(null);
                    }}
                    className="w-full flex items-center justify-between px-3 py-1.5 text-left text-slate-200 hover:bg-[#1E2636] cursor-pointer"
                  >
                    <span>{label}</span>
                    {uiScaleMode === mode && <Check className="w-3.5 h-3.5 text-sky-400" />}
                  </button>
                ))}
                <div className="my-1 border-t border-[#232936]" />
                <button
                  type="button"
                  onClick={() => setShowPlayerBar((v) => !v)}
                  className="w-full flex items-center justify-between px-3 py-1.5 text-left text-slate-200 hover:bg-[#1E2636] cursor-pointer"
                >
                  <span>Afficher lecteur MP3/WAV</span>
                  {showPlayerBar && <Check className="w-3.5 h-3.5 text-emerald-400" />}
                </button>
              </div>
            )}
          </div>

          <div className="w-px h-5 bg-[#232936] mx-1 hidden sm:block" />

          <button
            type="button"
            onClick={handleToggleAudio}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-semibold border transition-colors cursor-pointer whitespace-nowrap ${
              engineRunning
                ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/50 hover:bg-emerald-500/25'
                : 'bg-[#1A202C] text-slate-100 border-[#2D3545] hover:border-slate-400'
            }`}
          >
            {engineRunning ? (
              <>
                <Square className="w-3 h-3 fill-current" />
                Arrêter Web Audio
              </>
            ) : (
              <>
                <Play className="w-3 h-3 fill-current" />
                Activer Web Audio
              </>
            )}
          </button>
        </div>

        {/* Right Quick Controls + Clean Hardware Status */}
        <div className="flex items-center gap-2.5 shrink-0">
          {anySoloActive && (
            <button
              type="button"
              onClick={() => {
                sendRemoteCmd({ type: 'clear_all_solo' });
                setStrips((prev) => prev.map((s) => ({ ...s, solo: false })));
              }}
              className="px-2.5 py-1 text-xs font-medium bg-amber-500/15 text-amber-300 border border-amber-500/40 rounded hover:bg-amber-500/25 cursor-pointer whitespace-nowrap"
            >
              Désactiver Solo
            </button>
          )}
          {activeTab === 'console' && (
            <button
              type="button"
              onClick={handleCycleInputBank}
              className={`px-2.5 py-1 text-xs font-mono font-medium rounded border cursor-pointer whitespace-nowrap transition-colors ${
                inputBank === 'all'
                  ? 'bg-[#1A202C] text-slate-200 border-[#2D3545] hover:border-amber-400'
                  : 'bg-amber-500/20 text-amber-300 border-amber-500/50 hover:bg-amber-500/30'
              }`}
              title="Basculer entre Banque IN 1–8, Banque IN 9–16 ou Toutes"
            >
              {inputBank === 'b1'
                ? 'Banque IN : 1–8'
                : inputBank === 'b2'
                  ? 'Banque IN : 9–16'
                  : `Banque IN : 1–16 (${activeInputStrips.length})`}
            </button>
          )}
          <span className="text-xs text-slate-400 font-mono tabular-nums hidden md:inline whitespace-nowrap">
            {sampleRate} Hz · {bufferFrames} smp ({bufferLatencyMs} ms)
          </span>
        </div>
      </div>

      {/* MP3 / WAV Audio Player Bar (toggleable from Affichage menu) */}
      {showPlayerBar && (
        <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-2 border-b border-[#232936] bg-[#0D1119]">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex items-center gap-1.5 text-xs font-medium text-slate-300">
            <Music className="w-3.5 h-3.5 text-amber-400" />
            <span>Lecteur Audio</span>
          </div>

          <button
            type="button"
            onClick={() => audioFileInputRef.current?.click()}
            className="px-2.5 py-1 text-xs font-medium bg-[#1A202C] text-slate-200 border border-[#2D3545] rounded hover:border-amber-400 cursor-pointer whitespace-nowrap"
          >
            Ouvrir MP3 / WAV...
          </button>

          <span className="text-xs font-mono text-slate-300 max-w-[200px] truncate">
            {playerStatus.title ?? 'Aucun fichier chargé'}
          </span>

          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={!playerStatus.title}
              aria-label="Lecture"
              onClick={() => {
                sendRemoteCmd({ type: 'player_play' });
                if (!engineRef.current) return;
                const status = engineRef.current.playTrack();
                setPlayerStatus(status);
              }}
              className={`p-1.5 rounded border text-xs cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                playerStatus.playing
                  ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-300'
                  : 'bg-[#1A202C] border-[#2D3545] text-slate-200 hover:border-emerald-400'
              }`}
              title="Lecture"
            >
              <Play className="w-3.5 h-3.5 fill-current" />
            </button>
            <button
              type="button"
              disabled={!playerStatus.playing}
              aria-label="Pause"
              onClick={() => {
                sendRemoteCmd({ type: 'player_pause' });
                if (!engineRef.current) return;
                setPlayerStatus(engineRef.current.pauseTrack());
              }}
              className="p-1.5 rounded border bg-[#1A202C] border-[#2D3545] text-slate-200 hover:border-amber-400 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              title="Pause"
            >
              <Pause className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              disabled={!playerStatus.title}
              aria-label="Stop"
              onClick={() => {
                sendRemoteCmd({ type: 'player_stop' });
                if (!engineRef.current) return;
                setPlayerStatus(engineRef.current.stopTrack());
              }}
              className="p-1.5 rounded border bg-[#1A202C] border-[#2D3545] text-slate-200 hover:border-red-400 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              title="Stop"
            >
              <Square className="w-3.5 h-3.5 fill-current" />
            </button>
            <button
              type="button"
              aria-pressed={playerLoop}
              onClick={() => {
                const next = !playerLoop;
                setPlayerLoop(next);
                sendRemoteCmd({ type: 'player_set_loop', loop_enabled: next });
                engineRef.current?.setPlayerLoop(next);
              }}
              className={`flex items-center gap-1 px-2 py-1 rounded border text-[11px] cursor-pointer ${
                playerLoop
                  ? 'bg-sky-500/20 border-sky-500/50 text-sky-300'
                  : 'bg-[#1A202C] border-[#2D3545] text-slate-400 hover:text-slate-200'
              }`}
              title="Lecture en boucle"
            >
              <Repeat className="w-3 h-3" />
              <span>Boucle</span>
            </button>
          </div>
        </div>

        {/* Progress / Seek + Gain + Route target */}
        <div className="flex flex-wrap items-center gap-3 flex-1 justify-end min-w-[260px]">
          <div className="flex items-center gap-2 flex-1 max-w-[320px] min-w-[160px]">
            <span className="font-mono tabular-nums text-[11px] text-slate-400 shrink-0">
              {formatDuration(playerStatus.posSecs)}
            </span>
            <input
              type="range"
              aria-label="Position lecture audio"
              min={0}
              max={playerStatus.durationSecs > 0 ? playerStatus.durationSecs : 1}
              step={0.1}
              disabled={!playerStatus.title}
              value={Math.min(playerStatus.posSecs, playerStatus.durationSecs || 1)}
              onChange={(e) => {
                const pos = Number(e.target.value);
                sendRemoteCmd({ type: 'player_seek', pos_secs: pos });
                if (!engineRef.current) return;
                const status = engineRef.current.seekTrack(pos);
                setPlayerStatus(status);
              }}
              className="w-full accent-amber-400 cursor-pointer disabled:opacity-40"
            />
            <span className="font-mono tabular-nums text-[11px] text-slate-400 shrink-0">
              {formatDuration(playerStatus.durationSecs)}
            </span>
          </div>

          <div className="flex items-center gap-1.5 text-xs text-slate-300">
            <span className="text-[11px] text-slate-400">Vol</span>
            <input
              type="range"
              aria-label="Volume lecteur audio"
              min={0}
              max={1.5}
              step={0.01}
              value={playerGain}
              onChange={(e) => {
                const val = Number(e.target.value);
                setPlayerGain(val);
                sendRemoteCmd({ type: 'player_set_gain', gain: val });
                engineRef.current?.setPlayerGain(val);
              }}
              className="w-20 accent-sky-400 cursor-pointer"
            />
            <span className="font-mono tabular-nums text-[11px] w-9 text-right">
              {Math.round(playerGain * 100)}%
            </span>
          </div>

          <select
            aria-label="Destination lecteur audio"
            value={playerTargetStripId ?? 'master'}
            onChange={(e) => {
              const target = e.target.value === 'master' ? null : e.target.value;
              setPlayerTargetStripId(target);
              const targetIdx = target ? Number(target.replace('in-', '')) - 1 : null;
              sendRemoteCmd({ type: 'player_set_target', target: targetIdx });
              engineRef.current?.setPlayerTarget(target);
            }}
            className="bg-[#0B0E14] border border-[#232936] rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-sky-500"
          >
            <option value="master">Sortie : Master Direct</option>
            {activeInputStrips.map((st) => (
              <option key={`pl-${st.id}`} value={st.id}>
                Vers Tranche {st.index + 1} ({st.name})
              </option>
            ))}
          </select>
        </div>
      </div>
      )}

      {/* Main Content */}
      <main className="flex-1 p-5 overflow-x-hidden">
        {activeTab === 'console' && (
          <div className="flex flex-col gap-2">
            <div
              ref={consoleViewportRef}
              style={{
                width: frameBoxSize.width ? `${frameBoxSize.width}px` : '100%',
                height: frameBoxSize.height ? `${frameBoxSize.height}px` : undefined,
                maxWidth: '100%',
              }}
              className="relative overflow-auto border border-[#1E2430] rounded-md bg-[#0C1018]/70 p-2.5 pb-5"
            >
              <div
                className="inline-flex items-stretch gap-2.5 min-w-max origin-top-left"
                style={effectiveUiScale !== 1 ? { zoom: effectiveUiScale } : undefined}
              >
                {/* Dynamic Input Strips (8 Stereo up to 16 Mono, filterable by Bank 1-8 / 9-16) */}
                {stripView !== 'buses' && (
                  <div className="flex flex-col gap-2">
                    <div className="text-xs font-medium text-slate-400 px-1">
                      Entrées ({visibleInputStrips.length} affichées · {activeInputStrips.length} actives / {activeHwCaps.in} IN HW)
                    </div>
                    <div className="flex gap-2">
                      {visibleInputStrips.map((strip) => (
                        <ChannelStrip
                          key={strip.id}
                          strip={strip}
                          meter={meters[strip.id] ?? EMPTY_METER}
                          anySoloActive={anySoloActive}
                          inputPairStereo={inputPairStereo}
                          auxPairStereo={auxPairStereo}
                          hardwareChannels={activeHwCaps}
                          midiPorts={effectiveMidiPorts}
                          onToggleInputPair={handleToggleInputPair}
                          onUpdate={handleUpdateStrip}
                          onOpenInsertModal={(stripId, slotIndex) =>
                            setInsertTarget({ stripId, slotIndex })
                          }
                        />
                      ))}
                    </div>
                  </div>
                )}

                {stripView === 'all' && (
                  <div className="w-px bg-[#232936] mx-1 self-stretch" />
                )}

                {/* Dynamic Aux Output Strips (4 Stereo or up to 8 Mono) */}
                {stripView !== 'inputs' && (
                  <div className="flex flex-col gap-2">
                    <div className="text-xs font-medium text-sky-400 px-1">
                      Sorties Aux ({visibleAuxStrips.length} bus actifs · Stéréo / Mono)
                    </div>
                    <div className="flex gap-2">
                      {visibleAuxStrips.map((strip) => (
                        <ChannelStrip
                          key={strip.id}
                          strip={strip}
                          meter={meters[strip.id] ?? EMPTY_METER}
                          anySoloActive={anySoloActive}
                          inputPairStereo={inputPairStereo}
                          auxPairStereo={auxPairStereo}
                          hardwareChannels={activeHwCaps}
                          onToggleAuxPair={handleToggleAuxPair}
                          onUpdate={handleUpdateStrip}
                          onOpenInsertModal={(stripId, slotIndex) =>
                            setInsertTarget({ stripId, slotIndex })
                          }
                        />
                      ))}
                    </div>
                  </div>
                )}

                {stripView === 'all' && (
                  <div className="w-px bg-[#232936] mx-1 self-stretch" />
                )}

                {/* 1 Master Strip (Sans Gain et Sans Solo) */}
                {stripView !== 'inputs' && masterStrip && (
                  <div className="flex flex-col gap-2">
                    <div className="text-xs font-medium text-amber-400 px-1">
                      Tranche Master
                    </div>
                    <ChannelStrip
                      strip={masterStrip}
                      meter={meters[masterStrip.id] ?? EMPTY_METER}
                      anySoloActive={anySoloActive}
                      inputPairStereo={inputPairStereo}
                      auxPairStereo={auxPairStereo}
                      hardwareChannels={activeHwCaps}
                      onUpdate={handleUpdateStrip}
                      onOpenInsertModal={(stripId, slotIndex) =>
                        setInsertTarget({ stripId, slotIndex })
                      }
                    />
                  </div>
                )}
              </div>

              {/* Corner Drag Resize Handle (Window-style gadget + double-click reset) */}
              <div
                role="separator"
                aria-label="Poignée de redimensionnement de l'interface"
                onPointerDown={handleStartCornerResize}
                onDoubleClick={() => setFrameBoxSize({ width: null, height: null })}
                title="Glisser pour redimensionner la console (double-clic pour réinitialiser)"
                className="sticky bottom-0 left-full -mr-1.5 -mb-4 ml-auto w-5 h-5 flex items-end justify-end cursor-nwse-resize text-slate-400 hover:text-amber-300 select-none z-20"
              >
                <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 fill-none stroke-current" strokeWidth="1.6">
                  <path d="M5 14L14 5M9.5 14L14 9.5M13.5 14L14 13.5" />
                </svg>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'routing' && (
          <RoutingMatrixView
            strips={strips}
            inputPairStereo={inputPairStereo}
            auxPairStereo={auxPairStereo}
            onUpdateStrip={handleUpdateStrip}
            onToggleInputPair={handleToggleInputPair}
            onToggleAuxPair={handleToggleAuxPair}
          />
        )}

        {activeTab === 'remote' && (
          <RemoteControlView
            wsAddress={wsAddress}
            onChangeWsAddress={setWsAddress}
            wsStatus={wsStatus}
            wsError={wsError}
            remoteDeviceName={remoteDeviceName}
            onConnect={connectRemoteWs}
            onDisconnect={disconnectRemoteWs}
          />
        )}

        {activeTab === 'rust' && <RustCodeExplorer />}
      </main>

      {/* Insert Plugin Modal (AU / VST3 / VST2) */}
      <PluginModal
        strip={activeModalStrip}
        slotIndex={insertTarget?.slotIndex ?? null}
        onClose={() => setInsertTarget(null)}
        onSelectPlugin={handleSelectPlugin}
        onUpdateParam={handleUpdatePluginParam}
        onToggleBypass={handleTogglePluginBypass}
        onResetParams={handleResetPluginParams}
      />
    </div>
  );
}
