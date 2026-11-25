import React from 'react';
import {
  AuxPairStereoState,
  AuxSendsTuple,
  MAX_AUX_PAIRS,
  StripState,
  formatInputRouteLabel,
  formatOutputRouteLabel,
} from '../types/mixer';

interface RoutingMatrixViewProps {
  strips: StripState[];
  auxPairStereo: AuxPairStereoState;
  onUpdateStrip: (stripId: string, updater: (prev: StripState) => StripState) => void;
  onToggleAuxPair: (pairIndex: number) => void;
}

interface AuxMatrixColumn {
  auxIdx: number;
  pairIndex: number;
  shortLabel: string;
  stripName: string;
  isStereo: boolean;
  outputLabel: string;
}

export const RoutingMatrixView: React.FC<RoutingMatrixViewProps> = ({
  strips,
  auxPairStereo,
  onUpdateStrip,
  onToggleAuxPair,
}) => {
  const inputStrips = strips.filter((s) => s.kind === 'input');
  const auxStrips = strips.filter((s) => s.kind === 'aux');
  const masterStrip = strips.find((s) => s.kind === 'master');

  const activeAuxColumns: AuxMatrixColumn[] = [];
  for (let p = 0; p < MAX_AUX_PAIRS; p++) {
    const ch1 = p * 2 + 1;
    const ch2 = p * 2 + 2;
    if (auxPairStereo[p]) {
      const strip = auxStrips[p * 2];
      activeAuxColumns.push({
        auxIdx: p * 2,
        pairIndex: p,
        shortLabel: `Aux ${ch1}/${ch2}`,
        stripName: strip?.name ?? `Aux ${ch1}/${ch2}`,
        isStereo: true,
        outputLabel: strip ? formatOutputRouteLabel(strip.outputRoute) : `Out ${ch1}/${ch2}`,
      });
    } else {
      const stripL = auxStrips[p * 2];
      const stripR = auxStrips[p * 2 + 1];
      activeAuxColumns.push({
        auxIdx: p * 2,
        pairIndex: p,
        shortLabel: `Aux ${ch1}`,
        stripName: stripL?.name ?? `Aux ${ch1}`,
        isStereo: false,
        outputLabel: stripL ? formatOutputRouteLabel(stripL.outputRoute) : `Out ${ch1}`,
      });
      activeAuxColumns.push({
        auxIdx: p * 2 + 1,
        pairIndex: p,
        shortLabel: `Aux ${ch2}`,
        stripName: stripR?.name ?? `Aux ${ch2}`,
        isStereo: false,
        outputLabel: stripR ? formatOutputRouteLabel(stripR.outputRoute) : `Out ${ch2}`,
      });
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Architecture Summary */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="bg-[#131720] border border-[#232936] rounded-md p-4">
          <h2 className="text-sm font-semibold text-slate-100">
            Chaîne Audio Multi-Cartes &amp; EQ 5 Bandes
          </h2>
          <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">
            Chaque tranche d'entrée et de sortie dispose d'un sélecteur matériel libre (<span className="font-mono text-slate-200">In 1..N</span>, <span className="font-mono text-slate-200">Out 1..N</span>) permettant d'utiliser toute interface audio CoreAudio ou ALSA/JACK en plus de l'UMC1820.
          </p>
          <div className="mt-3 pt-3 border-t border-[#232936] text-xs font-mono text-slate-300 space-y-1">
            <div>Entrées 1–8 → Gain → 5 Inserts → EQ 5B (MID 1 kHz)</div>
            <div>→ Mute/Solo → Fader → Master + Lecteur MP3/WAV</div>
          </div>
        </div>

        <div className="bg-[#131720] border border-[#232936] rounded-md p-4">
          <h2 className="text-sm font-semibold text-slate-100">
            Plugins (5 Inserts) &amp; Sets (.umcset)
          </h2>
          <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">
            Chaque tranche (8 entrées, jusqu'à 8 bus Aux et Master) accepte 5 inserts Apple AudioUnit, VST3 ou VST2, sauvegardables avec tous les réglages dans un fichier de set.
          </p>
          <div className="mt-3 pt-3 border-t border-[#232936] text-[11px] font-mono text-slate-300 space-y-1">
            <div>macOS : /Library/Audio/Plug-Ins/Components, VST3, VST</div>
            <div>Linux : ~/.vst3, /usr/lib/vst3, ~/.vst (.so)</div>
            <div>Sets : Export / Import complet (.umcset.json)</div>
          </div>
        </div>

        <div className="bg-[#131720] border border-[#232936] rounded-md p-4">
          <h2 className="text-sm font-semibold text-slate-100">
            Bus Auxiliaires Stéréo / Mono
          </h2>
          <p className="text-xs text-slate-400 mt-1.5 leading-relaxed">
            Les 4 paires auxiliaires (1/2, 3/4, 5/6, 7/8) peuvent rester liées en Stéréo ou être séparées individuellement en 2 bus Mono indépendants (jusqu'à 8 départs Mono).
          </p>
          <div className="mt-3 pt-3 border-t border-[#232936] flex flex-wrap gap-1.5">
            {Array.from({ length: MAX_AUX_PAIRS }, (_, p) => {
              const stereo = auxPairStereo[p];
              return (
                <button
                  key={`pair-toggle-${p}`}
                  type="button"
                  onClick={() => onToggleAuxPair(p)}
                  className={`px-2 py-1 rounded text-[11px] font-mono border cursor-pointer transition-colors ${
                    stereo
                      ? 'bg-sky-500/15 border-sky-500/40 text-sky-300 hover:bg-sky-500/25'
                      : 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/25'
                  }`}
                >
                  {p * 2 + 1}/{p * 2 + 2}: {stereo ? 'Stéréo' : '2× Mono'}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Interactive Aux Send Matrix Table */}
      <div className="bg-[#131720] border border-[#232936] rounded-md overflow-hidden">
        <div className="px-4 py-3 border-b border-[#232936] flex items-center justify-between flex-wrap gap-2">
          <div>
            <h3 className="text-sm font-semibold text-slate-100">
              Matrice des Envois Auxiliaires (8 Entrées → {activeAuxColumns.length} Bus actifs)
            </h3>
            <p className="text-xs text-slate-400">
              Ajustez les départs et commutez chaque paire entre mode Stéréo et Mono séparé.
            </p>
          </div>
          {masterStrip && (
            <div className="text-xs font-mono tabular-nums text-slate-300">
              Master ({formatOutputRouteLabel(masterStrip.outputRoute)}) :{' '}
              {masterStrip.volumeDb.toFixed(1)} dB · {masterStrip.mute ? 'MUTE' : 'ACTIF'}
            </div>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-[#232936] bg-[#0F131B] text-slate-400">
                <th className="py-2.5 px-4 font-medium">Tranche d'entrée</th>
                <th className="py-2.5 px-3 font-medium">Assignation HW</th>
                <th className="py-2.5 px-3 font-medium">Inserts</th>
                <th className="py-2.5 px-3 font-medium text-right">Gain</th>
                {activeAuxColumns.map((col) => (
                  <th key={`col-${col.auxIdx}`} className="py-2.5 px-3 font-medium">
                    <div className="flex flex-col gap-0.5">
                      <div className="flex items-center gap-1.5">
                        <span className="text-slate-200">{col.stripName}</span>
                        <span
                          className={`text-[9px] font-mono px-1 rounded border ${
                            col.isStereo
                              ? 'border-sky-500/40 text-sky-300 bg-sky-500/10'
                              : 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10'
                          }`}
                        >
                          {col.isStereo ? 'ST' : 'MONO'}
                        </span>
                      </div>
                      <span className="text-[10px] font-mono text-slate-500">
                        {col.outputLabel}
                      </span>
                    </div>
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
                    <td className="py-2.5 px-4 font-medium text-slate-100 whitespace-nowrap">
                      {strip.name}
                    </td>
                    <td className="py-2.5 px-3 font-mono text-[11px] text-amber-300/90 whitespace-nowrap">
                      {formatInputRouteLabel(strip.inputRoute)}
                    </td>
                    <td className="py-2.5 px-3 font-mono text-[11px] text-slate-300 whitespace-nowrap">
                      {activePlugins.length}/5
                      {activePlugins.length > 0 && (
                        <span className="ml-1.5 text-slate-400">
                          ({activePlugins.map((p) => p.plugin?.format).join(', ')})
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 px-3 font-mono tabular-nums text-right text-amber-300 whitespace-nowrap">
                      {strip.gainDb > 0 ? '+' : ''}
                      {strip.gainDb.toFixed(1)} dB
                    </td>
                    {activeAuxColumns.map((col) => (
                      <td key={`cell-${strip.id}-${col.auxIdx}`} className="py-2.5 px-3">
                        <div className="flex items-center gap-2">
                          <input
                            type="range"
                            min={0}
                            max={100}
                            value={strip.auxSends[col.auxIdx] ?? 0}
                            aria-label={`${strip.name} vers ${col.shortLabel}`}
                            onChange={(e) => {
                              const val = Number(e.target.value);
                              onUpdateStrip(strip.id, (s) => {
                                const next = [...s.auxSends] as AuxSendsTuple;
                                next[col.auxIdx] = val;
                                return { ...s, auxSends: next };
                              });
                            }}
                            className="w-20 accent-emerald-400 cursor-pointer"
                          />
                          <span className="font-mono tabular-nums text-[11px] text-slate-300 w-9 text-right">
                            {Math.round(strip.auxSends[col.auxIdx] ?? 0)}%
                          </span>
                        </div>
                      </td>
                    ))}
                    <td className="py-2.5 px-4 font-mono tabular-nums text-right text-slate-200 whitespace-nowrap">
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
