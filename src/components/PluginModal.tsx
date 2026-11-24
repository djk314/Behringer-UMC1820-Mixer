import React, { useMemo, useState } from 'react';
import { Power, RotateCcw, Search, Sliders, Trash2, X } from 'lucide-react';
import {
  MAX_INSERTS_PER_STRIP,
  PLUGIN_CATALOG,
  PluginDescriptor,
  PluginFormat,
  StripState,
} from '../types/mixer';

interface PluginModalProps {
  strip: StripState | null;
  slotIndex: number | null;
  onClose: () => void;
  onSelectPlugin: (stripId: string, slotIndex: number, plugin: PluginDescriptor | null) => void;
  onUpdateParam: (stripId: string, slotIndex: number, key: string, value: number) => void;
  onToggleBypass?: (stripId: string, slotIndex: number) => void;
  onResetParams?: (stripId: string, slotIndex: number) => void;
}

interface ParamMeta {
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
}

const PARAM_METADATA: Record<string, ParamMeta> = {
  threshold: { label: 'Seuil (Threshold)', min: -40, max: 0, step: 0.5, unit: 'dB' },
  ratio: { label: 'Ratio', min: 1, max: 20, step: 0.5, unit: ':1' },
  attackMs: { label: 'Attaque', min: 1, max: 100, step: 1, unit: 'ms' },
  releaseMs: { label: 'Relâchement', min: 20, max: 500, step: 5, unit: 'ms' },
  drive: { label: 'Drive', min: 1, max: 100, step: 1, unit: '%' },
  mix: { label: 'Mix Dry/Wet', min: 0, max: 100, step: 1, unit: '%' },
  freq: { label: 'Fréquence coupure', min: 20, max: 400, step: 5, unit: 'Hz' },
  q: { label: 'Résonance Q', min: 0.4, max: 4, step: 0.1, unit: '' },
  rate: { label: 'Vitesse LFO', min: 0.2, max: 6, step: 0.1, unit: 'Hz' },
  depth: { label: 'Profondeur', min: 0, max: 100, step: 1, unit: '%' },
  timeMs: { label: 'Temps Delay', min: 40, max: 900, step: 10, unit: 'ms' },
  feedback: { label: 'Feedback', min: 0, max: 80, step: 1, unit: '%' },
  decay: { label: 'Decay', min: 10, max: 100, step: 1, unit: '%' },
  ceiling: { label: 'Plafond', min: -6, max: 0, step: 0.1, unit: 'dB' },
};

function resolveParamMeta(key: string, currentValue: number): ParamMeta {
  if (PARAM_METADATA[key]) {
    return PARAM_METADATA[key];
  }
  const absMax = Math.max(100, Math.ceil(Math.abs(currentValue) * 2));
  const min = currentValue < 0 ? -absMax : 0;
  return {
    label: key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()),
    min,
    max: absMax,
    step: Number.isInteger(currentValue) ? 1 : 0.1,
    unit: '',
  };
}

function formatParamValue(value: number, step: number, unit: string): string {
  const decimals = step < 1 ? 1 : 0;
  const formatted = value.toFixed(decimals);
  return unit ? `${formatted} ${unit}` : formatted;
}

export const PluginModal: React.FC<PluginModalProps> = ({
  strip,
  slotIndex,
  onClose,
  onSelectPlugin,
  onUpdateParam,
  onToggleBypass,
  onResetParams,
}) => {
  const [formatFilter, setFormatFilter] = useState<'ALL' | PluginFormat>('ALL');
  const [searchQuery, setSearchQuery] = useState('');

  const filteredCatalog = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return PLUGIN_CATALOG.filter((p) => {
      const matchesFormat = formatFilter === 'ALL' || p.format === formatFilter;
      const matchesQuery =
        !query ||
        p.name.toLowerCase().includes(query) ||
        p.vendor.toLowerCase().includes(query) ||
        p.category.toLowerCase().includes(query);
      return matchesFormat && matchesQuery;
    });
  }, [formatFilter, searchQuery]);

  if (!strip || slotIndex === null) return null;

  const slot = strip.inserts[slotIndex];
  if (!slot) return null;

  const activePlugin = slot.plugin;
  const resolvedParams: Record<string, number> = activePlugin
    ? { ...activePlugin.defaultParams, ...slot.params }
    : slot.params;
  const paramEntries = Object.entries(resolvedParams);

  const handleReset = () => {
    if (!activePlugin) return;
    if (onResetParams) {
      onResetParams(strip.id, slotIndex);
      return;
    }
    for (const [key, defaultValue] of Object.entries(activePlugin.defaultParams)) {
      onUpdateParam(strip.id, slotIndex, key, defaultValue);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-3 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Gestionnaire d'inserts VST2 / VST3 / AU"
    >
      <div className="w-full max-w-2xl max-h-[90vh] flex flex-col bg-[#131720] border border-[#2D3545] rounded-lg shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 sm:px-5 py-3 border-b border-[#232936] bg-[#0F131B] shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <Sliders className="w-4 h-4 text-sky-400 shrink-0" />
            <h2 className="text-sm font-semibold text-slate-100 truncate">
              {strip.name} · Insert {slotIndex + 1}/{MAX_INSERTS_PER_STRIP}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fermer"
            className="p-1.5 rounded text-slate-400 hover:text-white hover:bg-[#1E2533] cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-[#232936] overflow-y-auto flex-1">
          {/* Left: Plugin Picker */}
          <div className="p-4 flex flex-col gap-3 min-h-0">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="text-xs font-medium text-slate-300">
                Catalogue VST2 / VST3 / AU
              </span>
              <div className="flex items-center gap-1 bg-[#0B0E14] p-0.5 rounded border border-[#232936]">
                {(['ALL', 'AU', 'VST3', 'VST2'] as const).map((fmt) => (
                  <button
                    key={fmt}
                    type="button"
                    onClick={() => setFormatFilter(fmt)}
                    className={`px-2 py-0.5 text-[10px] font-mono rounded cursor-pointer transition-colors ${
                      formatFilter === fmt
                        ? 'bg-sky-500/20 text-sky-300'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {fmt === 'ALL' ? 'Tous' : fmt}
                  </button>
                ))}
              </div>
            </div>

            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Rechercher un plugin..."
                aria-label="Rechercher un plugin"
                className="w-full bg-[#0B0E14] border border-[#232936] rounded pl-8 pr-3 py-1.5 text-xs text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-sky-500"
              />
            </div>

            <div className="flex flex-col gap-1.5 max-h-64 overflow-y-auto pr-1">
              {filteredCatalog.length === 0 ? (
                <div className="text-xs text-slate-500 py-6 text-center">
                  Aucun plugin ne correspond à la recherche.
                </div>
              ) : (
                filteredCatalog.map((plugin) => {
                  const isSelected = activePlugin?.id === plugin.id;
                  return (
                    <button
                      key={plugin.id}
                      type="button"
                      onClick={() => onSelectPlugin(strip.id, slotIndex, plugin)}
                      className={`flex items-center justify-between px-3 py-2 rounded border text-left transition-colors cursor-pointer ${
                        isSelected
                          ? 'bg-sky-500/15 border-sky-400 text-white'
                          : 'bg-[#0B0E14] border-[#232936] text-slate-300 hover:border-slate-500'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="text-xs font-medium truncate">{plugin.name}</div>
                        <div className="text-[10px] text-slate-400 truncate">
                          {plugin.vendor} · {plugin.category}
                        </div>
                      </div>
                      <span
                        className={`text-[10px] font-mono ml-2 shrink-0 ${
                          plugin.format === 'AU'
                            ? 'text-amber-400'
                            : plugin.format === 'VST3'
                              ? 'text-sky-400'
                              : 'text-emerald-400'
                        }`}
                      >
                        {plugin.format}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
          </div>

          {/* Right: Dynamic Plugin Parameter Sliders */}
          <div className="p-4 flex flex-col justify-between gap-4 bg-[#0F131B]/50 min-h-0">
            {activePlugin ? (
              <div className="flex flex-col gap-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-slate-100 truncate">
                        {activePlugin.name}
                      </span>
                      <span
                        className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${
                          slot.bypassed
                            ? 'bg-slate-800/60 border-slate-700 text-slate-400'
                            : 'bg-sky-500/10 border-sky-500/30 text-sky-300'
                        }`}
                      >
                        {slot.bypassed ? 'BYPASS' : activePlugin.format}
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-400 mt-0.5">
                      {activePlugin.vendor} · {activePlugin.category}
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    {onToggleBypass && (
                      <button
                        type="button"
                        aria-pressed={slot.bypassed}
                        onClick={() => onToggleBypass(strip.id, slotIndex)}
                        className={`flex items-center gap-1 px-2 py-1 text-[11px] rounded border cursor-pointer transition-colors ${
                          slot.bypassed
                            ? 'bg-[#1A202C] border-[#2D3545] text-slate-400 hover:text-slate-200'
                            : 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/25'
                        }`}
                        title={slot.bypassed ? 'Activer le plugin' : 'Mettre en bypass'}
                      >
                        <Power className="w-3 h-3" />
                        {slot.bypassed ? 'Off' : 'On'}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onSelectPlugin(strip.id, slotIndex, null)}
                      className="flex items-center gap-1 px-2 py-1 text-[11px] text-red-400 hover:bg-red-500/10 border border-red-500/30 rounded cursor-pointer"
                      title="Retirer le plugin de cet emplacement"
                    >
                      <Trash2 className="w-3 h-3" />
                      Retirer
                    </button>
                  </div>
                </div>

                <div className="flex items-center justify-between pt-2 border-t border-[#232936]">
                  <span className="text-[11px] font-medium text-slate-300">
                    Paramètres du plugin ({paramEntries.length})
                  </span>
                  {paramEntries.length > 0 && (
                    <button
                      type="button"
                      onClick={handleReset}
                      className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-200 cursor-pointer"
                      title="Réinitialiser les paramètres par défaut"
                    >
                      <RotateCcw className="w-3 h-3" />
                      Défaut
                    </button>
                  )}
                </div>

                <div
                  className={`flex flex-col gap-3 max-h-64 overflow-y-auto pr-1 transition-opacity ${
                    slot.bypassed ? 'opacity-60' : 'opacity-100'
                  }`}
                >
                  {paramEntries.length === 0 ? (
                    <p className="text-xs text-slate-500 py-4 text-center">
                      Ce plugin ne expose aucun paramètre configurable.
                    </p>
                  ) : (
                    paramEntries.map(([key, val]) => {
                      const meta = resolveParamMeta(key, val);
                      const clampedValue = Math.min(meta.max, Math.max(meta.min, val));
                      const defaultVal = activePlugin.defaultParams[key];
                      return (
                        <div
                          key={key}
                          className="flex flex-col gap-1 bg-[#0B0E14]/60 border border-[#232936] rounded px-2.5 py-2"
                        >
                          <div className="flex items-center justify-between text-xs gap-2">
                            <label
                              htmlFor={`plugin-param-${strip.id}-${slotIndex}-${key}`}
                              className="text-slate-200 font-medium truncate"
                            >
                              {meta.label}
                            </label>
                            <span className="font-mono tabular-nums text-sky-300 shrink-0">
                              {formatParamValue(clampedValue, meta.step, meta.unit)}
                            </span>
                          </div>
                          <input
                            id={`plugin-param-${strip.id}-${slotIndex}-${key}`}
                            type="range"
                            min={meta.min}
                            max={meta.max}
                            step={meta.step}
                            value={clampedValue}
                            onDoubleClick={() => {
                              if (typeof defaultVal === 'number') {
                                onUpdateParam(strip.id, slotIndex, key, defaultVal);
                              }
                            }}
                            onChange={(e) =>
                              onUpdateParam(strip.id, slotIndex, key, Number(e.target.value))
                            }
                            className="w-full accent-sky-400 cursor-pointer"
                          />
                          <div className="flex items-center justify-between text-[10px] font-mono text-slate-500">
                            <span>{formatParamValue(meta.min, meta.step, meta.unit)}</span>
                            <span>{formatParamValue(meta.max, meta.step, meta.unit)}</span>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-center py-10 px-4">
                <p className="text-xs text-slate-300 font-medium">
                  Emplacement vide ({slotIndex + 1}/{MAX_INSERTS_PER_STRIP})
                </p>
                <p className="text-[11px] text-slate-500 mt-1">
                  Sélectionnez un plugin AU, VST3 ou VST2 dans la colonne de gauche pour l'insérer et régler ses paramètres sur {strip.name}.
                </p>
              </div>
            )}

            <div className="flex justify-end pt-2 border-t border-[#232936] shrink-0">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-1.5 text-xs font-medium bg-slate-100 text-slate-900 rounded hover:bg-white cursor-pointer"
              >
                Fermer
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
