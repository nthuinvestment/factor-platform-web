"use client";

import React, { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";

const Plot = dynamic(() => import("react-plotly.js"), { ssr: false });

/** =========================
 * GitHub data source config
 * ========================= */
const GH_OWNER = "nthuinvestment";
const GH_REPO = "factor-platform-database";
const GH_BRANCH = "main";

// raw file base (fast, CORS ok)
const RAW_BASE = `https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${GH_BRANCH}`;

type ReturnsResp = {
  name?: string;
  factor?: string;
  dates: string[];
  ret: number[];
};

type MetricRow = {
  factor: string;
  period_return: number;
  ann_return: number;
  ann_vol: number;
  sharpe: number | null;
  maxdd: number;
};

type GlobalWaveResp = {
  factor: string;
  summary: {
    trough: { n_events: number; n_6m: number; n_12m: number; avg_6m: number | null; avg_12m: number | null };
    peak: { n_events: number; n_6m: number; n_12m: number; avg_6m: number | null; avg_12m: number | null };
  };
  events?: { type: "trough" | "peak"; date: string; r_6m: number | null; r_12m: number | null }[];
};

type RecentTable = {
  dates: string[];
  rows: Record<string, (number | null)[]>;
};

function toCum(retArr: number[]) {
  let v = 1;
  return retArr.map((r) => (v *= 1 + r));
}

function fmtPct(x: number | null | undefined) {
  if (x === null || x === undefined || Number.isNaN(x as any)) return "-";
  return `${(x * 100).toFixed(2)}%`;
}

function safeNum(x: number | null | undefined) {
  if (x === null || x === undefined || Number.isNaN(x as any)) return null;
  return x;
}

// === 固定因子顏色 ===
const FACTOR_COLORS: Record<string, string> = {
  High_yield: "#ff7f0e",
  PB_low: "#c49c94",
  PE_low: "#7f7f7f",
  Momentum_01: "#bcbd22",
  Momentum_03: "#8c564b",
  Momentum_06: "#f1c40f",
  High_yoy: "#4e79a7",
  Margin_growth: "#2ca02c",
  EPS_growth: "#76b7b2",
  Low_beta: "#e377c2",
  Top200: "#2563eb",
};

// === 因子中文標籤 ===
const FACTOR_LABELS: Record<string, string> = {
  EPS_growth: "EPS 動能",
  High_yield: "高股息",
  High_yoy: "營收成長",
  Low_beta: "低 Beta",
  Margin_growth: "利潤率成長",
  Momentum_01: "價格動能1m",
  Momentum_03: "價格動能3m",
  Momentum_06: "價格動能6m",
  PB_low: "低PB",
  PE_low: "低PE",
  Top200: "市值前 200",
  TWA00: "加權指數",
};

// === 取得因子標籤的輔助函數 ===
function getFactorLabel(factorName: string): string {
  return FACTOR_LABELS[factorName] || factorName;
}

function makeDiscreteColorscale(colorList: string[]) {
  const n = colorList.length;
  const cs: [number, string][] = [];
  for (let i = 0; i < n; i++) {
    const a = i / n;
    const b = (i + 1) / n;
    cs.push([a, colorList[i]]);
    cs.push([b, colorList[i]]);
  }
  return cs;
}

function parseDate(s: string) {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function clipByRange(d: ReturnsResp, start: string, end: string): ReturnsResp {
  const s = parseDate(start);
  const e = parseDate(end);
  if (!s || !e) return d;

  const outDates: string[] = [];
  const outRet: number[] = [];
  for (let i = 0; i < d.dates.length; i++) {
    const di = parseDate(d.dates[i]);
    if (!di) continue;
    if (di >= s && di <= e) {
      outDates.push(d.dates[i]);
      outRet.push(d.ret[i]);
    }
  }
  return { ...d, dates: outDates, ret: outRet };
}

function maxDrawdownFromReturns(ret: number[]) {
  let peak = 1;
  let nav = 1;
  let maxdd = 0;
  for (const r of ret) {
    nav *= 1 + r;
    if (nav > peak) peak = nav;
    const dd = nav / peak - 1;
    if (dd < maxdd) maxdd = dd;
  }
  return maxdd;
}
function calcMetricsFromDailyRet(factor: string, ret: number[], rfAnnual: number, freq = 252): MetricRow {
  if (!ret.length) {
    return { factor, period_return: 0, ann_return: 0, ann_vol: 0, sharpe: null, maxdd: 0 };
  }

  let nav = 1;
  for (const r of ret) nav *= 1 + r;

  const period_return = nav - 1;
  const n = ret.length;
  const ann_return = Math.pow(nav, freq / n) - 1;

  const mean = ret.reduce((a, b) => a + b, 0) / n;
  const var_ = ret.reduce((a, r) => a + (r - mean) ** 2, 0) / Math.max(1, n - 1);
  const ann_vol = Math.sqrt(var_ * freq);

  const rfDaily = rfAnnual / freq;
  const ex = ret.map((r) => r - rfDaily);
  const exMean = ex.reduce((a, b) => a + b, 0) / n;
  const exVar = ex.reduce((a, r) => a + (r - exMean) ** 2, 0) / Math.max(1, n - 1);
  const exVol = Math.sqrt(exVar * freq);

  const sharpe = exVol === 0 ? null : (exMean * freq) / exVol;
  const maxdd = maxDrawdownFromReturns(ret);

  return { factor, period_return, ann_return, ann_vol, sharpe, maxdd };
}

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`fetch failed ${r.status}: ${url}\n${t.slice(0, 200)}`);
  }
  return (await r.json()) as T;
}

type ManifestResp = { factors: string[] };

async function listFactorsFromGithub(): Promise<string[]> {
  const url = `${RAW_BASE}/data/manifest.json`;
  const m = await fetchJson<ManifestResp>(url);
  const names = (m?.factors || []).filter((x) => typeof x === "string" && x.trim().length > 0);
  names.sort((a, b) => a.localeCompare(b));
  return names;
}

export default function Home() {
  const [factors, setFactors] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>(["Top200"]);
  const [start, setStart] = useState("2003-01-01");
  const [end, setEnd] = useState("2026-12-31");
  const [rf, setRf] = useState(0.0);

  const [series, setSeries] = useState<Record<string, ReturnsResp>>({});
  const [metrics, setMetrics] = useState<MetricRow[]>([]);
  const [heatmap, setHeatmap] = useState<any>(null);

  // ===== 近 X 個交易日詳細表 =====
  const [recentTradingDays, setRecentTradingDays] = useState(20);
  const [recent20Table, setRecent20Table] = useState<RecentTable | null>(null);
  const [recent20Loading, setRecent20Loading] = useState(false);
  const [recent20Expanded, setRecent20Expanded] = useState(false);

  // ===== 近 X 日累積表現 =====
  const [recentCumDays, setRecentCumDays] = useState(20);
  const [recentCumTable, setRecentCumTable] = useState<RecentTable | null>(null);
  const [recentCumLoading, setRecentCumLoading] = useState(false);
  const [recentCumExpanded, setRecentCumExpanded] = useState(false);

  // ===== Global Wave =====
  const [gwSelected, setGwSelected] = useState<string[]>(["Top200", "PE_low", "PB_low"]);
  const [gwData, setGwData] = useState<Record<string, GlobalWaveResp>>({});
  const [gwLoading, setGwLoading] = useState(false);
  const [gwHorizon, setGwHorizon] = useState<6 | 12>(6);
  const [gwBenchmark, setGwBenchmark] = useState<string>("Top200");
  const [benchSeries, setBenchSeries] = useState<ReturnsResp | null>(null);

  // Load Factor List
  useEffect(() => {
    (async () => {
      try {
        const list = await listFactorsFromGithub();
        setFactors(list);
        if (list.length) {
          if (!selected.length || !list.includes(selected[0])) setSelected([list[0]]);
          const defaults = ["Top200", "PE_low", "PB_low"].filter((x) => list.includes(x));
          setGwSelected(defaults.length ? defaults : list.slice(0, Math.min(3, list.length)));
          setGwBenchmark(list.includes("Top200") ? "Top200" : list[0]);
        }
      } catch (e) {
        setFactors([]);
      }
    })();
  }, []);

  // Load Returns & Metrics
  useEffect(() => {
    (async () => {
      if (!selected.length) {
        setSeries({});
        setMetrics([]);
        return;
      }
      try {
        const pairs = await Promise.all(
          selected.map(async (f) => {
            const url = `${RAW_BASE}/data/returns/${encodeURIComponent(f)}.json`;
            const d = await fetchJson<ReturnsResp>(url);
            const factorName = d.factor || d.name || f;
            const normalized: ReturnsResp = { factor: factorName, dates: d.dates || [], ret: d.ret || [] };
            const clipped = clipByRange(normalized, start, end);
            return [f, clipped] as const;
          })
        );
        const obj: Record<string, ReturnsResp> = {};
        for (const [f, d] of pairs) obj[f] = d;
        setSeries(obj);

        const rows: MetricRow[] = selected.map((f) => {
          const d = obj[f];
          return calcMetricsFromDailyRet(f, d?.ret || [], rf, 252);
        });
        setMetrics(rows);
      } catch (e) {
        setSeries({});
        setMetrics([]);
      }
    })();
  }, [selected, start, end, rf]);

  // Load Heatmap
  useEffect(() => {
    (async () => {
      try {
        const d = await fetchJson<any>(`${RAW_BASE}/data/heatmap/heatmap_12m.json`);
        setHeatmap(d);
      } catch (e) {
        setHeatmap(null);
      }
    })();
  }, []);

  // ===== Load Recent X Trading Days Table =====
  useEffect(() => {
    (async () => {
      if (!factors.length) {
        setRecent20Table(null);
        return;
      }

      setRecent20Loading(true);
      try {
        const pairs = await Promise.all(
          factors.map(async (f) => {
            const d = await fetchJson<ReturnsResp>(`${RAW_BASE}/data/returns/${encodeURIComponent(f)}.json`);
            const normalized: ReturnsResp = {
              factor: d.factor || d.name || f,
              dates: d.dates || [],
              ret: d.ret || [],
            };
            return [f, normalized] as const;
          })
        );

        const allDatesSet = new Set<string>();
        for (const [, d] of pairs) {
          for (const dt of d.dates || []) {
            if (dt) allDatesSet.add(dt);
          }
        }

        const allDates = Array.from(allDatesSet).sort((a, b) => {
          const ta = parseDate(a)?.getTime() ?? 0;
          const tb = parseDate(b)?.getTime() ?? 0;
          return ta - tb;
        });

        const lastNDates = allDates.slice(-recentTradingDays);

        const rows: Record<string, (number | null)[]> = {};
        for (const [factor, data] of pairs) {
          const dateToRet = new Map<string, number>();
          for (let i = 0; i < data.dates.length; i++) {
            const dt = data.dates[i];
            const rv = data.ret[i];
            if (dt) dateToRet.set(dt, rv);
          }
          rows[factor] = lastNDates.map((dt) => {
            const v = dateToRet.get(dt);
            return v === undefined || Number.isNaN(v) ? null : v;
          });
        }

        setRecent20Table({
          dates: lastNDates,
          rows,
        });
      } catch (e) {
        setRecent20Table(null);
      } finally {
        setRecent20Loading(false);
      }
    })();
  }, [factors, recentTradingDays]);

  // ===== Load Recent X Days Cumulative Table =====
  useEffect(() => {
    (async () => {
      if (!factors.length) {
        setRecentCumTable(null);
        return;
      }

      setRecentCumLoading(true);
      try {
        const pairs = await Promise.all(
          factors.map(async (f) => {
            const d = await fetchJson<ReturnsResp>(`${RAW_BASE}/data/returns/${encodeURIComponent(f)}.json`);
            const normalized: ReturnsResp = {
              factor: d.factor || d.name || f,
              dates: d.dates || [],
              ret: d.ret || [],
            };
            return [f, normalized] as const;
          })
        );

        const allDatesSet = new Set<string>();
        for (const [, d] of pairs) {
          for (const dt of d.dates || []) {
            if (dt) allDatesSet.add(dt);
          }
        }

        const allDates = Array.from(allDatesSet).sort((a, b) => {
          const ta = parseDate(a)?.getTime() ?? 0;
          const tb = parseDate(b)?.getTime() ?? 0;
          return ta - tb;
        });

        const lastNDates = allDates.slice(-recentCumDays);

        const rows: Record<string, (number | null)[]> = {};
        for (const [factor, data] of pairs) {
          const dateToCum = new Map<string, number>();
          let nav = 100;
          for (let i = 0; i < data.dates.length; i++) {
            const dt = data.dates[i];
            const rv = data.ret[i];
            if (!dt || rv === undefined || rv === null || Number.isNaN(rv)) continue;
            nav *= 1 + rv;
            dateToCum.set(dt, nav);
          }

          rows[factor] = lastNDates.map((dt) => {
            const v = dateToCum.get(dt);
            return v === undefined || Number.isNaN(v) ? null : v;
          });
        }

        setRecentCumTable({
          dates: lastNDates,
          rows,
        });
      } catch (e) {
        setRecentCumTable(null);
      } finally {
        setRecentCumLoading(false);
      }
    })();
  }, [factors, recentCumDays]);

  // Load Global Wave Data
  useEffect(() => {
    (async () => {
      if (!gwSelected.length) {
        setGwData({});
        return;
      }
      setGwLoading(true);
      try {
        const pairs = await Promise.all(
          gwSelected.map(async (f) => {
            const d = await fetchJson<GlobalWaveResp>(`${RAW_BASE}/data/global_wave/${encodeURIComponent(f)}.json`);
            return [f, d] as const;
          })
        );
        const obj: Record<string, GlobalWaveResp> = {};
        for (const [f, d] of pairs) obj[f] = d;
        setGwData(obj);
      } catch (e) {
        setGwData({});
      } finally {
        setGwLoading(false);
      }
    })();
  }, [gwSelected]);

  // Load GW Benchmark
  useEffect(() => {
    (async () => {
      if (!gwBenchmark) {
        setBenchSeries(null);
        return;
      }
      try {
        const d = await fetchJson<ReturnsResp>(`${RAW_BASE}/data/returns/${encodeURIComponent(gwBenchmark)}.json`);
        const normalized: ReturnsResp = { factor: d.factor || d.name || gwBenchmark, dates: d.dates || [], ret: d.ret || [] };

        // ▼▼▼ 修改開始 ▼▼▼
        // 使用 clipByRange 強制將數據裁剪到 2003-01-01 之後
        // 你也可以把 "2003-01-01" 換成變數 start，這樣就會跟著上方日期選擇器連動
        const clipped = clipByRange(normalized, "2003-01-01", "2029-12-31");

        setBenchSeries(clipped);
        // ▲▲▲ 修改結束 (原本是 setBenchSeries(normalized)) ▲▲▲
      } catch (e) {
        setBenchSeries(null);
      }
    })();
  }, [gwBenchmark]); // 如果你上面改用 start 變數，記得這裡要改成 [gwBenchmark, start]

  // --- Helpers for Select All ---

  // 1. 左側控制面板的全選邏輯
  const isAllSelected = factors.length > 0 && selected.length === factors.length;
  const toggleAll = () => {
    if (isAllSelected) setSelected([]);
    else setSelected(factors);
  };

  // 2. Global Wave 的全選邏輯
  const isGwAllSelected = factors.length > 0 && gwSelected.length === factors.length;
  const toggleGwAll = () => {
    if (isGwAllSelected) setGwSelected([]);
    else setGwSelected(factors);
  };

  const copyTextToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
  };

  const orderedTableFactors = useMemo(() => {
    const priority = ["TWA00", "Top200"];
    const existingPriority = priority.filter((f) => factors.includes(f));
    const others = factors.filter((f) => !priority.includes(f));
    return [...existingPriority, ...others];
  }, [factors]);

  const buildRecentDailyTableText = () => {
    if (!recent20Table?.dates?.length) return "";
    const header = ["日期", ...orderedTableFactors.map((f) => getFactorLabel(f))];
    const rows = recent20DisplayDates.map((dt) => {
      const originalIdx = recent20Table.dates.indexOf(dt);
      return [
        dt,
        ...orderedTableFactors.map((f) => {
          const v = recent20Table.rows[f]?.[originalIdx] ?? null;
          const isMissing = v === null || v === undefined || Number.isNaN(v as any);
          return isMissing ? "-" : `${(v * 100).toFixed(2)}%`;
        }),
      ];
    });
    return [header, ...rows].map((row) => row.join("\t")).join("\n");
  };

  const buildRecentCumTableText = () => {
    if (!recentCumTable?.dates?.length) return "";
    const header = ["日期", ...orderedTableFactors.map((f) => getFactorLabel(f))];
    const rows = recentCumDisplayDates.map((dt) => {
      const originalIdx = recentCumTable.dates.indexOf(dt);
      return [
        dt,
        ...orderedTableFactors.map((f) => {
          const v = recentCumTable.rows[f]?.[originalIdx] ?? null;
          const isMissing = v === null || v === undefined || Number.isNaN(v as any);
          return isMissing ? "-" : v.toFixed(2);
        }),
      ];
    });
    return [header, ...rows].map((row) => row.join("\t")).join("\n");
  };

  // --- Memos ---
  const chartData = useMemo(() => {
    return selected
      .map((f) => {
        const d = series[f];
        if (!d || !d.dates?.length) return null;
        return { x: d.dates, y: toCum(d.ret || []), type: "scatter", mode: "lines", name: getFactorLabel(f) };
      })
      .filter(Boolean);
  }, [series, selected]);

  const gwBar = useMemo(() => {
    const x = gwSelected.map((f) => getFactorLabel(f));
    const key = gwHorizon === 6 ? "avg_6m" : "avg_12m";
    const troughY = gwSelected.map((f) => safeNum((gwData[f]?.summary?.trough as any)?.[key] ?? null));
    const peakY = gwSelected.map((f) => safeNum((gwData[f]?.summary?.peak as any)?.[key] ?? null));
    return [
      { name: `trough +${gwHorizon}M`, y: troughY, x, type: "bar", marker: { color: "#10b981" } },
      { name: `peak +${gwHorizon}M`, y: peakY, x, type: "bar", marker: { color: "#f43f5e" } },
    ];
  }, [gwSelected, gwData, gwHorizon]);

  const gwSignalTraces = useMemo(() => {
    if (!benchSeries?.dates?.length || !benchSeries?.ret?.length) return null;
    const x = benchSeries.dates;
    const y = toCum(benchSeries.ret);
    const eventPool: { type: "trough" | "peak"; date: string }[] = [];
    const anyFactor = Object.keys(gwData)[0];
    if (anyFactor && gwData[anyFactor]?.events?.length) {
      for (const e of gwData[anyFactor].events || []) {
        if (e?.date && (e.type === "trough" || e.type === "peak")) eventPool.push({ type: e.type, date: e.date });
      }
    }
    const peaksX: string[] = [],
      peaksY: number[] = [],
      troughX: string[] = [],
      troughY: number[] = [];
    for (const e of eventPool) {
      const idx = x.findIndex((d) => d >= e.date);
      if (idx === -1) continue;
      if (e.type === "peak") {
        peaksX.push(x[idx]);
        peaksY.push(y[idx]);
      } else {
        troughX.push(x[idx]);
        troughY.push(y[idx]);
      }
    }
    const shapes = eventPool.map((e) => ({
      type: "line",
      xref: "x",
      yref: "paper",
      x0: e.date,
      x1: e.date,
      y0: 0,
      y1: 1,
      line: { width: 1, color: e.type === "peak" ? "rgba(244,63,94,0.3)" : "rgba(16,185,129,0.3)", dash: "dot" },
    }));
    const traces = [
      { type: "scatter", mode: "lines", name: `基準指數 (${getFactorLabel(gwBenchmark)})`, x, y, line: { width: 2, color: "#3b82f6" } },
      {
        type: "scatter",
        mode: "markers",
        name: "Peak",
        x: peaksX,
        y: peaksY,
        marker: { symbol: "triangle-down", size: 10, color: "#f43f5e", line: { width: 1, color: "#fff" } },
      },
      {
        type: "scatter",
        mode: "markers",
        name: "Trough",
        x: troughX,
        y: troughY,
        marker: { symbol: "triangle-up", size: 10, color: "#10b981", line: { width: 1, color: "#fff" } },
      },
    ];
    return { traces, shapes };
  }, [benchSeries, gwData, gwBenchmark]);

  const recent20DisplayDates = useMemo(() => {
    if (!recent20Table?.dates?.length) return [];
    return [...recent20Table.dates].reverse();
  }, [recent20Table]);

  const recentCumDisplayDates = useMemo(() => {
    if (!recentCumTable?.dates?.length) return [];
    return [...recentCumTable.dates].reverse();
  }, [recentCumTable]);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans selection:bg-blue-100">
      {/* Header - Sticky with Blur */}
      <header className="sticky top-0 z-50 w-full border-b border-slate-200 bg-white/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-extrabold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-blue-700 to-indigo-600">
              因子投資系統
            </h1>
            <span className="rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-bold text-blue-700 border border-blue-200">
              NTHU
            </span>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/strategy-library"
              className="rounded-full bg-indigo-600 px-4 py-2 text-sm font-bold text-white shadow-sm hover:bg-indigo-700 transition-colors"
            >
              前往清大策略庫
            </Link>

            <div className="text-xs text-slate-500 font-medium hidden sm:block">Data: CMoney</div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
        {/* === 第一部分：區間表現分析 (Flex Layout for Side-by-Side) === */}
        <div className="flex flex-col lg:flex-row gap-8 mb-12">
          {/* 左側：控制面板 (Full Height) */}
          <section className="lg:w-1/3 bg-white rounded-2xl shadow-sm border border-slate-200 p-6 flex flex-col gap-6">
            <div className="flex items-center gap-2 border-b border-slate-100 pb-3">
              <span className="flex h-6 w-6 items-center justify-center rounded-md bg-blue-600 text-white">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4"
                  />
                </svg>
              </span>
              <h2 className="text-lg font-bold text-slate-800">系統控制</h2>
            </div>

            {/* 因子選擇 */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-bold uppercase text-slate-400 tracking-wider">選擇因子</label>
              </div>

              <div className="custom-scrollbar max-h-[320px] overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 p-3 shadow-inner">
                {/* ✅ 全選按鈕：改為列表內的第一個選項，樣式與下方完全一致，並加底線區隔 */}
                <label className="flex items-center gap-3 py-2 px-2 cursor-pointer hover:bg-slate-100 rounded transition-colors border-b border-slate-200 mb-1">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                    checked={isAllSelected}
                    onChange={toggleAll}
                  />
                  <span className="text-sm font-bold text-slate-800">全選所有因子</span>
                </label>

                {factors.map((f) => (
                  <label
                    key={f}
                    className="flex items-center justify-between py-2 px-2 cursor-pointer hover:bg-slate-100 rounded transition-colors group"
                  >
                    <div className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                        checked={selected.includes(f)}
                        onChange={(e) => {
                          if (e.target.checked) setSelected([...selected, f]);
                          else setSelected(selected.filter((x) => x !== f));
                        }}
                      />
                      <span className="text-sm font-medium text-slate-700">{getFactorLabel(f)}</span>
                    </div>

                    <Link
                      href={`/factor/${encodeURIComponent(f)}`}
                      className="p-1.5 rounded-md text-slate-300 hover:text-blue-600 hover:bg-blue-100 transition-all"
                      title="查看因子詳情"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                      </svg>
                    </Link>
                  </label>
                ))}
                {factors.length === 0 && <div className="text-sm text-slate-500 p-2">載入中...</div>}
              </div>
            </div>

            {/* 日期選擇 (日曆) */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-xs font-bold uppercase text-slate-400 tracking-wider mb-1 block">開始日期</label>
                <input
                  type="date"
                  className="w-full rounded-lg border-slate-200 text-sm font-medium focus:border-blue-500 focus:ring-blue-500 text-slate-700 bg-slate-50"
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                />
              </div>
              <div>
                <label className="text-xs font-bold uppercase text-slate-400 tracking-wider mb-1 block">結束日期</label>
                <input
                  type="date"
                  className="w-full rounded-lg border-slate-200 text-sm font-medium focus:border-blue-500 focus:ring-blue-500 text-slate-700 bg-slate-50"
                  value={end}
                  onChange={(e) => setEnd(e.target.value)}
                />
              </div>
            </div>

            {/* 無風險利率 */}
            <div>
              <label className="text-xs font-bold uppercase text-slate-400 tracking-wider mb-1 block">無風險利率 (Rf)</label>
              <div className="relative">
                <input
                  className="w-full rounded-lg border-slate-200 text-sm font-medium focus:border-blue-500 focus:ring-blue-500 text-slate-700 pl-3 pr-8"
                  type="number"
                  step="0.01"
                  value={rf}
                  onChange={(e) => setRf(parseFloat(e.target.value || "0"))}
                />
                <span className="absolute right-3 top-2 text-slate-400 text-sm">%</span>
              </div>
            </div>
          </section>

          {/* 右側：圖表與數據 */}
          <div className="lg:w-2/3 flex flex-col gap-6">
            {/* 圖表卡片 */}
            <section className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
              <div className="mb-4">
                <h2 className="text-lg font-bold text-slate-800">累積報酬走勢</h2>
                <p className="text-sm text-slate-500">區間累積績效比較</p>
              </div>
              <div className="w-full h-[400px]">
                <Plot
                  data={chartData as any}
                  layout={{
                    autosize: true,
                    margin: { l: 40, r: 20, t: 20, b: 40 },
                    showlegend: true,
                    legend: { orientation: "h", y: 1.1 },
                    xaxis: { gridcolor: "#f1f5f9" },
                    yaxis: { gridcolor: "#f1f5f9" },
                  }}
                  style={{ width: "100%", height: "100%" }}
                  useResizeHandler
                  config={{ displayModeBar: false }}
                />
              </div>
            </section>

            {/* 績效指標表格 */}
            <section className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
              <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/50">
                <h3 className="text-base font-semibold text-slate-800">績效指標分析</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead className="bg-white text-slate-500 border-b border-slate-200">
                    <tr>
                      <th className="px-6 py-3 font-semibold">因子名稱</th>
                      <th className="px-6 py-3 font-semibold">區間報酬</th>
                      <th className="px-6 py-3 font-semibold">年化報酬</th>
                      <th className="px-6 py-3 font-semibold">年化波動</th>
                      <th className="px-6 py-3 font-semibold">夏普比率</th>
                      <th className="px-6 py-3 font-semibold">最大回撤</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {metrics.map((row) => (
                      <tr key={row.factor} className="hover:bg-blue-50/50 transition-colors">
                        <td className="px-6 py-3 font-medium text-slate-900">
                          <Link
                            href={`/factor/${encodeURIComponent(row.factor)}`}
                            className="hover:underline text-slate-900 flex items-center gap-1"
                          >
                            {getFactorLabel(row.factor)}
                            <svg className="w-3 h-3 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                strokeWidth={2}
                                d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                              />
                            </svg>
                          </Link>
                        </td>

                        <td className={`px-6 py-3 font-bold ${row.period_return >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                          {(row.period_return * 100).toFixed(2)}%
                        </td>

                        <td className={`px-6 py-3 font-bold ${row.ann_return >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                          {(row.ann_return * 100).toFixed(2)}%
                        </td>

                        <td className="px-6 py-3 text-slate-600">{(row.ann_vol * 100).toFixed(2)}%</td>
                        <td className="px-6 py-3 text-slate-600">{row.sharpe === null ? "-" : row.sharpe.toFixed(2)}</td>
                        <td className="px-6 py-3 text-rose-600">{(row.maxdd * 100).toFixed(2)}%</td>
                      </tr>
                    ))}

                    {metrics.length === 0 && (
                      <tr>
                        <td colSpan={6} className="px-6 py-8 text-center text-slate-400">
                          暫無資料
                        </td>
                      </tr>
                    )}
                  </tbody>                  
                </table>
              </div>
            </section>
          </div>
        </div>

        {/* === 第二部分：熱力圖 (Distinct Section) === */}
        <section className="bg-white rounded-2xl shadow-lg border border-slate-200 p-8 mb-12">
          <div className="flex flex-col sm:flex-row sm:items-end justify-between mb-6 gap-4">
            <div>
              <h2 className="text-2xl font-bold text-slate-900">因子表現熱力圖</h2>
              <p className="text-sm text-slate-500 mt-1">近 12 個月因子績效排名（每月由上至下排序，顏色代表不同因子）</p>
            </div>
          </div>

          <div className="rounded-xl border border-slate-100 overflow-hidden bg-white">
            {!heatmap?.months ? (
              <div className="h-[600px] flex items-center justify-center text-slate-400 animate-pulse">資料讀取中...</div>
            ) : (
              (() => {
                const months: string[] = heatmap.months;
                const rankedFactors: string[][] = heatmap.ranked_factors;
                const rankedReturns: (number | null)[][] = heatmap.ranked_returns;
                const N = rankedFactors?.[0]?.length ?? 0;
                const factorList: string[] =
                  heatmap.factors && Array.isArray(heatmap.factors) ? heatmap.factors : Array.from(new Set(rankedFactors.flat()));
                const factorToCode: Record<string, number> = {};
                factorList.forEach((f, i) => (factorToCode[f] = i));
                const colors = factorList.map((f) => FACTOR_COLORS[f] || "#d1d5db");
                const colorscale = makeDiscreteColorscale(colors);
                const z: number[][] = Array.from({ length: N }, () => Array(months.length).fill(0));
                const text: string[][] = Array.from({ length: N }, () => Array(months.length).fill(""));

                for (let col = 0; col < months.length; col++) {
                  for (let row = 0; row < N; row++) {
                    const fname = rankedFactors[col]?.[row] ?? "";
                    const r = rankedReturns?.[col]?.[row];
                    z[row][col] = factorToCode[fname] ?? -1;
                    const pct = r === null || r === undefined ? "NA" : `${((r as number) * 100).toFixed(2)}%`;
                    text[row][col] = `<span style="font-weight:500">${getFactorLabel(fname)}</span><br>${pct}`;
                  }
                }
                const y = Array.from({ length: N }, (_, i) => i + 1);

                return (
                  <Plot
                    data={[
                      {
                        type: "heatmap",
                        z,
                        x: months,
                        y,
                        text,
                        texttemplate: "%{text}",
                        textfont: { size: 10, color: "black" },
                        constraintext: "both",
                        hovertemplate: "月份: %{x}<br>排名: %{y}<br>%{text}<extra></extra>",
                        colorscale,
                        showscale: false,
                        zmin: 0,
                        zmax: factorList.length - 1,
                      },
                    ] as any}
                    layout={{
                      margin: { l: 40, r: 20, t: 20, b: 80 },
                      height: 700,
                      xaxis: { type: "category", tickangle: -45 },
                      yaxis: { autorange: "reversed", tickmode: "array", tickvals: y },
                    }}
                    style={{ width: "100%" }}
                    config={{ displayModeBar: false }}
                  />
                );
              })()
            )}
          </div>
        </section>

        {/* === 新增：近 X 個交易日因子報酬率詳細表 === */}
        <section className="bg-white rounded-2xl shadow-lg border border-slate-200 p-8 mb-12">
          <div className="flex flex-col gap-8">
            <div>
              <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-6">
                <div className="flex-1">
                  <button
                    onClick={() => setRecent20Expanded(!recent20Expanded)}
                    className="flex items-center gap-2 hover:opacity-70 transition-opacity"
                  >
                    <svg
                      className={`w-5 h-5 text-slate-600 transition-transform ${recent20Expanded ? "rotate-90" : ""}`}
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                    <h2 className="text-2xl font-bold text-slate-900">近 {recentTradingDays} 個交易日因子報酬率詳細表</h2>
                  </button>
                  <p className="text-sm text-slate-500 mt-1">顯示所有因子最近 x 個有交易日的每日報酬率，缺值以 - 表示</p>
                </div>

                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2">
                    <label className="text-sm font-medium text-slate-600">天數</label>
                    <input
                      type="number"
                      min={1}
                      className="w-24 rounded-lg border-slate-200 text-sm font-medium focus:border-blue-500 focus:ring-blue-500 text-slate-700"
                      value={recentTradingDays}
                      onChange={(e) => setRecentTradingDays(Math.max(1, parseInt(e.target.value || "1", 10)))}
                    />
                  </div>

                  <button
                    onClick={() => copyTextToClipboard(buildRecentDailyTableText())}
                    className="inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white p-2 text-slate-600 hover:bg-slate-50 hover:text-blue-600 transition-colors"
                    title="複製表格"
                  >
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h6a2 2 0 002-2v-8a2 2 0 00-2-2h-6a2 2 0 00-2 2v8a2 2 0 002 2z"
                      />
                    </svg>
                  </button>
                </div>
              </div>

              {recent20Expanded && (
                <div className="rounded-xl border border-slate-200 overflow-hidden bg-white">
                  {recent20Loading ? (
                    <div className="h-[320px] flex items-center justify-center text-slate-400 animate-pulse">資料讀取中...</div>
                  ) : !recent20Table?.dates?.length ? (
                    <div className="h-[320px] flex items-center justify-center text-slate-400">暫無資料</div>
                  ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm text-left">
                      <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
                        <tr>
                          <th className="px-4 py-3 font-semibold sticky left-0 z-30 bg-slate-50 border-r border-slate-200 whitespace-nowrap min-w-[120px]">
                            日期
                          </th>
                          {orderedTableFactors.map((f, idx) => (
                            <th
                              key={`recent-head-${f}`}
                              className={`px-4 py-3 font-semibold whitespace-nowrap min-w-[120px] ${
                                idx === 0
                                  ? "sticky left-[120px] z-20 bg-slate-200 border-r border-slate-500"
                                  : idx === 1
                                  ? "sticky left-[240px] z-20 bg-slate-200 border-r border-slate-500"
                                  : ""
                              }`}
                            >
                              {getFactorLabel(f)}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {recent20DisplayDates.map((dt) => {
                          const originalIdx = recent20Table.dates.indexOf(dt);
                          return (
                            <tr key={`recent-row-${dt}`} className="hover:bg-slate-50 transition-colors">
                              <td className="px-4 py-3 font-medium text-slate-700 sticky left-0 z-30 bg-white border-r border-slate-100 whitespace-nowrap min-w-[120px]">
                                {dt}
                              </td>
                              {orderedTableFactors.map((f, idx) => {
                                const v = recent20Table.rows[f]?.[originalIdx] ?? null;
                                const isMissing = v === null || v === undefined || Number.isNaN(v as any);
                                return (
                                  <td
                                    key={`recent-cell-${dt}-${f}`}
                                    className={`px-4 py-3 whitespace-nowrap min-w-[120px] ${
                                      idx === 0
                                        ? "sticky left-[120px] z-20 bg-white border-r border-slate-100"
                                        : idx === 1
                                        ? "sticky left-[240px] z-20 bg-white border-r border-slate-100"
                                        : ""
                                    } ${
                                      isMissing ? "text-slate-400" : v >= 0 ? "text-emerald-600 font-medium" : "text-rose-600 font-medium"
                                    }`}
                                  >
                                    {isMissing ? "-" : `${(v * 100).toFixed(2)}%`}
                                  </td>
                                );
                              })}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                </div>
              )}
            </div>

            <div>
              <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-6">
                <div className="flex-1">
                  <button
                    onClick={() => setRecentCumExpanded(!recentCumExpanded)}
                    className="flex items-center gap-2 hover:opacity-70 transition-opacity"
                  >
                    <svg
                      className={`w-5 h-5 text-slate-600 transition-transform ${recentCumExpanded ? "rotate-90" : ""}`}
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                    <h2 className="text-2xl font-bold text-slate-900">近 {recentCumDays} 日累積表現</h2>
                  </button>
                  <p className="text-sm text-slate-500 mt-1">統一以2003年初為100，之後按報酬率累積成長，缺值以 - 表示</p>
                </div>

                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2">
                    <label className="text-sm font-medium text-slate-600">天數</label>
                    <input
                      type="number"
                      min={1}
                      className="w-24 rounded-lg border-slate-200 text-sm font-medium focus:border-blue-500 focus:ring-blue-500 text-slate-700"
                      value={recentCumDays}
                      onChange={(e) => setRecentCumDays(Math.max(1, parseInt(e.target.value || "1", 10)))}
                    />
                  </div>

                  <button
                    onClick={() => copyTextToClipboard(buildRecentCumTableText())}
                    className="inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white p-2 text-slate-600 hover:bg-slate-50 hover:text-blue-600 transition-colors"
                    title="複製表格"
                  >
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h6a2 2 0 002-2v-8a2 2 0 00-2-2h-6a2 2 0 00-2 2v8a2 2 0 002 2z"
                      />
                    </svg>
                  </button>
                </div>
              </div>

              {recentCumExpanded && (
                <div className="rounded-xl border border-slate-200 overflow-hidden bg-white">
                  {recentCumLoading ? (
                    <div className="h-[320px] flex items-center justify-center text-slate-400 animate-pulse">資料讀取中...</div>
                  ) : !recentCumTable?.dates?.length ? (
                    <div className="h-[320px] flex items-center justify-center text-slate-400">暫無資料</div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm text-left">
                        <thead className="bg-slate-50 text-slate-600 border-b border-slate-200">
                          <tr>
                            <th className="px-4 py-3 font-semibold sticky left-0 z-30 bg-slate-50 border-r border-slate-200 whitespace-nowrap min-w-[120px]">
                              日期
                            </th>
                            {orderedTableFactors.map((f, idx) => (
                              <th
                                key={`recent-cum-head-${f}`}
                                className={`px-4 py-3 font-semibold whitespace-nowrap min-w-[120px] ${
                                  idx === 0
                                    ? "sticky left-[120px] z-20 bg-slate-200 border-r border-slate-500"
                                    : idx === 1
                                    ? "sticky left-[240px] z-20 bg-slate-200 border-r border-slate-500"
                                    : ""
                                }`}
                              >
                                {getFactorLabel(f)}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {recentCumDisplayDates.map((dt) => {
                            const originalIdx = recentCumTable.dates.indexOf(dt);
                            return (
                              <tr key={`recent-cum-row-${dt}`} className="hover:bg-slate-50 transition-colors">
                                <td className="px-4 py-3 font-medium text-slate-700 sticky left-0 z-30 bg-white border-r border-slate-100 whitespace-nowrap min-w-[120px]">
                                  {dt}
                                </td>
                                {orderedTableFactors.map((f, idx) => {
                                  const v = recentCumTable.rows[f]?.[originalIdx] ?? null;
                                  const isMissing = v === null || v === undefined || Number.isNaN(v as any);
                                  return (
                                    <td
                                      key={`recent-cum-cell-${dt}-${f}`}
                                      className={`px-4 py-3 whitespace-nowrap min-w-[120px] ${
                                        idx === 0
                                          ? "sticky left-[120px] z-20 bg-white border-r border-slate-100"
                                          : idx === 1
                                          ? "sticky left-[240px] z-20 bg-white border-r border-slate-100"
                                          : ""
                                      } ${
                                        isMissing ? "text-slate-400" : v >= 100 ? "text-emerald-600 font-medium" : "text-rose-600 font-medium"
                                      }`}
                                    >
                                      {isMissing ? "-" : v.toFixed(2)}
                                    </td>
                                  );
                                })}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </section>

        {/* === 第三部分：Global Wave (Distinct Section) === */}
        <section className="bg-white rounded-2xl shadow-lg border border-slate-200 p-8">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-8 border-b border-slate-100 pb-6">
            <div>
              <h2 className="text-2xl font-bold text-slate-900">Global Wave</h2>
              <p className="text-sm text-slate-500 mt-1">分析歷史波峰 (Peak) 與波谷 (Trough) 訊號後的因子表現</p>
            </div>

            {/* Horizon Toggle */}
            <div className="bg-slate-100 p-1 rounded-lg inline-flex">
              <button
                onClick={() => setGwHorizon(6)}
                className={`px-4 py-1.5 text-sm font-bold rounded-md transition-all ${
                  gwHorizon === 6 ? "bg-white text-blue-600 shadow-sm" : "text-slate-500 hover:text-slate-700"
                }`}
              >
                +6 個月
              </button>
              <button
                onClick={() => setGwHorizon(12)}
                className={`px-4 py-1.5 text-sm font-bold rounded-md transition-all ${
                  gwHorizon === 12 ? "bg-white text-blue-600 shadow-sm" : "text-slate-500 hover:text-slate-700"
                }`}
              >
                +12 個月
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
            {/* GW Sidebar */}
            <div className="lg:col-span-4 flex flex-col gap-6">
              <div className="bg-slate-50 rounded-xl p-5 border border-slate-100">
                <h3 className="text-xs font-bold uppercase text-slate-400 tracking-wider mb-3">比較因子</h3>
                <div className="max-h-60 overflow-y-auto custom-scrollbar pr-2 space-y-1">
                  {/* ✅ Global Wave 全選按鈕：同樣改為 Checkbox Row，跟上面保持一致 */}
                  <label className="flex items-center gap-3 p-2 rounded-lg hover:bg-white hover:shadow-sm cursor-pointer transition-all border-b border-slate-200 mb-1">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                      checked={isGwAllSelected}
                      onChange={toggleGwAll}
                    />
                    <span className="text-sm font-bold text-slate-800">全選所有因子</span>
                  </label>

                  {factors.map((f) => (
                    <label
                      key={`gw-${f}`}
                      className="flex items-center gap-3 p-2 rounded-lg hover:bg-white hover:shadow-sm cursor-pointer transition-all"
                    >
                      <input
                        type="checkbox"
                        className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                        checked={gwSelected.includes(f)}
                        onChange={(e) => {
                          if (e.target.checked) setGwSelected([...gwSelected, f]);
                          else setGwSelected(gwSelected.filter((x) => x !== f));
                        }}
                      />
                      <span className="text-sm font-medium text-slate-700">{getFactorLabel(f)}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>

            {/* GW Bar Chart */}
            <div className="lg:col-span-8">
              <div className="bg-white rounded-xl border border-slate-100 p-4 h-full flex flex-col justify-center">
                {gwLoading ? (
                  <div className="text-center text-slate-400 py-10">讀取中...</div>
                ) : gwSelected.length === 0 ? (
                  <div className="text-center text-slate-400 py-10">請選擇至少一個因子進行比較</div>
                ) : (
                  <Plot
                    data={gwBar as any}
                    layout={{
                      barmode: "group",
                      margin: { l: 60, r: 20, t: 20, b: 80 },
                      height: 350,
                      yaxis: { tickformat: ".1%", gridcolor: "#f1f5f9" },
                      xaxis: { tickangle: -30 },
                      legend: { orientation: "h", y: 1.2, x: 0 },
                    }}
                    style={{ width: "100%" }}
                    config={{ displayModeBar: false }}
                  />
                )}
              </div>
            </div>
          </div>

          {/* GW Summary Table */}
          <div className="mt-8">
            <h3 className="text-sm font-bold uppercase text-slate-500 tracking-wider mb-3">數據摘要</h3>
            <div className="overflow-x-auto rounded-xl border border-slate-200">
              <table className="w-full text-sm text-left">
                <thead className="bg-slate-50 text-slate-600 font-semibold">
                  <tr>
                    <th className="px-4 py-3">因子名稱</th>
                    <th className="px-4 py-3 text-emerald-600">Trough +6M</th>
                    <th className="px-4 py-3 text-emerald-600">Trough +12M</th>
                    <th className="px-4 py-3 text-rose-600">Peak +6M</th>
                    <th className="px-4 py-3 text-rose-600">Peak +12M</th>
                    <th className="px-4 py-3">Trough 次數</th>
                    <th className="px-4 py-3">Peak 次數</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {gwSelected.map((f) => {
                    const d = gwData[f];
                    const tr = d?.summary?.trough;
                    const pk = d?.summary?.peak;
                    return (
                      <tr key={`gw-row-${f}`} className="hover:bg-slate-50 transition-colors">
                        <td className="px-4 py-3 font-medium">{getFactorLabel(f)}</td>
                        <td className="px-4 py-3">{fmtPct(tr?.avg_6m ?? null)}</td>
                        <td className="px-4 py-3">{fmtPct(tr?.avg_12m ?? null)}</td>
                        <td className="px-4 py-3">{fmtPct(pk?.avg_6m ?? null)}</td>
                        <td className="px-4 py-3">{fmtPct(pk?.avg_12m ?? null)}</td>
                        <td className="px-4 py-3">{tr?.n_events ?? "-"}</td>
                        <td className="px-4 py-3">{pk?.n_events ?? "-"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* GW Signal Chart (Dark Theme for Contrast) */}
          <div className="mt-10 p-1 bg-slate-100 rounded-2xl">
            <div className="bg-slate-900 rounded-xl p-6 shadow-inner text-slate-200">
              <div className="flex flex-col md:flex-row items-center justify-between mb-4 gap-4">
                <div>
                  <h3 className="text-lg font-bold text-white">訊號歷史回測</h3>
                  <p className="text-xs text-slate-400">藍線：基準指數｜紅▼：Peak 訊號｜綠▲：Trough 訊號</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-400 font-bold uppercase">基準指數</span>
                  <select
                    className="rounded bg-slate-800 border-slate-700 text-sm text-white focus:ring-blue-500"
                    value={gwBenchmark}
                    onChange={(e) => setGwBenchmark(e.target.value)}
                  >
                    {factors.map((f) => (
                      <option key={`bench-${f}`} value={f}>
                        {getFactorLabel(f)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {!gwSignalTraces ? (
                <div className="h-[400px] flex items-center justify-center text-slate-600">讀取中...</div>
              ) : (
                <Plot
                  data={gwSignalTraces.traces as any}
                  layout={{
                    margin: { l: 50, r: 20, t: 20, b: 50 },
                    height: 420,
                    xaxis: { type: "date", gridcolor: "#334155", tickcolor: "#94a3b8", tickfont: { color: "#cbd5e1" } },
                    yaxis: {
                      title: "累積報酬",
                      gridcolor: "#334155",
                      tickcolor: "#94a3b8",
                      tickfont: { color: "#cbd5e1" },
                      titlefont: { color: "#cbd5e1" },
                    },
                    paper_bgcolor: "rgba(0,0,0,0)",
                    plot_bgcolor: "rgba(0,0,0,0)",
                    legend: { orientation: "h", y: 1.1, font: { color: "#e2e8f0" } },
                    shapes: gwSignalTraces.shapes,
                  }}
                  style={{ width: "100%" }}
                  useResizeHandler
                  config={{ displayModeBar: false }}
                />
              )}
            </div>
          </div>
        </section>
      </main>

      <style jsx global>{`
        /* 自定義滾動條樣式，讓列表更精緻 */
        .custom-scrollbar::-webkit-scrollbar {
          width: 6px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background-color: #cbd5e1;
          border-radius: 20px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background-color: #94a3b8;
        }
      `}</style>
    </div>
  );
}
