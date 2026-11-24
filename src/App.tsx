import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Play, RotateCcw, Square } from 'lucide-react';
import { WebAudioMixerEngine } from './audio/webAudioEngine';
import { ChannelStrip } from './components/ChannelStrip';
import { PluginModal } from './components/PluginModal';
import { RoutingMatrixView } from './components/RoutingMatrixView';
import { RustCodeExplorer } from './components/RustCodeExplorer';
import { RUST_PROJECT_FILES } from './data/rustProjectFiles';
import {
  InsertPluginSlot,
  MAX_INSERTS_PER_STRIP,
  MeterLevel,
  PLUGIN_CATALOG,
  PluginDescriptor,
  StripState,
} from './types/mixer';
import { buildZipArchive } from './utils/zipBuilder';

type ActiveTab = 'console' | 'routing' | 'rust';
type OsDriverProfile = 'macos_coreaudio' | 'linux_alsa';
type StripViewFilter = 'all' | 'inputs' | 'buses';

function createEmptyInserts(): InsertPluginSlot[] {
  return Array.from({ length: MAX_INSERTS_PER_STRIP }, (_, slotIndex) => ({
    slotIndex,
    plugin: null,
    bypassed: false,
    params: {},
  }));
}

function createInitialStrips(): StripState[] {
  const inputs: StripState[] = Array.from({ length: 8 }, (_, i) => ({
    id: `in-${i + 1}`,
    index: i,
    kind: 'input',
    name: `Tranche ${i + 1}`,
    hardwareChannelLabel: `UMC1820 IN ${i + 1}`,
    gainDb: 0,
    inserts: createEmptyInserts(),
    eq: {
      lowGainDb: 0,
      lowMidGainDb: 0,
      highMidGainDb: 0,
      highGainDb: 0,
      bypassed: false,
    },
    auxSends: [0, 0, 0, 0],
    solo: false,
    mute: false,
    volumeDb: -3,
    source: i === 0 ? 'kick_groove' : i === 1 ? 'bass_synth' : i === 2 ? 'epiano_chord' : 'none',
  }));

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
  inputs[2].auxSends = [30, 15, 0, 0];
  inputs[2].inserts[0] = {
    slotIndex: 0,
    plugin: PLUGIN_CATALOG[3], // Dimension Ensemble (VST3)
    bypassed: false,
    params: { ...PLUGIN_CATALOG[3].defaultParams },
  };

  const auxPairs = ['1/2', '3/4', '5/6', '7/8'];
  const auxStrips: StripState[] = auxPairs.map((pair, idx) => ({
    id: `aux-${idx + 1}`,
    index: 8 + idx,
    kind: 'aux',
    name: `Aux ${pair}`,
    hardwareChannelLabel: `Line Out ${pair}`,
    gainDb: 0,
    inserts: createEmptyInserts(),
    eq: {
      lowGainDb: 0,
      lowMidGainDb: 0,
      highMidGainDb: 0,
      highGainDb: 0,
      bypassed: false,
    },
    auxSends: [0, 0, 0, 0],
    solo: false,
    mute: false,
    volumeDb: 0,
    source: 'none',
  }));

  auxStrips[0].inserts[0] = {
    slotIndex: 0,
    plugin: PLUGIN_CATALOG[5], // AUMatrixReverb Hall (AU)
    bypassed: false,
    params: { ...PLUGIN_CATALOG[5].defaultParams },
  };

  const master: StripState = {
    id: 'master',
    index: 12,
    kind: 'master',
    name: 'Master',
    hardwareChannelLabel: 'Main Out 1-2 / 9-10',
    gainDb: 0,
    inserts: createEmptyInserts(),
    eq: {
      lowGainDb: 0,
      lowMidGainDb: 0,
      highMidGainDb: 0,
      highGainDb: 0,
      bypassed: false,
    },
    auxSends: [0, 0, 0, 0],
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

const EMPTY_METER: MeterLevel = {
  peakDbL: -60,
  peakDbR: -60,
  rmsDbL: -60,
  rmsDbR: -60,
  clip: false,
};

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('console');
  const [driverProfile, setDriverProfile] = useState<OsDriverProfile>('macos_coreaudio');
  const [strips, setStrips] = useState<StripState[]>(createInitialStrips);
  const [engineRunning, setEngineRunning] = useState(false);
  const [sampleRate, setSampleRate] = useState(48000);
  const [meters, setMeters] = useState<Record<string, MeterLevel>>({});
  const [insertTarget, setInsertTarget] = useState<{ stripId: string; slotIndex: number } | null>(null);
  const [uiScale, setUiScale] = useState<number>(1);
  const [stripView, setStripView] = useState<StripViewFilter>('all');

  const engineRef = useRef<WebAudioMixerEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = new WebAudioMixerEngine();
  }

  // Sync mixer state into Web Audio DSP graph whenever parameters change
  useEffect(() => {
    if (engineRef.current && engineRunning) {
      engineRef.current.syncAll(strips);
    }
  }, [strips, engineRunning]);

  // 60fps real-time VU metering loop when audio engine is running
  useEffect(() => {
    if (!engineRunning) {
      setMeters({});
      return;
    }
    let rafId = 0;
    const tick = () => {
      if (engineRef.current) {
        setMeters(engineRef.current.readMeters());
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [engineRunning]);

  const handleToggleAudio = async () => {
    const engine = engineRef.current;
    if (!engine) return;
    if (engineRunning) {
      await engine.stop();
      setEngineRunning(false);
    } else {
      await engine.start(strips);
      setSampleRate(engine.getSampleRate());
      setEngineRunning(true);
    }
  };

  const handleUpdateStrip = (stripId: string, updater: (prev: StripState) => StripState) => {
    setStrips((prev) => prev.map((s) => (s.id === stripId ? updater(s) : s)));
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

  const activeModalStrip = insertTarget
    ? strips.find((s) => s.id === insertTarget.stripId) ?? null
    : null;

  return (
    <div className="min-h-screen flex flex-col bg-[#0B0E14] text-slate-100">
      {/* 3-Zone Top Bar */}
      <header className="flex items-center justify-between gap-8 px-6 py-3.5 border-b border-[#232936] bg-[#0E121A]">
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

        <div className="shrink-0">
          <button
            type="button"
            onClick={handleDownloadRustZip}
            className="flex items-center gap-2 px-4 py-2 text-xs font-semibold bg-amber-400 text-slate-950 rounded hover:bg-amber-300 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            Télécharger Rust (.zip)
          </button>
        </div>
      </header>

      {/* Workspace Control Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 px-6 py-3 border-b border-[#232936] bg-[#11151E]">
        <div className="flex flex-wrap items-center gap-3">
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
                Arrêter l'écoute Web Audio
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5 fill-current" />
                Activer l'écoute Web Audio
              </>
            )}
          </button>

          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span>Cible pilote :</span>
            <select
              aria-label="Profil pilote OS"
              value={driverProfile}
              onChange={(e) => setDriverProfile(e.target.value as OsDriverProfile)}
              className="bg-[#0B0E14] border border-[#232936] rounded px-2.5 py-1 text-xs text-slate-200 focus:outline-none focus:border-sky-500"
            >
              <option value="macos_coreaudio">macOS · CoreAudio (AU / VST3 / VST2)</option>
              <option value="linux_alsa">Linux · ALSA / JACK (VST3 / VST2)</option>
            </select>
          </div>

          <div className="text-xs text-slate-400 font-mono tabular-nums hidden sm:flex items-center gap-2">
            <span>Behringer UMC1820</span>
            <span aria-hidden="true">·</span>
            <span>{sampleRate} Hz</span>
            <span aria-hidden="true">·</span>
            <span>8 IN / 4 AUX STÉRÉO / MASTER</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {activeTab === 'console' && (
            <>
              <select
                aria-label="Vue des tranches"
                value={stripView}
                onChange={(e) => setStripView(e.target.value as StripViewFilter)}
                className="bg-[#0B0E14] border border-[#232936] rounded px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:border-sky-500"
              >
                <option value="all">Toutes les tranches (13)</option>
                <option value="inputs">8 Entrées (1–8)</option>
                <option value="buses">4 Aux &amp; Master</option>
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
              Désactiver tous les Solo
            </button>
          )}
          <button
            type="button"
            onClick={() => setStrips(createInitialStrips())}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#1A202C] text-slate-300 border border-[#2D3545] rounded hover:text-white cursor-pointer whitespace-nowrap"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Réinitialiser
          </button>
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
                      8 Tranches d'entrée (UMC1820 IN 1–8)
                    </div>
                    <div className="flex gap-2">
                      {inputStrips.map((strip) => (
                        <ChannelStrip
                          key={strip.id}
                          strip={strip}
                          meter={meters[strip.id] ?? EMPTY_METER}
                          anySoloActive={anySoloActive}
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

                {/* 4 Stereo Aux Output Strips */}
                {stripView !== 'inputs' && (
                  <div className="flex flex-col gap-2">
                    <div className="text-xs font-medium text-sky-400 px-1">
                      4 Sorties Aux Stéréo (1/2 · 3/4 · 5/6 · 7/8)
                    </div>
                    <div className="flex gap-2">
                      {auxStrips.map((strip) => (
                        <ChannelStrip
                          key={strip.id}
                          strip={strip}
                          meter={meters[strip.id] ?? EMPTY_METER}
                          anySoloActive={anySoloActive}
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
          <RoutingMatrixView strips={strips} onUpdateStrip={handleUpdateStrip} />
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
