import { useEffect, useState } from "react";
import { Activity, ChevronDown } from "lucide-react";
import { useStore } from "../store";
import { formatSpeed, nextChartScale } from "../lib/format";
import { cx } from "../lib/format";

const POINTS = 60;
const WIDTH = 600;
const HEIGHT = 64;

interface Series {
  samples: number[];
  scale: number;
}

const EMPTY: Series = { samples: [], scale: 1 };

function readCollapsed(): boolean {
  try {
    const saved = localStorage.getItem("fluxdl:globalChartCollapsed");
    // 默认收起：曲线是「想看时展开」的辅助信息，不该默认占据列表空间。
    // 只在用户显式展开过（存 "0"）时才默认展开。
    return saved === null ? true : saved === "1";
  } catch {
    return true;
  }
}

/**
 * 主界面全局速度曲线：把「当前总下载速度」连续采样成一条曲线，
 * 常驻在工具栏下方，不必打开任务详情就能看到速度走势（IDM/MDM 的主界面做法）。
 * 采样每 500ms 一次、横轴时间均匀；纵轴量程用 nextChartScale 跨帧保留避免锯齿。
 */
export function GlobalSpeedChart() {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [series, setSeries] = useState<Series>(EMPTY);
  const [instant, setInstant] = useState(0);
  const [activeCount, setActiveCount] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => {
      const tasks = useStore.getState().tasks;
      let speed = 0;
      let active = 0;
      for (const t of tasks) {
        if (t.status === "downloading" || t.status === "connecting") {
          speed += t.speedBps;
          active += 1;
        }
      }
      setInstant(speed);
      setActiveCount(active);
      setSeries((prev) => {
        const samples = [...prev.samples, speed].slice(-POINTS);
        return { samples, scale: nextChartScale(prev.scale, samples) };
      });
    }, 500);
    return () => window.clearInterval(id);
  }, []);

  const toggle = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("fluxdl:globalChartCollapsed", next ? "1" : "0");
      } catch {
        // ignore
      }
      return next;
    });
  };

  const { samples, scale: max } = series;
  const n = Math.max(2, samples.length);
  const points = samples.map((value, index) => {
    const x = (index / (n - 1)) * WIDTH;
    const y = HEIGHT - (value / max) * (HEIGHT - 8) - 4;
    return [x, y] as const;
  });
  const line = points
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
  const area = points.length ? `M0,${HEIGHT} ${line} L${WIDTH},${HEIGHT} Z` : "";
  const peak = samples.length ? Math.max(...samples) : 0;

  if (activeCount === 0 && collapsed) return null;

  return (
    <section
      className={cx("global-speed", collapsed && "is-collapsed")}
      aria-label="全局速度曲线"
    >
      <div className="global-speed-head">
        <button
          className="global-speed-toggle"
          onClick={toggle}
          aria-expanded={!collapsed}
          title={collapsed ? "展开速度曲线" : "收起速度曲线"}
        >
          <ChevronDown size={13} className={cx("gsc-caret", !collapsed && "open")} />
          <Activity size={13} />
          <span>实时速度</span>
        </button>
        <div className="global-speed-readout">
          <span className="gsc-current">{formatSpeed(instant)}</span>
          <span className="gsc-sep" />
          <span className="gsc-stat">峰值 {formatSpeed(peak)}</span>
          <span className="gsc-sep" />
          <span className={cx("gsc-stat", activeCount > 0 ? "live" : "")}>
            {activeCount > 0 ? `${activeCount} 个传输中` : "引擎空闲"}
          </span>
        </div>
      </div>
      {!collapsed && (
        <div className="global-speed-chart">
          <svg
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <defs>
              <linearGradient id="gsc-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.3" />
                <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.02" />
              </linearGradient>
            </defs>
            <line x1="0" y1={HEIGHT / 2} x2={WIDTH} y2={HEIGHT / 2} className="chart-grid" />
            {area && <path d={area} fill="url(#gsc-fill)" />}
            {line && <path d={line} className="chart-line" />}
          </svg>
          {samples.length < 3 && <div className="chart-empty">正在采样速度…</div>}
        </div>
      )}
    </section>
  );
}
