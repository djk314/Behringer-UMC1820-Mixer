import React from 'react';
import { Power, Plus, X } from 'lucide-react';
import {
  AUX_LABELS,
  InputSourceKind,
  MAX_INSERTS_PER_STRIP,
  MeterLevel,
  StripState,
} from '../types/mixer';
import { Fader } from './Fader';
import { RotaryKnob } from './RotaryKnob';
import { VuMeter } from './VuMeter';

interface ChannelStripProps {
  strip: StripState;
  meter: MeterLevel;
  anySoloActive: boolean;
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

export const ChannelStrip: React.FC<ChannelStripProps> = ({
  strip,
  meter,
  anySoloActive,
  onUpdate,
  onOpenInsertModal,
}) => {
  const isMaster = strip.kind === 'master';
  const isAux = strip.kind === 'aux';
  const isInput = strip.kind === 'input';

  const isDimmedBySolo = !isMaster && anySoloActive && !strip.solo;

  const stripBg = isMaster
    ? 'bg-[#19161D] border-amber-500/30'
    : isAux
      ? 'bg-[#121924] border-sky-500/25'
      : 'bg-[#131720] border-[#232936]';

  const activeInsertCount = strip.inserts.filter((s) => s.plugin !== null).length;

  return (
    <section
      aria-label={`Tranche ${strip.name}`}
      className={`flex flex-col w-[132px] shrink-0 border rounded-md p-2.5 gap-2 transition-opacity ${stripBg} ${
        isDimmedBySolo ? 'opacity-65' : 'opacity-100'
      }`}
    >
      {/* Strip Header */}
      <div className="flex flex-col gap-0.5 border-b border-[#232936] pb-2">
        <div className="flex items-center justify-between gap-1">
          <input
            type="text"
            value={strip.name}
            maxLength={14}
            aria-label={`Nom de la tranche ${strip.name}`}
            onChange={(e) =>
              onUpdate(strip.id, (s) => ({ ...s, name: e.target.value }))
            }
            className="w-full bg-transparent text-xs font-semibold text-slate-100 focus:outline-none focus:bg-[#1B212E] rounded px-1 -mx-1 truncate"
          />
        </div>
        <div className="text-[10px] font-mono text-slate-400 truncate">
          {strip.hardwareChannelLabel}
        </div>
      </div>

      {/* Input Source Selector (Input strips only, for live browser audio routing) */}
      {isInput ? (
        <select
          aria-label={`Source audio ${strip.name}`}
          value={strip.source}
          onChange={(e) =>
            onUpdate(strip.id, (s) => ({
              ...s,
              source: e.target.value as InputSourceKind,
            }))
          }
          className="w-full bg-[#0B0E14] border border-[#232936] rounded px-1.5 py-1 text-[10px] text-slate-300 focus:outline-none focus:border-sky-500 truncate"
        >
          {SOURCE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      ) : (
        <div className="h-[24px] flex items-center justify-center text-[10px] font-mono text-slate-400 bg-[#0B0E14]/60 border border-[#232936]/70 rounded">
          {isMaster ? 'Sortie Principale' : 'Bus Stéréo'}
        </div>
      )}

      {/* Gain Rotary Knob — INPUT STRIPS ONLY (absent on Aux & Master) */}
      <div className="flex items-center justify-center py-1 border-b border-[#232936]">
        {isInput ? (
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
        ) : (
          <div className="h-[60px] flex flex-col items-center justify-center text-center px-1">
            <span className="text-[10px] font-medium text-slate-400">
              {isMaster ? 'Bus Master' : 'Bus Aux Stéréo'}
            </span>
            <span className="text-[10px] font-mono text-slate-500">
              {isMaster ? 'Sans Gain / Solo' : 'Sans Gain'}
            </span>
          </div>
        )}
      </div>

      {/* 5 Insert Plugin Slots (VST2 / VST3 / Apple AU) */}
      <div className="flex flex-col gap-1 border-b border-[#232936] pb-2">
        <div className="flex items-center justify-between text-[10px] text-slate-400 px-0.5">
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
                      ? 'bg-[#10141D] border-[#232936] text-slate-500'
                      : 'bg-[#1A2232] border-sky-500/40 text-slate-100'
                    : 'bg-[#0B0E14]/70 border-[#1E2430] text-slate-500 hover:border-slate-600'
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

      {/* 4-Band Rotary EQ */}
      <div className="flex flex-col gap-1.5 border-b border-[#232936] pb-2">
        <div className="flex items-center justify-between px-0.5">
          <span className="text-[10px] font-medium text-slate-400">EQ 4 Bandes</span>
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
                ? 'bg-[#0B0E14] border-[#232936] text-slate-500'
                : 'bg-sky-500/15 border-sky-500/40 text-sky-300'
            }`}
          >
            {strip.eq.bypassed ? 'OFF' : 'ON'}
          </button>
        </div>

        <div className="grid grid-cols-2 gap-y-1.5 gap-x-1 place-items-center">
          <RotaryKnob
            label="HI 10k"
            value={strip.eq.highGainDb}
            min={-15}
            max={15}
            defaultValue={0}
            accentColor={strip.eq.bypassed ? '#475569' : '#38BDF8'}
            size={32}
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
            size={32}
            onChange={(val) =>
              onUpdate(strip.id, (s) => ({
                ...s,
                eq: { ...s.eq, highMidGainDb: val },
              }))
            }
          />
          <RotaryKnob
            label="LM 400"
            value={strip.eq.lowMidGainDb}
            min={-15}
            max={15}
            defaultValue={0}
            accentColor={strip.eq.bypassed ? '#475569' : '#38BDF8'}
            size={32}
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
            size={32}
            onChange={(val) =>
              onUpdate(strip.id, (s) => ({
                ...s,
                eq: { ...s.eq, lowGainDb: val },
              }))
            }
          />
        </div>
      </div>

      {/* 4 Auxiliary Rotary Sends — OMITTED ON MASTER STRIP */}
      {!isMaster ? (
        <div className="flex flex-col gap-1.5 border-b border-[#232936] pb-2">
          <span className="text-[10px] font-medium text-slate-400 px-0.5">
            Envois Auxiliaires
          </span>
          <div className="grid grid-cols-2 gap-y-1.5 gap-x-1 place-items-center">
            {AUX_LABELS.map((auxLabel, auxIdx) => (
              <RotaryKnob
                key={auxLabel}
                label={auxLabel.replace('Aux ', 'A ')}
                value={strip.auxSends[auxIdx]}
                min={0}
                max={100}
                defaultValue={0}
                unit="%"
                bipolar={false}
                accentColor="#10B981"
                size={30}
                onChange={(val) =>
                  onUpdate(strip.id, (s) => {
                    const nextAux: [number, number, number, number] = [...s.auxSends] as [
                      number,
                      number,
                      number,
                      number,
                    ];
                    nextAux[auxIdx] = val;
                    return { ...s, auxSends: nextAux };
                  })
                }
              />
            ))}
          </div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center border-b border-[#232936] py-3 text-center">
          <span className="text-[10px] font-mono text-slate-500 px-1">
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
                : 'bg-[#1A202C] text-slate-300 border-[#2D3545] hover:border-amber-500/50'
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
              : 'bg-[#1A202C] text-slate-300 border-[#2D3545] hover:border-red-500/50'
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
      <div className="text-center font-mono tabular-nums text-[11px] text-slate-200 bg-[#0B0E14] border border-[#232936] rounded py-0.5">
        {strip.volumeDb <= -59.5
          ? '-∞ dB'
          : `${strip.volumeDb > 0 ? '+' : ''}${strip.volumeDb.toFixed(1)} dB`}
      </div>
    </section>
  );
};
