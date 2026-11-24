import React from 'react';
import { AUX_LABELS, StripState } from '../types/mixer';

interface RoutingMatrixViewProps {
  strips: StripState[];
  onUpdateStrip: (stripId: string, updater: (prev: StripState) => StripState) => void;
}

export const RoutingMatrixView: React.FC<RoutingMatrixViewProps> = ({
  strips,
  onUpdateStrip,
}) => {
  const inputStrips = strips.filter((s) => s.kind === 'input');
  const auxStrips = strips.filter((s) => s.kind === 'aux');
  const masterStrip = strips.find((s) => s.kind === 'master');

  return (
    <div className="flex flex-col gap-6">
      {/* Architecture Summary */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="bg-[#131720] border border-[#232936] rounded-md p-4">
          <h2 className="text-sm font-semibold text-slate-100">
            Chaîne Audio CoreAudio / ALSA
          </h2>
          <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">
            L'application Rust utilise <span className="font-mono text-slate-200">cpal</span> sur le pilote
            CoreAudio (macOS) ou ALSA/JACK (Linux) sans accès matériel direct exclusif. Elle s'intègre avec Bitwig Studio via un périphérique agrégé ou BlackHole 16ch.
          </p>
          <div className="mt-3 pt-3 border-t border-[#232936] text-xs font-mono text-slate-300 space-y-1">
            <div>Entrées 1–8 → Gain → 5 Inserts → EQ 4B</div>
            <div>→ Mute/Solo → Fader → Bus Master + 4 Aux</div>
          </div>
        </div>

        <div className="bg-[#131720] border border-[#232936] rounded-md p-4">
          <h2 className="text-sm font-semibold text-slate-100">
            Hébergement Plugins (5 Inserts max)
          </h2>
          <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">
            Chaque tranche (8 entrées, 4 sorties Aux et Master) dispose exactement de 5 emplacements en série compatibles Apple AudioUnit, VST3 et VST2.
          </p>
          <div className="mt-3 pt-3 border-t border-[#232936] text-[11px] font-mono text-slate-300 space-y-1">
            <div>macOS : /Library/Audio/Plug-Ins/Components (.component)</div>
            <div>macOS : /Library/Audio/Plug-Ins/VST3 &amp; VST</div>
            <div>Linux : ~/.vst3, /usr/lib/vst3, ~/.vst (.so)</div>
          </div>
        </div>

        <div className="bg-[#131720] border border-[#232936] rounded-md p-4">
          <h2 className="text-sm font-semibold text-slate-100">
            Assignation Sorties UMC1820
          </h2>
          <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">
            Les 4 bus auxiliaires stéréo correspondent aux 4 paires de sorties ligne arrière de la Behringer UMC1820. La tranche Master pilote le bus principal (sans Gain ni Solo).
          </p>
          <div className="mt-3 pt-3 border-t border-[#232936] text-xs font-mono text-slate-300 space-y-1">
            <div>Aux 1/2 → Line Out 1-2 · Aux 3/4 → Line Out 3-4</div>
            <div>Aux 5/6 → Line Out 5-6 · Aux 7/8 → Line Out 7-8</div>
          </div>
        </div>
      </div>

      {/* Interactive Aux Send Matrix Table */}
      <div className="bg-[#131720] border border-[#232936] rounded-md overflow-hidden">
        <div className="px-4 py-3 border-b border-[#232936] flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-slate-100">
              Matrice des Envois Auxiliaires (8 Entrées → 4 Sorties Stéréo)
            </h3>
            <p className="text-xs text-slate-400">
              Ajustez les niveaux d'envoi vers les paires stéréo 1/2, 3/4, 5/6 et 7/8 de l'UMC1820.
            </p>
          </div>
          {masterStrip && (
            <div className="text-xs font-mono tabular-nums text-slate-300">
              Master : {masterStrip.volumeDb.toFixed(1)} dB · {masterStrip.mute ? 'MUTE' : 'ACTIF'}
            </div>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-[#232936] bg-[#0F131B] text-slate-400">
                <th className="py-2.5 px-4 font-medium">Tranche d'entrée</th>
                <th className="py-2.5 px-3 font-medium">Inserts actifs</th>
                <th className="py-2.5 px-3 font-medium text-right">Gain</th>
                {AUX_LABELS.map((label, idx) => (
                  <th key={label} className="py-2.5 px-4 font-medium">
                    {label} ({auxStrips[idx]?.name ?? label})
                  </th>
                ))}
                <th className="py-2.5 px-4 font-medium text-right">Volume</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#232936]">
              {inputStrips.map((strip) => {
                const activePlugins = strip.inserts.filter((s) => s.plugin !== null);
                return (
                  <tr key={strip.id} className="hover:bg-[#171C28] transition-colors">
                    <td className="py-2.5 px-4 font-medium text-slate-100">
                      {strip.name}
                      <span className="ml-2 text-[11px] font-mono text-slate-500">
                        {strip.hardwareChannelLabel}
                      </span>
                    </td>
                    <td className="py-2.5 px-3 font-mono text-[11px] text-slate-300">
                      {activePlugins.length}/5
                      {activePlugins.length > 0 && (
                        <span className="ml-2 text-slate-400">
                          ({activePlugins.map((p) => p.plugin?.format).join(', ')})
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 px-3 font-mono tabular-nums text-right text-amber-300">
                      {strip.gainDb > 0 ? '+' : ''}
                      {strip.gainDb.toFixed(1)} dB
                    </td>
                    {AUX_LABELS.map((label, auxIdx) => (
                      <td key={label} className="py-2.5 px-4">
                        <div className="flex items-center gap-2">
                          <input
                            type="range"
                            min={0}
                            max={100}
                            value={strip.auxSends[auxIdx]}
                            aria-label={`${strip.name} vers ${label}`}
                            onChange={(e) => {
                              const val = Number(e.target.value);
                              onUpdateStrip(strip.id, (s) => {
                                const next: [number, number, number, number] = [
                                  ...s.auxSends,
                                ] as [number, number, number, number];
                                next[auxIdx] = val;
                                return { ...s, auxSends: next };
                              });
                            }}
                            className="w-24 accent-emerald-400 cursor-pointer"
                          />
                          <span className="font-mono tabular-nums text-[11px] text-slate-300 w-9 text-right">
                            {Math.round(strip.auxSends[auxIdx])}%
                          </span>
                        </div>
                      </td>
                    ))}
                    <td className="py-2.5 px-4 font-mono tabular-nums text-right text-slate-200">
                      {strip.volumeDb <= -59.5 ? '-∞' : `${strip.volumeDb.toFixed(1)}`} dB
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
