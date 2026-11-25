import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Download,
  FolderOpen,
  Music,
  Pause,
  Play,
  Repeat,
  RotateCcw,
  Save,
  Split,
  Square,
} from 'lucide-react';
import { WebAudioMixerEngine } from './audio/webAudioEngine';
import { ChannelStrip } from './components/ChannelStrip';
import { PluginModal } from './components/PluginModal';
import { RoutingMatrixView } from './components/RoutingMatrixView';
import { RustCodeExplorer } from './components/RustCodeExplorer';
import { RUST_PROJECT_FILES } from './data/rustProjectFiles';
import {
  AuxPairStereoState,
  AuxSendsTuple,
  HardwareInputRoute,
  HardwareOutputRoute,
  InsertPluginSlot,
  MAX_AUX_PAIRS,
  MAX_INSERTS_PER_STRIP,
  MeterLevel,
  MixerSetSnapshot,
  NUM_AUX_BUSES,
  PLUGIN_CATALOG,
  PlayerStatus,
  PluginDescriptor,
  StripState,
  formatInputRouteLabel,
  formatOutputRouteLabel,
} from './types/mixer';
import { buildZipArchive } from './utils/zipBuilder';

type ActiveTab = 'console' | 'routing' | 'rust';
type OsDriverProfile = 'macos_coreaudio' | 'linux_alsa';
type StripViewFilter = 'all' | 'inputs' | 'buses';
type HardwareProfileId = 'umc1820' | 'stereo_2x2' | 'quad_4x4' | 'studio_16x16';

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
  const inputs: StripState[] = Array.from({ length: 8 }, (_, i) => {
    const inputRoute: HardwareInputRoute = { kind: 'mono', channel: i };
    return {
      id: `in-${i + 1}`,
      index: i,
      kind: 'input',
      name: `Tranche ${i + 1}`,
      hardwareChannelLabel: formatInputRouteLabel(inputRoute),
      inputRoute,
      outputRoute: { kind: 'master' },
      gainDb: 0,
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
          : i === 1
            ? 'bass_synth'
            : i === 2
              ? 'epiano_chord'
              : 'none',
    };
  });

  // Preload realistic demo inserts on first channels
  inputs[0].name = 'Kick / Drums';
  inputs[0].inserts[0] = {
    slotIndex: 0,
    plugin: PLUGIN_CATALOG[0], // AUDynamicsProcessor (AU)
    bypassed: false,
    params: { ...PLUGIN_CATALOG[0].defaultParams },
  };
  inputs[0].eq.lowGainDb = 2.5;
  inputs[0].eq.highGainDb = 1.5;

  inputs[1].name = 'Basse Synth';
  inputs[1].inserts[0] = {
    slotIndex: 0,
    plugin: PLUGIN_CATALOG[2], // AUFilter HPF
    bypassed: false,
    params: { ...PLUGIN_CATALOG[2].defaultParams, freq: 38 },
  };
  inputs[1].inserts[1] = {
    slotIndex: 1,
    plugin: PLUGIN_CATALOG[1], // ConsoleDrive Tube (VST3)
    bypassed: false,
    params: { ...PLUGIN_CATALOG[1].defaultParams },
  };

  inputs[2].name = 'E-Piano';
  inputs[2].auxSends = [30, 0, 15, 0, 0, 0, 0, 0];
  inputs[2].inserts[0] = {
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
      index: 8 + idx,
      kind: 'aux',
      name: isPrimary ? `Aux ${pairIdx * 2 + 1}/${pairIdx * 2 + 2}` : `Aux ${idx + 1}`,
      hardwareChannelLabel: formatOutputRouteLabel(outputRoute),
      inputRoute: { kind: 'none' },
      outputRoute,
      gainDb: 0,
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
    index: 16,
    kind: 'master',
    name: 'Master',
    hardwareChannelLabel: formatOutputRouteLabel(masterOut),
    inputRoute: { kind: 'none' },
    outputRoute: masterOut,
    gainDb: 0,
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
  auxPairStereo: AuxPairStereoState;
  playerLoop?: boolean;
  playerGain?: number;
  playerTargetStripId?: string | null;
} | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Partial<MixerSetSnapshot>;
  if (!Array.isArray(obj.strips) || obj.strips.length === 0) return null;

  const base = createInitialStrips();
  const baseById = new Map(base.map((s) => [s.id, s]));

  const auxPairStereo: AuxPairStereoState = [true, true, true, true];
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
      // Upgrade legacy 4-pair sends into slots 0, 2, 4, 6
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

    const merged: StripState = {
      ...target,
      name: typeof loaded.name === 'string' && loaded.name.trim() ? loaded.name : target.name,
      hardwareChannelLabel:
        typeof loaded.hardwareChannelLabel === 'string'
          ? loaded.hardwareChannelLabel
          : target.hardwareChannelLabel,
      inputRoute: loaded.inputRoute ?? target.inputRoute,
      outputRoute: loaded.outputRoute ?? target.outputRoute,
      gainDb: typeof loaded.gainDb === 'number' ? loaded.gainDb : target.gainDb,
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

  return {
    strips: base.map((b) => baseById.get(b.id) ?? b),
    auxPairStereo,
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
  const [auxPairStereo, setAuxPairStereo] = useState<AuxPairStereoState>([
    true,
    true,
    true,
    true,
  ]);
  const [engineRunning, setEngineRunning] = useState(false);
  const [sampleRate, setSampleRate] = useState(48000);
  const [meters, setMeters] = useState<Record<string, MeterLevel>>({});
  const [insertTarget, setInsertTarget] = useState<{ stripId: string; slotIndex: number } | null>(
    null
  );
  const [uiScale, setUiScale] = useState<number>(1);
  const [stripView, setStripView] = useState<StripViewFilter>('all');

  // Set Save / Load feedback
  const [setNotice, setSetNotice] = useState<string | null>(null);
  const setFileInputRef = useRef<HTMLInputElement | null>(null);

  // Audio File Player (MP3 / WAV) state
  const audioFileInputRef = useRef<HTMLInputElement | null>(null);
  const [playerStatus, setPlayerStatus] = useState<PlayerStatus>(EMPTY_PLAYER_STATUS);
  const [playerLoop, setPlayerLoop] = useState(false);
  const [playerGain, setPlayerGain] = useState(1.0);
  const [playerTargetStripId, setPlayerTargetStripId] = useState<string | null>(null);

  const engineRef = useRef<WebAudioMixerEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = new WebAudioMixerEngine();
  }

  // Sync mixer state into Web Audio DSP graph whenever parameters change
  useEffect(() => {
    if (engineRef.current && engineRunning) {
      engineRef.current.syncAll(strips, auxPairStereo);
    }
  }, [strips, auxPairStereo, engineRunning]);

  // 60fps real-time VU metering & player transport progress loop
  useEffect(() => {
    if (!engineRunning && !playerStatus.playing) {
      if (!engineRunning) setMeters({});
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
  }, [engineRunning, playerStatus.playing]);

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
      await engine.start(strips);
      engine.syncAll(strips, auxPairStereo);
      engine.setPlayerLoop(playerLoop);
      engine.setPlayerGain(playerGain);
      engine.setPlayerTarget(playerTargetStripId);
      setSampleRate(engine.getSampleRate());
      setEngineRunning(true);
    }
  };

  const handleUpdateStrip = (stripId: string, updater: (prev: StripState) => StripState) => {
    setStrips((prev) => prev.map((s) => (s.id === stripId ? updater(s) : s)));
  };

  const handleToggleAuxPair = (pairIndex: number) => {
    if (pairIndex < 0 || pairIndex >= MAX_AUX_PAIRS) return;
    const nextIsStereo = !auxPairStereo[pairIndex];
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
    setAuxPairStereo([targetStereo, targetStereo, targetStereo, targetStereo]);
    setStrips((prev) =>
      prev.map((s) => {
        if (s.kind !== 'aux') return s;
        const idx = s.index - 8;
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
      version: 2,
      auxPairStereo,
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
      setAuxPairStereo(normalized.auxPairStereo);
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
      const status = await engineRef.current.loadAudioFile(file, strips);
      engineRef.current.syncAll(strips, auxPairStereo);
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
  const anyAuxMono = auxPairStereo.some((v) => !v);
  const totalVisibleCount = 8 + visibleAuxStrips.length + 1;

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

        <div className="flex items-center gap-2 shrink-0">
          {setNotice && (
            <span className="text-xs font-mono text-emerald-300 bg-emerald-500/15 border border-emerald-500/40 rounded px-2.5 py-1">
              {setNotice}
            </span>
          )}
          <button
            type="button"
            onClick={handleSaveSet}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#1A202C] text-slate-200 border border-[#2D3545] rounded hover:border-sky-400 transition-colors whitespace-nowrap cursor-pointer"
          >
            <Save className="w-3.5 h-3.5 text-sky-400" />
            Sauver Set
          </button>
          <button
            type="button"
            onClick={() => setFileInputRef.current?.click()}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#1A202C] text-slate-200 border border-[#2D3545] rounded hover:border-sky-400 transition-colors whitespace-nowrap cursor-pointer"
          >
            <FolderOpen className="w-3.5 h-3.5 text-amber-300" />
            Charger Set
          </button>
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

      {/* Workspace Control Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-2.5 border-b border-[#232936] bg-[#11151E]">
        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={handleToggleAudio}
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded text-xs font-semibold border transition-colors cursor-pointer whitespace-nowrap ${
              engineRunning
                ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/50 hover:bg-emerald-500/25'
                : 'bg-[#1A202C] text-slate-100 border-[#2D3545] hover:border-slate-400'
            }`}
          >
            {engineRunning ? (
              <>
                <Square className="w-3.5 h-3.5 fill-current" />
                Arrêter Web Audio
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5 fill-current" />
                Activer Web Audio
              </>
            )}
          </button>

          <select
            aria-label="Profil carte son"
            value={hardwareProfile}
            onChange={(e) => setHardwareProfile(e.target.value as HardwareProfileId)}
            className="bg-[#0B0E14] border border-[#232936] rounded px-2.5 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-sky-500"
          >
            {Object.entries(HARDWARE_PROFILES).map(([id, prof]) => (
              <option key={id} value={id}>
                {prof.label}
              </option>
            ))}
          </select>

          <select
            aria-label="Profil pilote OS"
            value={driverProfile}
            onChange={(e) => setDriverProfile(e.target.value as OsDriverProfile)}
            className="bg-[#0B0E14] border border-[#232936] rounded px-2.5 py-1.5 text-xs text-slate-300 focus:outline-none focus:border-sky-500"
          >
            <option value="macos_coreaudio">macOS · CoreAudio (AU / VST3 / VST2)</option>
            <option value="linux_alsa">Linux · ALSA / JACK (VST3 / VST2)</option>
          </select>

          <span className="text-xs text-slate-400 font-mono tabular-nums hidden xl:inline">
            {sampleRate} Hz
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleToggleAllAuxMode}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded border cursor-pointer whitespace-nowrap transition-colors ${
              anyAuxMono
                ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40 hover:bg-emerald-500/25'
                : 'bg-sky-500/15 text-sky-300 border-sky-500/40 hover:bg-sky-500/25'
            }`}
            title="Basculer tous les bus auxiliaires entre 4 paires Stéréo et 8 bus Mono"
          >
            <Split className="w-3.5 h-3.5" />
            {anyAuxMono ? `Aux (${visibleAuxStrips.length} actifs → 4 Stéréo)` : 'Aux : 4 Stéréo → 8 Mono'}
          </button>

          {activeTab === 'console' && (
            <>
              <select
                aria-label="Vue des tranches"
                value={stripView}
                onChange={(e) => setStripView(e.target.value as StripViewFilter)}
                className="bg-[#0B0E14] border border-[#232936] rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-sky-500"
              >
                <option value="all">Toutes ({totalVisibleCount})</option>
                <option value="inputs">8 Entrées (1–8)</option>
                <option value="buses">Aux &amp; Master ({visibleAuxStrips.length + 1})</option>
              </select>
              <select
                aria-label="Taille de l'interface"
                value={uiScale}
                onChange={(e) => setUiScale(Number(e.target.value))}
                className="bg-[#0B0E14] border border-[#232936] rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-sky-500"
              >
                <option value={1}>Taille 100%</option>
                <option value={0.88}>Compact 88%</option>
                <option value={0.76}>Petit écran 76%</option>
              </select>
            </>
          )}
          {anySoloActive && (
            <button
              type="button"
              onClick={() =>
                setStrips((prev) => prev.map((s) => ({ ...s, solo: false })))
              }
              className="px-3 py-1.5 text-xs font-medium bg-amber-500/15 text-amber-300 border border-amber-500/40 rounded hover:bg-amber-500/25 cursor-pointer whitespace-nowrap"
            >
              Désactiver Solo
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              setStrips(createInitialStrips());
              setAuxPairStereo([true, true, true, true]);
              showTemporaryNotice('Console réinitialisée');
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#1A202C] text-slate-300 border border-[#2D3545] rounded hover:text-white cursor-pointer whitespace-nowrap"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Réinitialiser
          </button>
        </div>
      </div>

      {/* MP3 / WAV Audio Player Bar */}
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
                if (!engineRef.current) return;
                const status = engineRef.current.seekTrack(Number(e.target.value));
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
              engineRef.current?.setPlayerTarget(target);
            }}
            className="bg-[#0B0E14] border border-[#232936] rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-sky-500"
          >
            <option value="master">Sortie : Master Direct</option>
            {inputStrips.map((st, idx) => (
              <option key={`pl-${st.id}`} value={st.id}>
                Vers Tranche {idx + 1} ({st.name})
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Main Content */}
      <main className="flex-1 p-5 overflow-x-hidden">
        {activeTab === 'console' && (
          <div className="flex flex-col gap-3">
            <div className="overflow-auto pb-3">
              <div
                className="inline-flex items-stretch gap-2.5 min-w-max origin-top-left"
                style={uiScale !== 1 ? { zoom: uiScale } : undefined}
              >
                {/* 8 Input Strips */}
                {stripView !== 'buses' && (
                  <div className="flex flex-col gap-2">
                    <div className="text-xs font-medium text-slate-400 px-1">
                      8 Tranches d'entrée ({activeHwCaps.in} IN disponibles)
                    </div>
                    <div className="flex gap-2">
                      {inputStrips.map((strip) => (
                        <ChannelStrip
                          key={strip.id}
                          strip={strip}
                          meter={meters[strip.id] ?? EMPTY_METER}
                          anySoloActive={anySoloActive}
                          auxPairStereo={auxPairStereo}
                          hardwareChannels={activeHwCaps}
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
            </div>
          </div>
        )}

        {activeTab === 'routing' && (
          <RoutingMatrixView
            strips={strips}
            auxPairStereo={auxPairStereo}
            onUpdateStrip={handleUpdateStrip}
            onToggleAuxPair={handleToggleAuxPair}
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
