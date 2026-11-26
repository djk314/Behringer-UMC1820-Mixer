import React, { useRef, useState } from 'react';

interface RotaryKnobProps {
  label: string;
  value: number;
  min: number;
  max: number;
  defaultValue?: number;
  unit?: string;
  accentColor?: string;
  size?: number;
  bipolar?: boolean;
  onChange: (value: number) => void;
}

export const RotaryKnob: React.FC<RotaryKnobProps> = ({
  label,
  value,
  min,
  max,
  defaultValue = 0,
  unit = 'dB',
  accentColor = '#38BDF8',
  size = 38,
  bipolar = true,
  onChange,
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const startYRef = useRef<number>(0);
  const startValRef = useRef<number>(value);

  const norm = Math.max(0, Math.min(1, (value - min) / (max - min)));
  const startAngle = 135; // degrees (bottom-left)
  const sweepAngle = 270; // degrees clockwise to bottom-right
  const currentAngle = startAngle + norm * sweepAngle;

  const zeroNorm = bipolar ? Math.max(0, Math.min(1, (0 - min) / (max - min))) : 0;
  const zeroAngle = startAngle + zeroNorm * sweepAngle;

  const r = size / 2 - 4;
  const cx = size / 2;
  const cy = size / 2;

  const polarToCartesian = (angleDeg: number, radius: number) => {
    const rad = (angleDeg * Math.PI) / 180;
    return {
      x: cx + radius * Math.cos(rad),
      y: cy + radius * Math.sin(rad),
    };
  };

  const describeArc = (a1: number, a2: number, radius: number) => {
    const start = Math.min(a1, a2);
    const end = Math.max(a1, a2);
    if (end - start < 0.5) return '';
    const p1 = polarToCartesian(start, radius);
    const p2 = polarToCartesian(end, radius);
    const largeArc = end - start > 180 ? 1 : 0;
    return `M ${p1.x} ${p1.y} A ${radius} ${radius} 0 ${largeArc} 1 ${p2.x} ${p2.y}`;
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    setIsDragging(true);
    startYRef.current = e.clientY;
    startValRef.current = value;
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging) return;
    const dy = startYRef.current - e.clientY;
    const span = max - min;
    const sensitivity = e.shiftKey ? 0.0025 : 0.0075;
    const next = Math.max(min, Math.min(max, startValRef.current + dy * span * sensitivity));
    onChange(Math.round(next * 10) / 10);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDragging) return;
    setIsDragging(false);
    try {
      (e.currentTarget as HTMLDivElement).releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  const handleDoubleClick = () => {
    onChange(defaultValue);
  };

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const step = (max - min) * (e.shiftKey ? 0.01 : 0.03);
    const delta = e.deltaY < 0 ? step : -step;
    const next = Math.max(min, Math.min(max, value + delta));
    onChange(Math.round(next * 10) / 10);
  };

  const pointerTip = polarToCartesian(currentAngle, r - 3);
  const pointerBase = polarToCartesian(currentAngle, r * 0.35);

  const formattedValue =
    unit === '%'
      ? `${Math.round(value)}%`
      : `${value > 0 && bipolar ? '+' : ''}${value.toFixed(1)}`;

  return (
    <div className="flex flex-col items-center select-none gap-0.5">
      <div
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        title={`${label} : ${formattedValue} ${unit} (Double-clic pour réinitialiser, Maj+Glisser pour précision)`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onDoubleClick={handleDoubleClick}
        onWheel={handleWheel}
        onKeyDown={(e) => {
          const step = (max - min) * 0.05;
          if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
            e.preventDefault();
            onChange(Math.min(max, Math.round((value + step) * 10) / 10));
          } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
            e.preventDefault();
            onChange(Math.max(min, Math.round((value - step) * 10) / 10));
          }
        }}
        className="cursor-ns-resize focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-400 rounded-full"
        style={{ width: size, height: size }}
      >
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          {/* Track background arc */}
          <path
            d={describeArc(startAngle, startAngle + sweepAngle, r)}
            fill="none"
            stroke="var(--knob-track)"
            strokeWidth={2.5}
            strokeLinecap="round"
          />
          {/* Active arc */}
          <path
            d={describeArc(zeroAngle, currentAngle, r)}
            fill="none"
            stroke={accentColor}
            strokeWidth={2.5}
            strokeLinecap="round"
          />
          {/* Knob body */}
          <circle
            cx={cx}
            cy={cy}
            r={r - 3.5}
            fill="var(--knob-body)"
            stroke={isDragging ? accentColor : 'var(--knob-stroke)'}
            strokeWidth={1.25}
          />
          {/* Pointer line */}
          <line
            x1={pointerBase.x}
            y1={pointerBase.y}
            x2={pointerTip.x}
            y2={pointerTip.y}
            stroke="var(--knob-pointer)"
            strokeWidth={1.8}
            strokeLinecap="round"
          />
        </svg>
      </div>
      <div className="flex flex-col items-center leading-tight">
        <span className="text-[10px] font-medium text-[var(--text-muted)] tracking-tight whitespace-nowrap">
          {label}
        </span>
        <span className="text-[10px] font-mono tabular-nums text-[var(--text-main)]">
          {formattedValue}
        </span>
      </div>
    </div>
  );
};
