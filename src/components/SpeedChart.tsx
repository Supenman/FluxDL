import { useEffect, useRef, useState } from "react";
import { formatSpeed, nextChartScale } from "../lib/format";

interface SpeedChartProps {
  taskId: string;
  speedBps: number;
  active: boolean;
}

const POINTS = 40;
const WIDTH = 320;
const HEIGHT = 72;

interface ChartState {
  samples: number[];
  scale: number;
}

const EMPTY: ChartState = { samples: [], scale: 1 };

export function SpeedChart({ taskId, speedBps, active }: SpeedChartProps) {
  // 采样点与纵轴量程放进同一个 state：每帧用纯函数一起推进，避免量程与曲线
  // 取自两次不同的渲染快照而错位。
  const [chart, setChart] = useState<ChartState>(EMPTY);
  const lastId = useRef(taskId);
  // 用 ref 持有最新值，定时采样读取，避免「速度一变化就推点」导致横轴时间不均匀。
  const speedRef = useRef(speedBps);
  const activeRef = useRef(active);
  speedRef.current = speedBps;
  activeRef.current = active;

  useEffect(() => {
    if (lastId.current !== taskId) {
      lastId.current = taskId;
      setChart(EMPTY);
    }
  }, [taskId]);

  useEffect(() => {
    // 固定每 500ms 采样一次当前 speedBps，横轴时间均匀，曲线平滑可读。
    const id = window.setInterval(() => {
      setChart((prev) => {
        const samples = [...prev.samples, activeRef.current ? speedRef.current : 0];
        const windowed = samples.slice(-POINTS);
        return { samples: windowed, scale: nextChartScale(prev.scale, windowed) };
      });
    }, 500);
    return () => window.clearInterval(id);
  }, []);

  const { samples, scale: max } = chart;
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
