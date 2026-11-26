import React from 'react';
import { ChevronLeft, ChevronRight, Power, Plus, Split, X } from 'lucide-react';
import {
  AuxPairStereoState,
  AuxSendsTuple,
  HardwareInputRoute,
  HardwareOutputRoute,
  InputPairStereoState,
  InputSourceKind,
  MAX_AUX_PAIRS,
  MAX_INSERTS_PER_STRIP,
  MeterLevel,
  MidiPortInfo,
  NUM_INPUT_STRIPS,
  StripState,
  formatInputRouteLabel,
  formatOutputRouteLabel,
} from '../types/mixer';
import { Fader } from './Fader';
import { RotaryKnob } from './RotaryKnob';
import { VuMeter } from './VuMeter';

interface ChannelStripProps {
  strip: StripState;
  meter: MeterLevel;
  anySoloActive: boolean;
  inputPairStereo: InputPairStereoState;
  auxPairStereo: AuxPairStereoState;
  hardwareChannels?: { in: number; out: number };
  midiPorts?: MidiPortInfo[];
  canMoveLeft?: boolean;
  canMoveRight?: boolean;
  onMoveStrip?: (stripId: string, delta: -1 | 1) => void;
  onToggleInputPair?: (pairIndex: number) => void;
  onToggleAuxPair?: (pairIndex: number) => void;
  onUpdate: (stripId: string, updater: (prev: StripState) => StripState) => void;
  onOpenInsertModal: (stripId: string, slotIndex: number) => void;
}

const SOURCE_OPTIONS: { value: InputSourceKind; label: string }[] = [
  { value: 'none', label: 'Entrée HW (Silence)' },
  { value: 'kick_groove', label: 'Synth: Kick & Groove' },
  { value: 'bass_synth', label: 'Synth: Basse Analog' },
  { value: 'epiano_chord', label: 'Synth: E-Piano' },
  { value: 'lead_arp', label: 'Synth: Arpège Lead' },
  { value: 'pink_noise', label: 'Bruit Rose' },
  { value: 'sine_1k', label: 'Oscillateur 440 Hz' },
  { value: 'microphone', label: 'Microphone Live' },
];

function serializeInputRoute(route: HardwareInputRoute): string {
  if (route.kind === 'none') return 'none';
  return `${route.kind}:${route.channel}`;
}

function parseInputRoute(encoded: string): HardwareInputRoute {
  if (encoded === 'none') return { kind: 'none' };
  const [kind, chStr] = encoded.split(':');
  const channel = Number(chStr) || 0;
  return kind === 'stereo' ? { kind: 'stereo', channel } : { kind: 'mono', channel };
}

function serializeOutputRoute(route: HardwareOutputRoute): string {
  if (route.kind === 'none') return 'none';
  if (route.kind === 'master') return 'master';
  return `${route.kind}:${route.channel}`;
}

function parseOutputRoute(encoded: string): HardwareOutputRoute {
  if (encoded === 'none') return { kind: 'none' };
  if (encoded === 'master') return { kind: 'master' };
  const [kind, chStr] = encoded.split(':');
  const channel = Number(chStr) || 0;
  return kind === 'stereo' ? { kind: 'stereo', channel } : { kind: 'mono', channel };
}

export const ChannelStrip: React.FC<ChannelStripProps> = ({
  strip,
  meter,
  anySoloActive,
  inputPairStereo,
  auxPairStereo,
  hardwareChannels = { in: 8, out: 10 },
  midiPorts = [],
  canMoveLeft = false,
  canMoveRight = false,
  onMoveStrip,
  onToggleInputPair,
  onToggleAuxPair,
  onUpdate,
  onOpenInsertModal,
}) => {
  const isMaster = strip.kind === 'master';
  const isAux = strip.kind === 'aux';
  const isInput = strip.kind === 'input';

  const isDimmedBySolo = !isMaster && anySoloActive && !strip.solo;
  const inPairIndex = isInput ? Math.floor(strip.index / 2) : -1;
  const isInputStereo = isInput && inPairIndex >= 0 && inputPairStereo[inPairIndex];
  const auxPairIndex = isAux ? Math.floor((strip.index - NUM_INPUT_STRIPS) / 2) : -1;
  const isAuxStereo = isAux && auxPairIndex >= 0 && auxPairStereo[auxPairIndex];

  const stripBg = isMaster
    ? 'bg-[var(--bg-strip-master)] border-amber-500/35'
    : isAux
      ? 'bg-[var(--bg-strip-aux)] border-sky-500/30'
      : 'bg-[var(--bg-strip-in)] border-[var(--border-main)]';

  const activeInsertCount = strip.inserts.filter((s) => s.plugin !== null).length;

  const inChannelCount = Math.max(2, hardwareChannels.in);
  const outChannelCount = Math.max(2, hardwareChannels.out);

  // Build visible auxiliary send knobs according to each pair's Stereo / Split Mono mode
  const activeAuxSends: { auxIdx: number; label: string }[] = [];
  for (let p = 0; p < MAX_AUX_PAIRS; p++) {
    const ch1 = p * 2 + 1;
    const ch2 = p * 2 + 2;
    if (auxPairStereo[p]) {
      activeAuxSends.push({ auxIdx: p * 2, label: `A ${ch1}/${ch2}` });
    } else {
      activeAuxSends.push({ auxIdx: p * 2, label: `A ${ch1}` });
      activeAuxSends.push({ auxIdx: p * 2 + 1, label: `A ${ch2}` });
    }
  }

  return (
    <section
      aria-label={`Tranche ${strip.name}`}
      className={`flex flex-col w-[138px] shrink-0 border rounded-md p-2.5 gap-2 transition-opacity ${stripBg} ${
        isDimmedBySolo ? 'opacity-65' : 'opacity-100'
      }`}
    >
      {/* Strip Header */}
      <div className="flex flex-col gap-0.5 border-b border-[var(--border-main)] pb-2">
        <div className="flex items-center justify-between gap-1">
          {isInput && onMoveStrip && (
            <button
              type="button"
              disabled={!canMoveLeft}
              onClick={() => onMoveStrip(strip.id, -1)}
              aria-label={`Déplacer ${strip.name} à gauche`}
              title="Déplacer la piste vers la gauche"
              className="p-0.5 rounded border border-[var(--border-main)] bg-[var(--bg-control)] text-[var(--text-muted)] hover:text-[var(--text-main)] disabled:opacity-30 disabled:cursor-default cursor-pointer shrink-0"
            >
              <ChevronLeft className="w-3 h-3" />
            </button>
          )}
          <input
            type="text"
            value={strip.name}
            maxLength={14}
            aria-label={`Nom de la tranche ${strip.name}`}
            onChange={(e) =>
              onUpdate(strip.id, (s) => ({ ...s, name: e.target.value }))
            }
            className="w-full min-w-0 bg-transparent text-xs font-semibold text-[var(--text-main)] focus:outline-none focus:bg-[var(--bg-control)] rounded px-1 truncate text-center"
          />
          {isInput && onMoveStrip && (
            <button
              type="button"
              disabled={!canMoveRight}
              onClick={() => onMoveStrip(strip.id, 1)}
              aria-label={`Déplacer ${strip.name} à droite`}
              title="Déplacer la piste vers la droite"
              className="p-0.5 rounded border border-[var(--border-main)] bg-[var(--bg-control)] text-[var(--text-muted)] hover:text-[var(--text-main)] disabled:opacity-30 disabled:cursor-default cursor-pointer shrink-0"
            >
              <ChevronRight className="w-3 h-3" />
            </button>
          )}
        </div>
        <div className="text-[10px] font-mono text-[var(--text-muted)] truncate text-center">
          {strip.hardwareChannelLabel}
        </div>
      </div>

      {/* Top Hardware I/O Selector (every strip — inputs have BOTH input + output selectors) */}
      {isInput ? (
        <div className="flex flex-col gap-1">
          <select
            aria-label={`Entrée matérielle ${strip.name}`}
            value={serializeInputRoute(strip.inputRoute)}
            onChange={(e) => {
              const nextRoute = parseInputRoute(e.target.value);
              onUpdate(strip.id, (s) => ({
                ...s,
                inputRoute: nextRoute,
                hardwareChannelLabel: formatInputRouteLabel(nextRoute),
              }));
            }}
            className="w-full bg-[var(--bg-control)] border border-amber-500/35 rounded px-1.5 py-1 text-[10px] text-amber-200 focus:outline-none focus:border-amber-400 truncate"
            title="Sélecteur d'entrée physique (carte son)"
          >
            <option value="none">Entrée : Aucune</option>
            {Array.from({ length: inChannelCount }, (_, ch) => (
              <option key={`in-m-${ch}`} value={`mono:${ch}`}>
                In {ch + 1} (Mono)
              </option>
            ))}
            {Array.from({ length: Math.floor(inChannelCount / 2) }, (_, pair) => {
              const ch = pair * 2;
              return (
                <option key={`in-s-${ch}`} value={`stereo:${ch}`}>
                  In {ch + 1}/{ch + 2} (Stéréo)
                </option>
              );
            })}
          </select>

          <select
            aria-label={`Sortie directe ${strip.name}`}
            value={serializeOutputRoute(strip.outputRoute)}
            onChange={(e) => {
              const nextRoute = parseOutputRoute(e.target.value);
              onUpdate(strip.id, (s) => ({
                ...s,
                outputRoute: nextRoute,
              }));
            }}
            className="w-full bg-[var(--bg-control)] border border-sky-500/35 rounded px-1.5 py-1 text-[10px] text-sky-200 focus:outline-none focus:border-sky-400 truncate"
            title="Sélecteur de sortie (Master ou sortie matérielle directe)"
          >
            <option value="master">Vers Master</option>
            <option value="none">Sortie : Aucune</option>
            {Array.from({ length: Math.floor(outChannelCount / 2) }, (_, pair) => {
              const ch = pair * 2;
              return (
                <option key={`in-out-s-${ch}`} value={`stereo:${ch}`}>
                  Out {ch + 1}/{ch + 2} (Stéréo)
                </option>
              );
            })}
            {Array.from({ length: outChannelCount }, (_, ch) => (
              <option key={`in-out-m-${ch}`} value={`mono:${ch}`}>
                Out {ch + 1} (Mono)
              </option>
            ))}
          </select>

          <select
            aria-label={`Source audio ${strip.name}`}
            value={strip.source}
            onChange={(e) =>
              onUpdate(strip.id, (s) => ({
                ...s,
                source: e.target.value as InputSourceKind,
              }))
            }
            className="w-full bg-[var(--bg-control)] border border-[var(--border-main)] rounded px-1.5 py-1 text-[10px] text-[var(--text-main)] focus:outline-none focus:border-sky-500 truncate"
            title="Source de test Web Audio"
          >
            {SOURCE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <select
            aria-label={`Sortie matérielle ${strip.name}`}
            value={serializeOutputRoute(strip.outputRoute)}
            onChange={(e) => {
              const nextRoute = parseOutputRoute(e.target.value);
              onUpdate(strip.id, (s) => ({
                ...s,
                outputRoute: nextRoute,
                hardwareChannelLabel: formatOutputRouteLabel(nextRoute),
              }));
            }}
            className={`w-full bg-[var(--bg-control)] rounded px-1.5 py-1 text-[10px] focus:outline-none truncate border ${
              isMaster
                ? 'border-amber-500/35 text-amber-200 focus:border-amber-400'
                : 'border-sky-500/35 text-sky-200 focus:border-sky-400'
            }`}
            title="Sélecteur de sortie physique (carte son)"
          >
            <option value="none">Sortie : Aucune</option>
            {isAux && <option value="master">Vers Master</option>}
            {Array.from({ length: Math.floor(outChannelCount / 2) }, (_, pair) => {
              const ch = pair * 2;
              return (
                <option key={`out-s-${ch}`} value={`stereo:${ch}`}>
                  Out {ch + 1}/{ch + 2} (Stéréo)
                </option>
              );
            })}
            {Array.from({ length: outChannelCount }, (_, ch) => (
              <option key={`out-m-${ch}`} value={`mono:${ch}`}>
                Out {ch + 1} (Mono)
              </option>
            ))}
          </select>

          {isAux && onToggleAuxPair ? (
            <button
              type="button"
              onClick={() => onToggleAuxPair(auxPairIndex)}
              className={`flex items-center justify-center gap-1 w-full rounded px-1.5 py-1 text-[10px] font-medium border cursor-pointer transition-colors ${
                isAuxStereo
                  ? 'bg-sky-500/15 border-sky-500/40 text-sky-300 hover:bg-sky-500/25'
                  : 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/25'
              }`}
              title={
                isAuxStereo
                  ? 'Séparer cette paire en 2 bus Mono indépendants'
                  : 'Recombiner en 1 bus Stéréo'
              }
            >
              <Split className="w-2.5 h-2.5 shrink-0" />
              <span>{isAuxStereo ? 'Stéréo → Mono' : 'Mono → Stéréo'}</span>
            </button>
          ) : (
            <div className="h-[24px] flex items-center justify-center text-[10px] font-mono text-amber-300 bg-[var(--bg-control)] border border-[var(--border-main)] rounded">
              Sortie Principale
            </div>
          )}
        </div>
      )}

      {/* Gain Rotary Knob & Input Pair Stereo/Mono Split — INPUT STRIPS ONLY */}
      <div className="flex flex-col items-center justify-center gap-1.5 py-1 border-b border-[var(--border-main)]">
        {isInput ? (
          <>
            <RotaryKnob
              label="GAIN"
              value={strip.gainDb}
              min={-12}
              max={24}
              defaultValue={0}
              unit="dB"
              accentColor="#F59E0B"
              size={36}
              onChange={(val) =>
                onUpdate(strip.id, (s) => ({ ...s, gainDb: val }))
              }
            />
            {onToggleInputPair && (
              <button
                type="button"
                onClick={() => onToggleInputPair(inPairIndex)}
                className={`flex items-center justify-center gap-1 w-full rounded px-1.5 py-0.5 text-[10px] font-medium border cursor-pointer transition-colors ${
                  isInputStereo
                    ? 'bg-amber-500/15 border-amber-500/40 text-amber-300 hover:bg-amber-500/25'
                    : 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/25'
                }`}
                title={
                  isInputStereo
                    ? 'Séparer cette paire en 2 tranches Mono indépendantes (double le nombre d’entrées)'
                    : 'Recombiner en 1 tranche Stéréo'
                }
              >
                <Split className="w-2.5 h-2.5 shrink-0" />
                <span>{isInputStereo ? 'Stéréo → Mono' : 'Mono → Stéréo'}</span>
              </button>
            )}

            {/* Routage MIDI (Appareil + Canal) — PISTES D'ENTRÉE UNIQUEMENT */}
            <div className="w-full flex flex-col gap-1 pt-1 border-t border-[var(--border-main)]">
              <select
                aria-label={`Appareil MIDI ${strip.name}`}
                value={strip.midiDevice}
                onChange={(e) =>
                  onUpdate(strip.id, (s) => ({ ...s, midiDevice: e.target.value }))
                }
                className="w-full bg-[var(--bg-control)] border border-emerald-500/35 rounded px-1.5 py-0.5 text-[10px] text-emerald-200 focus:outline-none focus:border-emerald-400 truncate"
                title="Appareil MIDI source pour cette tranche d'entrée"
              >
                <option value="all">MIDI : Tous</option>
                <option value="none">MIDI : Aucun</option>
                {midiPorts.map((port) => (
                  <option key={port.id} value={port.name}>
                    MIDI : {port.name}
                  </option>
                ))}
                {strip.midiDevice !== 'all' &&
                  strip.midiDevice !== 'none' &&
                  !midiPorts.some((p) => p.name === strip.midiDevice) && (
                    <option value={strip.midiDevice}>MIDI : {strip.midiDevice}</option>
                  )}
              </select>

              <select
                aria-label={`Canal MIDI ${strip.name}`}
                value={strip.midiChannel === null ? 'off' : String(strip.midiChannel)}
                onChange={(e) => {
                  const val = e.target.value;
                  onUpdate(strip.id, (s) => ({
                    ...s,
                    midiChannel: val === 'off' ? null : Number(val),
                  }));
                }}
                className="w-full bg-[var(--bg-control)] border border-[var(--border-main)] rounded px-1.5 py-0.5 text-[10px] text-[var(--text-main)] focus:outline-none focus:border-emerald-400 truncate"
                title="Canal MIDI reçu par cette tranche d'entrée"
              >
                <option value="off">Canal MIDI : OFF</option>
                <option value="0">Canal MIDI : OMNI (1-16)</option>
                {Array.from({ length: 16 }, (_, chIdx) => {
                  const ch = chIdx + 1;
                  return (
                    <option key={`mch-${ch}`} value={String(ch)}>
                      Canal MIDI : CH {ch}
                    </option>
                  );
                })}
              </select>
            </div>
          </>
        ) : (
          <div className="h-[104px] flex flex-col items-center justify-center text-center px-1">
            <span className="text-[10px] font-medium text-slate-400">
              {isMaster
                ? 'Bus Master'
                : isAuxStereo
                  ? 'Bus Aux Stéréo'
                  : 'Bus Aux Mono'}
            </span>
            <span className="text-[10px] font-mono text-slate-500">
              {isMaster ? 'Sans Gain / Solo' : 'Sans Gain'}
            </span>
          </div>
        )}
      </div>

      {/* 5 Insert Plugin Slots (VST2 / VST3 / Apple AU) */}
      <div className="flex flex-col gap-1 border-b border-[var(--border-main)] pb-2">
        <div className="flex items-center justify-between text-[10px] text-[var(--text-muted)] px-0.5">
          <span className="font-medium">Inserts</span>
          <span className="font-mono tabular-nums">
            {activeInsertCount}/{MAX_INSERTS_PER_STRIP}
          </span>
        </div>

        <div className="flex flex-col gap-1">
          {strip.inserts.map((slot) => {
            const hasPlugin = slot.plugin !== null;
            return (
              <div
                key={slot.slotIndex}
                className={`flex items-center gap-1 rounded border px-1 py-0.5 text-[10px] transition-colors ${
                  hasPlugin
                    ? slot.bypassed
                      ? 'bg-[var(--bg-control)] border-[var(--border-main)] text-[var(--text-muted)]'
                      : 'bg-sky-500/12 border-sky-500/45 text-[var(--text-main)]'
                    : 'bg-[var(--bg-control)] border-[var(--border-main)] text-[var(--text-muted)] hover:border-slate-500'
                }`}
              >
                <button
                  type="button"
                  onClick={() => onOpenInsertModal(strip.id, slot.slotIndex)}
                  className="flex-1 flex items-center gap-1 text-left truncate min-w-0 py-0.5 cursor-pointer focus:outline-none"
                  title={
                    hasPlugin
                      ? `${slot.plugin!.name} (${slot.plugin!.format}) — Cliquer pour éditer`
                      : `Ajouter un plugin AU/VST3/VST2 (Slot ${slot.slotIndex + 1}/5)`
                  }
                >
                  {hasPlugin ? (
                    <>
                      <span
                        className={`font-mono text-[9px] shrink-0 ${
                          slot.plugin!.format === 'AU'
                            ? 'text-amber-400'
                            : slot.plugin!.format === 'VST3'
                              ? 'text-sky-400'
                              : 'text-emerald-400'
                        }`}
                      >
                        {slot.plugin!.format}
                      </span>
                      <span className="truncate">{slot.plugin!.name}</span>
                    </>
                  ) : (
                    <span className="flex items-center gap-1 text-slate-500">
                      <Plus className="w-2.5 h-2.5 shrink-0" />
                      <span>Slot {slot.slotIndex + 1}</span>
                    </span>
                  )}
                </button>

                {hasPlugin && (
                  <>
                    <button
                      type="button"
                      aria-label={`Bypass ${slot.plugin!.name}`}
                      onClick={() =>
                        onUpdate(strip.id, (s) => ({
                          ...s,
                          inserts: s.inserts.map((ins) =>
                            ins.slotIndex === slot.slotIndex
                              ? { ...ins, bypassed: !ins.bypassed }
                              : ins
                          ),
                        }))
                      }
                      className={`p-0.5 rounded cursor-pointer ${
                        slot.bypassed
                          ? 'text-slate-600 hover:text-slate-400'
                          : 'text-emerald-400 hover:text-emerald-300'
                      }`}
                      title={slot.bypassed ? 'Activer le plugin' : 'Bypass'}
                    >
                      <Power className="w-2.5 h-2.5" />
                    </button>
                    <button
                      type="button"
                      aria-label={`Retirer ${slot.plugin!.name}`}
                      onClick={() =>
                        onUpdate(strip.id, (s) => ({
                          ...s,
                          inserts: s.inserts.map((ins) =>
                            ins.slotIndex === slot.slotIndex
                              ? { ...ins, plugin: null, bypassed: false, params: {} }
                              : ins
                          ),
                        }))
                      }
                      className="p-0.5 rounded text-slate-500 hover:text-red-400 cursor-pointer"
                      title="Retirer le plugin"
                    >
                      <X className="w-2.5 h-2.5" />
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* 5-Band Rotary EQ (with 5th Mid 1 kHz knob centered in the middle) */}
      <div className="flex flex-col gap-1.5 border-b border-[var(--border-main)] pb-2">
        <div className="flex items-center justify-between px-0.5">
          <span className="text-[10px] font-medium text-[var(--text-muted)]">EQ 5 Bandes</span>
          <button
            type="button"
            onClick={() =>
              onUpdate(strip.id, (s) => ({
                ...s,
                eq: { ...s.eq, bypassed: !s.eq.bypassed },
              }))
            }
            className={`text-[9px] font-mono px-1.5 py-0.5 rounded border cursor-pointer transition-colors ${
              strip.eq.bypassed
                ? 'bg-[var(--bg-control)] border-[var(--border-main)] text-[var(--text-muted)]'
                : 'bg-sky-500/15 border-sky-500/40 text-sky-300'
            }`}
          >
            {strip.eq.bypassed ? 'OFF' : 'ON'}
          </button>
        </div>

        <div className="grid grid-cols-2 gap-y-1 gap-x-1 place-items-center">
          <RotaryKnob
            label="HI 10k"
            value={strip.eq.highGainDb}
            min={-15}
            max={15}
            defaultValue={0}
            accentColor={strip.eq.bypassed ? '#475569' : '#38BDF8'}
            size={30}
            onChange={(val) =>
              onUpdate(strip.id, (s) => ({
                ...s,
                eq: { ...s.eq, highGainDb: val },
              }))
            }
          />
          <RotaryKnob
            label="HM 2.5k"
            value={strip.eq.highMidGainDb}
            min={-15}
            max={15}
            defaultValue={0}
            accentColor={strip.eq.bypassed ? '#475569' : '#38BDF8'}
            size={30}
            onChange={(val) =>
              onUpdate(strip.id, (s) => ({
                ...s,
                eq: { ...s.eq, highMidGainDb: val },
              }))
            }
          />
        </div>

        {/* 5th EQ knob (Mid 1 kHz) centered */}
        <div className="flex justify-center">
          <RotaryKnob
            label="MID 1k"
            value={strip.eq.midGainDb}
            min={-15}
            max={15}
            defaultValue={0}
            accentColor={strip.eq.bypassed ? '#475569' : '#7DD3FC'}
            size={32}
            onChange={(val) =>
              onUpdate(strip.id, (s) => ({
                ...s,
                eq: { ...s.eq, midGainDb: val },
              }))
            }
          />
        </div>

        <div className="grid grid-cols-2 gap-y-1 gap-x-1 place-items-center">
          <RotaryKnob
            label="LM 400"
            value={strip.eq.lowMidGainDb}
            min={-15}
            max={15}
            defaultValue={0}
            accentColor={strip.eq.bypassed ? '#475569' : '#38BDF8'}
            size={30}
            onChange={(val) =>
              onUpdate(strip.id, (s) => ({
                ...s,
                eq: { ...s.eq, lowMidGainDb: val },
              }))
            }
          />
          <RotaryKnob
            label="LO 80"
            value={strip.eq.lowGainDb}
            min={-15}
            max={15}
            defaultValue={0}
            accentColor={strip.eq.bypassed ? '#475569' : '#38BDF8'}
            size={30}
            onChange={(val) =>
              onUpdate(strip.id, (s) => ({
                ...s,
                eq: { ...s.eq, lowGainDb: val },
              }))
            }
          />
        </div>
      </div>

      {/* Dynamic Auxiliary Rotary Sends (4 Stereo or up to 8 Mono) — OMITTED ON MASTER STRIP */}
      {!isMaster ? (
        <div className="flex flex-col gap-1.5 border-b border-[var(--border-main)] pb-2">
          <span className="text-[10px] font-medium text-[var(--text-muted)] px-0.5">
            Envois Aux ({activeAuxSends.length})
          </span>
          <div className="grid grid-cols-2 gap-y-1.5 gap-x-1 place-items-center">
            {activeAuxSends.map((sendItem) => (
              <RotaryKnob
                key={`${strip.id}-aux-${sendItem.auxIdx}`}
                label={sendItem.label}
                value={strip.auxSends[sendItem.auxIdx] ?? 0}
                min={0}
                max={100}
                defaultValue={0}
                unit="%"
                bipolar={false}
                accentColor="#10B981"
                size={30}
                onChange={(val) =>
                  onUpdate(strip.id, (s) => {
                    const nextAux = [...s.auxSends] as AuxSendsTuple;
                    nextAux[sendItem.auxIdx] = val;
                    return { ...s, auxSends: nextAux };
                  })
                }
              />
            ))}
          </div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center border-b border-[var(--border-main)] py-3 text-center">
          <span className="text-[10px] font-mono text-[var(--text-muted)] px-1">
            Sortie Sommation Principale
          </span>
        </div>
      )}

      {/* Push Solo (absent on Master) & Push Mute */}
      <div className="flex items-center gap-1.5 mt-auto">
        {!isMaster && (
          <button
            type="button"
            aria-pressed={strip.solo}
            onClick={() =>
              onUpdate(strip.id, (s) => ({ ...s, solo: !s.solo }))
            }
            className={`flex-1 py-1.5 rounded text-[11px] font-bold tracking-wide border transition-colors cursor-pointer whitespace-nowrap ${
              strip.solo
                ? 'bg-amber-400 text-slate-950 border-amber-300'
                : 'bg-[var(--bg-control-alt)] text-[var(--text-main)] border-[var(--border-strong)] hover:border-amber-500/50'
            }`}
          >
            SOLO
          </button>
        )}
        <button
          type="button"
          aria-pressed={strip.mute}
          onClick={() =>
            onUpdate(strip.id, (s) => ({ ...s, mute: !s.mute }))
          }
          className={`flex-1 py-1.5 rounded text-[11px] font-bold tracking-wide border transition-colors cursor-pointer whitespace-nowrap ${
            strip.mute
              ? 'bg-red-500 text-white border-red-400'
              : 'bg-[var(--bg-control-alt)] text-[var(--text-main)] border-[var(--border-strong)] hover:border-red-500/50'
          }`}
        >
          MUTE
        </button>
      </div>

      {/* Volume Fader & VU Meter */}
      <div className="flex items-center justify-center gap-2 pt-1">
        <Fader
          valueDb={strip.volumeDb}
          label={`Volume ${strip.name}`}
          onChange={(db) =>
            onUpdate(strip.id, (s) => ({ ...s, volumeDb: db }))
          }
          height={152}
        />
        <VuMeter level={meter} height={152} />
      </div>

      {/* Fader Value Readout */}
      <div className="text-center font-mono tabular-nums text-[11px] text-[var(--text-main)] bg-[var(--bg-control)] border border-[var(--border-main)] rounded py-0.5">
        {strip.volumeDb <= -59.5
          ? '-∞ dB'
          : `${strip.volumeDb > 0 ? '+' : ''}${strip.volumeDb.toFixed(1)} dB`}
      </div>
    </section>
  );
};
