import { useEffect, useRef, useState } from "react";
import { formatSpeed } from "../lib/format";

interface SpeedChartProps {
  taskId: string;
  speedBps: number;
  active: boolean;
}

const POINTS = 40;
const WIDTH = 320;
const HEIGHT = 72;

export function SpeedChart({ taskId, speedBps, active }: SpeedChartProps) {
  const [samples, setSamples] = useState<number[]>([]);
  const lastId = useRef(taskId);

  useEffect(() => {
    if (lastId.current !== taskId) {
      lastId.current = taskId;
      setSamples([]);
    }
  }, [taskId]);

  useEffect(() => {
    setSamples((prev) => {
      const next = [...prev, active ? speedBps : 0];
      return next.slice(-POINTS);
    });
  }, [speedBps, active]);

  const max = Math.max(1, ...samples);
  const n = Math.max(2, samples.length);
  const points = samples.map((value, index) => {
    const x = (index / (n - 1)) * WIDTH;
    const y = HEIGHT - (value / max) * (HEIGHT - 8) - 4;
    return [x, y] as const;
  });
  const line = points
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
  const area = points.length
    ? `M0,${HEIGHT} ${line.replace("M", "M")} L${WIDTH},${HEIGHT} Z`
    : "";

  return (
    <div className="speed-chart">
      <div className="chart-head">
        <span>实时速度</span>
        <strong>{formatSpeed(speedBps)}</strong>
      </div>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id={`chart-fill-${taskId}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <line x1="0" y1={HEIGHT / 2} x2={WIDTH} y2={HEIGHT / 2} className="chart-grid" />
        {area && <path d={area} fill={`url(#chart-fill-${taskId})`} />}
        {line && <path d={line} className="chart-line" />}
      </svg>
      {samples.length < 3 && <div className="chart-empty">正在采样速度…</div>}
    </div>
  );
}
