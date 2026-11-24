import React, { useRef, useState } from 'react';

interface FaderProps {
  valueDb: number;
  onChange: (db: number) => void;
  height?: number;
  label?: string;
}

const MIN_DB = -60;
const MAX_DB = 12;

export const Fader: React.FC<FaderProps> = ({
  valueDb,
  onChange,
  height = 148,
  label = 'Volume',
}) => {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  const updateFromClientY = (clientY: number) => {
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pad = 12;
    const usable = rect.height - pad * 2;
    const rel = 1 - (clientY - rect.top - pad) / usable;
    const norm = Math.max(0, Math.min(1, rel));
    const db = MIN_DB + norm * (MAX_DB - MIN_DB);
    onChange(Math.round(db * 10) / 10);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    updateFromClientY(e.clientY);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    updateFromClientY(e.clientY);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    setDragging(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  const norm = Math.max(0, Math.min(1, (valueDb - MIN_DB) / (MAX_DB - MIN_DB)));
  const capBottomPct = norm * 100;

  // Tick marks in dB
  const ticks = [12, 0, -12, -24, -48];

  return (
    <div
      ref={trackRef}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={MIN_DB}
      aria-valuemax={MAX_DB}
      aria-valuenow={valueDb}
      title="Fader volume (Double-clic pour 0.0 dB)"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onDoubleClick={() => onChange(0)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          onChange(Math.min(MAX_DB, Math.round((valueDb + 1.5) * 10) / 10));
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          onChange(Math.max(MIN_DB, Math.round((valueDb - 1.5) * 10) / 10));
        }
      }}
      className="relative w-10 select-none cursor-ns-resize flex items-center justify-center focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-400 rounded"
      style={{ height }}
    >
      {/* Scale ticks */}
      {ticks.map((t) => {
        const tNorm = (t - MIN_DB) / (MAX_DB - MIN_DB);
        return (
          <div
            key={t}
            className="absolute left-0 right-0 flex items-center justify-between px-0.5 pointer-events-none"
            style={{ bottom: `calc(${tNorm * 100}% * 0.84 + 8%)` }}
          >
            <span className={`h-px w-1.5 ${t === 0 ? 'bg-amber-400/70' : 'bg-slate-600'}`} />
            <span className={`h-px w-1.5 ${t === 0 ? 'bg-amber-400/70' : 'bg-slate-600'}`} />
          </div>
        );
      })}

      {/* Center slot */}
      <div className="w-1 h-[calc(100%-20px)] bg-[#07090D] border border-[#232936] rounded-full" />

      {/* Fader cap */}
      <div
        className={`absolute left-1 right-1 h-5 rounded-[3px] border flex items-center justify-center shadow-sm transition-colors ${
          dragging
            ? 'bg-slate-100 border-sky-400'
            : 'bg-slate-300 border-slate-400 hover:bg-white'
        }`}
        style={{
          bottom: `calc(${capBottomPct}% * 0.84 + 12px - 10px)`,
        }}
      >
        <div className="w-full h-[1.5px] bg-slate-800 mx-1" />
      </div>
    </div>
  );
};
