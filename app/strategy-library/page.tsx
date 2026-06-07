"use client";

import React, { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";

const Plot = dynamic(() => import("react-plotly.js"), { ssr: false });

const GH_OWNER = "alfred0630";
const GH_REPO = "factor-platform-database";
const GH_BRANCH = "main";

const RAW_BASE = `https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${GH_BRANCH}`;
const API_BASE = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents`;

type ReturnsResp = {
  name?: string;
  factor?: string;
  dates: string[];
  ret: number[];
};

type HoldingsResp = {
  factor: string;
  asof?: string;
  months: string[];
  holdings: Record<string, string[]>;
};

type MetricRow = {
  factor: string;
  periodReturn: number;
  annReturn: number;
  annVol: number;
  sharpe: number | null;
  maxdd: number;
};

type GithubFile = {
  name: string;
  path?: string;
  type: string;
};

type StockNamesResp = Record<string, string>;

const FACTOR_LABELS: Record<string, string> = {
  StarSearch: "StarSearch",
  EPS_growth: "EPS 動能",
  High_yield: "高股息",
  High_yoy: "營收成長",
  Low_beta: "低 Beta",
  Margin_growth: "利潤率成長",
  Momentum_01: "價格動能 1M",
  Momentum_03: "價格動能 3M",
  Momentum_06: "價格動能 6M",
  PB_low: "低 PB",
  PE_low: "低 PE",
  Top200: "市值前 200",
  TWA00: "加權指數",
};

function getFactorLabel(name: string) {
  return FACTOR_LABELS[name] || name;
}

function parseDate(s: string) {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmtPct(x: number | null | undefined) {
  if (x === null || x === undefined || Number.isNaN(x as any)) return "-";
  return `${(x * 100).toFixed(2)}%`;
}

function toCum(retArr: number[]) {
  let v = 1;
  return retArr.map((r) => {
    v *= 1 + r;
    return v;
  });
}

function maxDrawdownFromReturns(ret: number[]) {
  let nav = 1;
  let peak = 1;
  let maxdd = 0;

  for (const r of ret) {
    nav *= 1 + r;
    if (nav > peak) peak = nav;
    const dd = nav / peak - 1;
    if (dd < maxdd) maxdd = dd;
  }

  return maxdd;
}

function clipReturns(d: ReturnsResp, start: string, end: string): ReturnsResp {
  const s = parseDate(start);
  const e = parseDate(end);
  if (!s || !e) return d;

  const dates: string[] = [];
  const ret: number[] = [];

  for (let i = 0; i < d.dates.length; i++) {
    const di = parseDate(d.dates[i]);
    if (!di) continue;

    if (di >= s && di <= e) {
      dates.push(d.dates[i]);
      ret.push(d.ret[i]);
    }
  }

  return {
    ...d,
    dates,
    ret,
  };
}

function calcMetrics(factor: string, ret: number[], freq = 252): MetricRow {
  if (!ret.length) {
    return {
      factor,
      periodReturn: 0,
      annReturn: 0,
      annVol: 0,
      sharpe: null,
      maxdd: 0,
    };
  }

  let nav = 1;
  for (const r of ret) nav *= 1 + r;

  const n = ret.length;
  const periodReturn = nav - 1;
  const annReturn = Math.pow(nav, freq / n) - 1;

  const mean = ret.reduce((a, b) => a + b, 0) / n;
  const variance = ret.reduce((a, r) => a + (r - mean) ** 2, 0) / Math.max(1, n - 1);
  const annVol = Math.sqrt(variance * freq);

  const sharpe = annVol === 0 ? null : (mean * freq) / annVol;
  const maxdd = maxDrawdownFromReturns(ret);

  return {
    factor,
    periodReturn,
    annReturn,
    annVol,
    sharpe,
    maxdd,
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: "no-store" });

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`fetch failed ${r.status}: ${url}\n${t.slice(0, 200)}`);
  }

  return (await r.json()) as T;
}

function jsonFileStem(fileName: string) {
  return fileName.replace(/\.json$/i, "");
}

async function listJsonFileStems(folder: string): Promise<string[]> {
  const url = `${API_BASE}/${folder}?ref=${GH_BRANCH}`;
  const files = await fetchJson<GithubFile[]>(url);

  return files
    .filter((x) => x.type === "file")
    .filter((x) => typeof x.name === "string" && x.name.toLowerCase().endsWith(".json"))
    .map((x) => jsonFileStem(x.name))
    .sort((a, b) => a.localeCompare(b));
}

async function listStrategyNames(): Promise<string[]> {
  const [returnNames, holdingNames] = await Promise.all([
    listJsonFileStems("strategy_data/returns"),
    listJsonFileStems("strategy_data/holdings"),
  ]);

  const holdingSet = new Set(holdingNames);
  const bothSides = returnNames.filter((name) => holdingSet.has(name));

  if (bothSides.length > 0) return bothSides;

  return returnNames;
}

export default function FactorLibraryPage() {
  const [factors, setFactors] = useState<string[]>([]);
  const [selectedFactors, setSelectedFactors] = useState<string[]>([]);
  const [returnsMap, setReturnsMap] = useState<Record<string, ReturnsResp>>({});
  const [holdingsMap, setHoldingsMap] = useState<Record<string, HoldingsResp>>({});
  const [stockNames, setStockNames] = useState<StockNamesResp>({});

  const [start, setStart] = useState("2005-01-01");
  const [end, setEnd] = useState("2026-12-31");

  const [expandedFactor, setExpandedFactor] = useState<string | null>(null);
  const [selectedMonth, setSelectedMonth] = useState<string>("");

  const [basketFactors, setBasketFactors] = useState<string[]>([]);
  const [mode, setMode] = useState<"intersection" | "union">("intersection");

  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");

  const getStockDisplay = (stockCode: string) => {
    const code = String(stockCode);
    const name = stockNames[code];
    return name ? `${code}｜${name}` : code;
  };

  useEffect(() => {
    (async () => {
      setLoading(true);
      setErrorMsg("");

      try {
        const names = await listStrategyNames();
        setFactors(names);

        const defaults = names.includes("StarSearch") ? ["StarSearch"] : names.slice(0, 1);
        setSelectedFactors(defaults);
      } catch (e: any) {
        setErrorMsg(
          "自動掃描策略失敗。請確認 GitHub repo 是公開的，而且 strategy_data/returns 與 strategy_data/holdings 路徑存在。"
        );
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const d = await fetchJson<StockNamesResp>(`${RAW_BASE}/data/stock_names.json`);
        setStockNames(d || {});
      } catch {
        setStockNames({});
      }
    })();
  }, []);

  useEffect(() => {
    (async () => {
      if (!selectedFactors.length) {
        setReturnsMap({});
        setHoldingsMap({});
        return;
      }

      setLoading(true);
      setErrorMsg("");

      try {
        const returnPairs = await Promise.all(
          selectedFactors.map(async (f): Promise<[string, ReturnsResp]> => {
            const d = await fetchJson<ReturnsResp>(
              `${RAW_BASE}/strategy_data/returns/${encodeURIComponent(f)}.json`
            );

            const normalized: ReturnsResp = {
              name: d.name || d.factor || f,
              factor: d.factor || d.name || f,
              dates: d.dates || [],
              ret: d.ret || [],
            };

            return [f, normalized];
          })
        );

        const holdingsPairs = await Promise.all(
          selectedFactors.map(async (f): Promise<[string, HoldingsResp]> => {
            try {
              const d = await fetchJson<HoldingsResp>(
                `${RAW_BASE}/strategy_data/holdings/${encodeURIComponent(f)}.json`
              );

              const normalized: HoldingsResp = {
                factor: d.factor || f,
                asof: d.asof,
                months: d.months || Object.keys(d.holdings || {}).sort(),
                holdings: d.holdings || {},
              };

              return [f, normalized];
            } catch {
              return [
                f,
                {
                  factor: f,
                  months: [] as string[],
                  holdings: {},
                },
              ];
            }
          })
        );

        const retObj: Record<string, ReturnsResp> = {};
        const holdObj: Record<string, HoldingsResp> = {};

        for (const [f, d] of returnPairs) retObj[f] = d;
        for (const [f, d] of holdingsPairs) holdObj[f] = d;

        setReturnsMap((prev) => ({ ...prev, ...retObj }));
        setHoldingsMap((prev) => ({ ...prev, ...holdObj }));

        const allMonths = Array.from(
          new Set(holdingsPairs.flatMap(([, d]) => d.months || []))
        ).sort();

        if (!selectedMonth && allMonths.length) {
          setSelectedMonth(allMonths[allMonths.length - 1]);
        }
      } catch (e: any) {
        setErrorMsg("讀取策略報酬或持股資料失敗，請確認 returns / holdings 檔名是否一致。");
      } finally {
        setLoading(false);
      }
    })();
  }, [selectedFactors]);

  const clippedReturnsMap = useMemo(() => {
    const obj: Record<string, ReturnsResp> = {};

    for (const f of selectedFactors) {
      const d = returnsMap[f];
      if (!d) continue;
      obj[f] = clipReturns(d, start, end);
    }

    return obj;
  }, [returnsMap, selectedFactors, start, end]);

  const metrics = useMemo(() => {
    return selectedFactors.map((f) => {
      const d = clippedReturnsMap[f];
      return calcMetrics(f, d?.ret || []);
    });
  }, [selectedFactors, clippedReturnsMap]);

  const chartData = useMemo(() => {
    return selectedFactors
      .map((f) => {
        const d = clippedReturnsMap[f];
        if (!d?.dates?.length) return null;

        return {
          x: d.dates,
          y: toCum(d.ret),
          type: "scatter",
          mode: "lines",
          name: getFactorLabel(f),
        };
      })
      .filter(Boolean);
  }, [selectedFactors, clippedReturnsMap]);

  const allMonths = useMemo(() => {
    const s = new Set<string>();

    for (const f of selectedFactors) {
      const d = holdingsMap[f];
      for (const m of d?.months || []) s.add(m);
    }

    return Array.from(s).sort();
  }, [selectedFactors, holdingsMap]);

  const holdingsForExpanded = useMemo(() => {
    if (!expandedFactor || !selectedMonth) return [];
    return holdingsMap[expandedFactor]?.holdings?.[selectedMonth] || [];
  }, [expandedFactor, selectedMonth, holdingsMap]);

  const intersectionOrUnion = useMemo(() => {
    if (!basketFactors.length || !selectedMonth) return [];

    const lists = basketFactors.map((f) => holdingsMap[f]?.holdings?.[selectedMonth] || []);

    if (mode === "union") {
      return Array.from(new Set(lists.flat())).sort();
    }

    const [first, ...rest] = lists;
    if (!first) return [];

    return first
      .filter((stock) => rest.every((list) => list.includes(stock)))
      .sort();
  }, [basketFactors, selectedMonth, holdingsMap, mode]);

  const toggleSelectedFactor = (factor: string) => {
    if (selectedFactors.includes(factor)) {
      setSelectedFactors(selectedFactors.filter((x) => x !== factor));
      setBasketFactors(basketFactors.filter((x) => x !== factor));
    } else {
      setSelectedFactors([...selectedFactors, factor]);
    }
  };

  const addToBasket = (factor: string) => {
    if (!basketFactors.includes(factor)) {
      setBasketFactors([...basketFactors, factor]);
    }
  };

  const removeFromBasket = (factor: string) => {
    setBasketFactors(basketFactors.filter((x) => x !== factor));
  };

  const toggleBasketFactor = (factor: string) => {
    if (basketFactors.includes(factor)) {
      removeFromBasket(factor);
    } else {
      addToBasket(factor);
    }
  };

  const selectAllBasketFactors = () => {
    setBasketFactors(factors);
  };

  const clearBasketFactors = () => {
    setBasketFactors([]);
  };

  const copyStocks = async (stocks: string[]) => {
    const text = stocks.map((stock) => getStockDisplay(stock)).join("、");

    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans selection:bg-indigo-100">
      <header className="sticky top-0 z-50 border-b border-slate-200 bg-white/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-extrabold tracking-tight text-transparent bg-clip-text bg-gradient-to-r from-indigo-700 to-blue-600">
                清大策略庫
              </h1>
              <span className="rounded-full bg-indigo-100 px-2.5 py-0.5 text-xs font-bold text-indigo-700 border border-indigo-200">
                Strategy Lab
              </span>
            </div>

            <p className="mt-1 text-sm text-slate-500">
              自動掃描 strategy_data，查看策略報酬、月份持股與選股交集
            </p>
          </div>

          <Link
            href="/"
            className="rounded-full border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-700 shadow-sm hover:bg-slate-50"
          >
            回主頁
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
        {errorMsg && (
          <div className="mb-6 rounded-xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm font-medium text-rose-700">
            {errorMsg}
          </div>
        )}

        <section className="mb-8 grid grid-cols-1 gap-6 lg:grid-cols-12">
          <aside className="lg:col-span-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="mb-5 flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold text-slate-900">策略選擇</h2>
                <p className="text-sm text-slate-500">掃描到 {factors.length} 個策略</p>
              </div>

              <div className="flex gap-2">
                <button
                  onClick={() => setSelectedFactors(factors)}
                  className="rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-200"
                >
                  全選
                </button>

                <button
                  onClick={() => {
                    setSelectedFactors([]);
                    setBasketFactors([]);
                  }}
                  className="rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-200"
                >
                  清空
                </button>
              </div>
            </div>

            <div className="mb-6 max-h-[360px] overflow-y-auto rounded-xl border border-slate-200 bg-slate-50 p-3">
              {loading && !factors.length ? (
                <div className="p-3 text-sm text-slate-400">資料讀取中...</div>
              ) : factors.length === 0 ? (
                <div className="p-3 text-sm text-slate-400">
                  沒有掃描到策略。請確認 strategy_data/returns 裡有 JSON。
                </div>
              ) : (
                factors.map((factor) => (
                  <div
                    key={factor}
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData("text/plain", factor)}
                    className="mb-2 flex items-center justify-between rounded-lg bg-white px-3 py-2 shadow-sm border border-slate-100 cursor-move"
                  >
                    <label className="flex items-center gap-3">
                      <input
                        type="checkbox"
                        checked={selectedFactors.includes(factor)}
                        onChange={() => toggleSelectedFactor(factor)}
                        className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                      />

                      <span className="text-sm font-medium text-slate-700">
                        {getFactorLabel(factor)}
                      </span>
                    </label>

                    <button
                      onClick={() => addToBasket(factor)}
                      className="rounded-md bg-indigo-50 px-2 py-1 text-xs font-bold text-indigo-600 hover:bg-indigo-100"
                    >
                      加入
                    </button>
                  </div>
                ))
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="mb-1 block text-xs font-bold uppercase tracking-wider text-slate-400">
                  開始日期
                </label>

                <input
                  type="date"
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                  className="w-full rounded-lg border-slate-200 bg-slate-50 text-sm font-medium text-slate-700 focus:border-indigo-500 focus:ring-indigo-500"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-bold uppercase tracking-wider text-slate-400">
                  結束日期
                </label>

                <input
                  type="date"
                  value={end}
                  onChange={(e) => setEnd(e.target.value)}
                  className="w-full rounded-lg border-slate-200 bg-slate-50 text-sm font-medium text-slate-700 focus:border-indigo-500 focus:ring-indigo-500"
                />
              </div>
            </div>
          </aside>

          <section className="lg:col-span-8 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-bold text-slate-900">策略歷史區間報酬</h2>
                <p className="text-sm text-slate-500">
                  依照左側日期區間重新計算累積報酬與績效指標
                </p>
              </div>

              {loading && (
                <span className="rounded-full bg-indigo-50 px-3 py-1 text-xs font-bold text-indigo-600">
                  更新中
                </span>
              )}
            </div>

            <div className="h-[420px]">
              <Plot
                data={chartData as any}
                layout={{
                  autosize: true,
                  margin: { l: 50, r: 20, t: 20, b: 45 },
                  showlegend: true,
                  legend: { orientation: "h", y: 1.12 },
                  xaxis: { gridcolor: "#f1f5f9" },
                  yaxis: { gridcolor: "#f1f5f9", title: "累積淨值" },
                }}
                style={{ width: "100%", height: "100%" }}
                useResizeHandler
                config={{ displayModeBar: false }}
              />
            </div>
          </section>
        </section>

        <section className="mb-8 rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
          <div className="border-b border-slate-100 bg-slate-50/60 px-6 py-4">
            <h2 className="text-lg font-bold text-slate-900">策略績效表</h2>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-200 bg-white text-slate-500">
                <tr>
                  <th className="px-6 py-3 font-semibold">策略</th>
                  <th className="px-6 py-3 font-semibold">區間報酬</th>
                  <th className="px-6 py-3 font-semibold">年化報酬</th>
                  <th className="px-6 py-3 font-semibold">年化波動</th>
                  <th className="px-6 py-3 font-semibold">Sharpe</th>
                  <th className="px-6 py-3 font-semibold">最大回撤</th>
                  <th className="px-6 py-3 font-semibold">持股</th>
                </tr>
              </thead>

              <tbody className="divide-y divide-slate-100">
                {metrics.map((row) => (
                  <React.Fragment key={row.factor}>
                    <tr className="hover:bg-indigo-50/40">
                      <td className="px-6 py-3 font-bold text-slate-900">
                        {getFactorLabel(row.factor)}
                      </td>

                      <td
                        className={`px-6 py-3 font-bold ${
                          row.periodReturn >= 0 ? "text-emerald-600" : "text-rose-600"
                        }`}
                      >
                        {fmtPct(row.periodReturn)}
                      </td>

                      <td
                        className={`px-6 py-3 font-bold ${
                          row.annReturn >= 0 ? "text-emerald-600" : "text-rose-600"
                        }`}
                      >
                        {fmtPct(row.annReturn)}
                      </td>

                      <td className="px-6 py-3 text-slate-600">{fmtPct(row.annVol)}</td>

                      <td className="px-6 py-3 text-slate-600">
                        {row.sharpe === null ? "-" : row.sharpe.toFixed(2)}
                      </td>

                      <td className="px-6 py-3 font-medium text-rose-600">
                        {fmtPct(row.maxdd)}
                      </td>

                      <td className="px-6 py-3">
                        <button
                          onClick={() => {
                            setExpandedFactor(expandedFactor === row.factor ? null : row.factor);

                            const months = holdingsMap[row.factor]?.months || [];
                            if (months.length) {
                              setSelectedMonth(months[months.length - 1]);
                            }
                          }}
                          className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-indigo-700"
                        >
                          {expandedFactor === row.factor ? "收合" : "展開"}
                        </button>
                      </td>
                    </tr>

                    {expandedFactor === row.factor && (
                      <tr>
                        <td colSpan={7} className="bg-slate-50 px-6 py-5">
                          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                            <div>
                              <h3 className="font-bold text-slate-900">
                                {getFactorLabel(row.factor)} 月份持股
                              </h3>

                              <p className="text-sm text-slate-500">
                                可切換歷史月份，查看當月策略選股
                              </p>
                            </div>

                            <div className="flex items-center gap-3">
                              <select
                                value={selectedMonth}
                                onChange={(e) => setSelectedMonth(e.target.value)}
                                className="rounded-lg border-slate-200 bg-white text-sm font-medium text-slate-700 focus:border-indigo-500 focus:ring-indigo-500"
                              >
                                {(holdingsMap[row.factor]?.months || []).map((m) => (
                                  <option key={m} value={m}>
                                    {m}
                                  </option>
                                ))}
                              </select>

                              <button
                                onClick={() => copyStocks(holdingsForExpanded)}
                                className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-600 hover:bg-slate-100"
                              >
                                複製
                              </button>
                            </div>
                          </div>

                          {holdingsForExpanded.length ? (
                            <div className="flex flex-wrap gap-2">
                              {holdingsForExpanded.map((stock) => (
                                <span
                                  key={`${row.factor}-${selectedMonth}-${stock}`}
                                  className="rounded-full bg-white px-3 py-1 text-sm font-bold text-slate-700 border border-slate-200 shadow-sm"
                                >
                                  {getStockDisplay(stock)}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <div className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-400">
                              這個月份沒有持股資料
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}

                {!metrics.length && (
                  <tr>
                    <td colSpan={7} className="px-6 py-10 text-center text-slate-400">
                      尚未選擇策略
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="mb-6 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h2 className="text-xl font-bold text-slate-900">因子交集 / 聯集分析</h2>

              <p className="mt-1 text-sm text-slate-500">
                此區塊有自己的策略選擇區，不影響上方報酬圖與績效表的策略選擇
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <select
                value={selectedMonth}
                onChange={(e) => setSelectedMonth(e.target.value)}
                className="rounded-lg border-slate-200 bg-slate-50 text-sm font-medium text-slate-700 focus:border-indigo-500 focus:ring-indigo-500"
              >
                {allMonths.map((m) => (
                  <option key={`basket-month-${m}`} value={m}>
                    {m}
                  </option>
                ))}
              </select>

              <div className="rounded-lg bg-slate-100 p-1">
                <button
                  onClick={() => setMode("intersection")}
                  className={`rounded-md px-4 py-1.5 text-sm font-bold transition ${
                    mode === "intersection"
                      ? "bg-white text-indigo-600 shadow-sm"
                      : "text-slate-500 hover:text-slate-700"
                  }`}
                >
                  交集
                </button>

                <button
                  onClick={() => setMode("union")}
                  className={`rounded-md px-4 py-1.5 text-sm font-bold transition ${
                    mode === "union"
                      ? "bg-white text-indigo-600 shadow-sm"
                      : "text-slate-500 hover:text-slate-700"
                  }`}
                >
                  聯集
                </button>
              </div>
            </div>
          </div>

          {factors.length <= 1 && (
            <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-700">
              目前 strategy_data 只有一個策略時，交集 / 聯集功能的分析意義有限。
              未來只要在 strategy_data/returns 與 strategy_data/holdings 新增更多策略 JSON，
              這個區塊就可以直接比較多策略的選股重疊。
            </div>
          )}

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
            <aside className="lg:col-span-4 rounded-2xl border border-slate-200 bg-slate-50 p-5">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <h3 className="font-bold text-slate-900">交集策略選擇</h3>
                  <p className="text-sm text-slate-500">
                    已選 {basketFactors.length} / {factors.length}
                  </p>
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={selectAllBasketFactors}
                    className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-100"
                  >
                    全選
                  </button>

                  <button
                    onClick={clearBasketFactors}
                    className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-600 hover:bg-slate-100"
                  >
                    清空
                  </button>
                </div>
              </div>

              <div
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const factor = e.dataTransfer.getData("text/plain");
                  if (factor) addToBasket(factor);
                }}
                className="mb-4 rounded-xl border-2 border-dashed border-indigo-200 bg-white p-4 text-center text-sm font-medium text-indigo-400"
              >
                也可以把上方策略拖曳到這裡
              </div>

              <div className="max-h-[320px] overflow-y-auto space-y-2 pr-1">
                {factors.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-slate-300 bg-white p-5 text-center text-sm text-slate-400">
                    尚未掃描到策略
                  </div>
                ) : (
                  factors.map((factor) => (
                    <label
                      key={`basket-check-${factor}`}
                      className={`flex cursor-pointer items-center justify-between rounded-xl border px-4 py-3 transition ${
                        basketFactors.includes(factor)
                          ? "border-indigo-200 bg-indigo-50"
                          : "border-slate-200 bg-white hover:bg-slate-50"
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <input
                          type="checkbox"
                          checked={basketFactors.includes(factor)}
                          onChange={() => toggleBasketFactor(factor)}
                          className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                        />

                        <span className="text-sm font-bold text-slate-700">
                          {getFactorLabel(factor)}
                        </span>
                      </div>

                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-bold ${
                          basketFactors.includes(factor)
                            ? "bg-indigo-600 text-white"
                            : "bg-slate-100 text-slate-400"
                        }`}
                      >
                        {basketFactors.includes(factor) ? "已加入" : "未選"}
                      </span>
                    </label>
                  ))
                )}
              </div>
            </aside>

            <div className="lg:col-span-8">
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-5">
                <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h3 className="font-bold text-slate-900">
                      {selectedMonth || "-"} 的{mode === "intersection" ? "交集" : "聯集"}結果
                    </h3>

                    <p className="text-sm text-slate-500">
                      使用 {basketFactors.length} 個策略計算，共 {intersectionOrUnion.length} 檔股票
                    </p>
                  </div>

                  <button
                    onClick={() => copyStocks(intersectionOrUnion)}
                    className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-bold text-slate-600 hover:bg-slate-100"
                  >
                    複製結果
                  </button>
                </div>

                {basketFactors.length > 0 && (
                  <div className="mb-5 flex flex-wrap gap-2">
                    {basketFactors.map((factor) => (
                      <button
                        key={`selected-basket-${factor}`}
                        onClick={() => removeFromBasket(factor)}
                        className="rounded-full bg-indigo-600 px-4 py-2 text-sm font-bold text-white shadow-sm hover:bg-rose-600"
                        title="點擊移除"
                      >
                        {getFactorLabel(factor)} ×
                      </button>
                    ))}
                  </div>
                )}

                {intersectionOrUnion.length ? (
                  <div className="flex flex-wrap gap-2">
                    {intersectionOrUnion.map((stock) => (
                      <span
                        key={`result-${stock}`}
                        className="rounded-full border border-slate-200 bg-white px-3 py-1 text-sm font-bold text-slate-700 shadow-sm"
                      >
                        {getStockDisplay(stock)}
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-400">
                    目前沒有結果。請在左側選擇策略，或確認該月份有持股資料。
                  </div>
                )}
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}