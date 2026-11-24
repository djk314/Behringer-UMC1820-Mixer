import React from 'react';
import { MeterLevel } from '../types/mixer';

interface VuMeterProps {
  level: MeterLevel;
  height?: number;
}

const SEGMENTS = 18;

export const VuMeter: React.FC<VuMeterProps> = ({ level, height = 148 }) => {
  const dbToActiveSegments = (db: number) => {
    const norm = Math.max(0, Math.min(1, (db + 54) / 54));
    return Math.round(norm * SEGMENTS);
  };

  const activeL = dbToActiveSegments(level.peakDbL);
  const activeR = dbToActiveSegments(level.peakDbR);

  const renderBar = (activeCount: number, side: string) => (
    <div
      key={side}
      className="flex flex-col-reverse justify-between w-2 h-full"
      aria-label={`VU-mètre ${side}`}
    >
      {Array.from({ length: SEGMENTS }).map((_, idx) => {
        const isLit = idx < activeCount;
        let litColor = 'bg-emerald-400';
        if (idx >= 15) {
          litColor = 'bg-red-500';
        } else if (idx >= 12) {
          litColor = 'bg-amber-400';
        }
        return (
          <div
            key={idx}
            className={`w-full rounded-[1px] transition-colors duration-75 ${
              isLit ? litColor : 'bg-[#1A202C]'
            }`}
            style={{ height: Math.max(3, Math.floor((height - 24) / SEGMENTS) - 1) }}
          />
        );
      })}
    </div>
  );

  return (
    <div
      className="flex flex-col items-center justify-between bg-[#080A0F] border border-[#232936] rounded px-1 py-1 select-none"
      style={{ height }}
      title={`Peak L: ${level.peakDbL.toFixed(1)} dB · Peak R: ${level.peakDbR.toFixed(1)} dB`}
    >
      {/* Clip indicator */}
      <div
        className={`w-full h-1.5 rounded-[1px] mb-1 ${
          level.clip ? 'bg-red-500' : 'bg-[#1A202C]'
        }`}
      />
      <div className="flex gap-1 flex-1 items-stretch">
        {renderBar(activeL, 'L')}
        {renderBar(activeR, 'R')}
      </div>
    </div>
  );
};
