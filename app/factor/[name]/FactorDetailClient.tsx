"use client";

import React, { useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import dynamic from "next/dynamic";

const Plot = dynamic(() => import("react-plotly.js"), { ssr: false });

const GH_OWNER = "alfred0630";
const GH_REPO = "factor-platform-database";
const GH_BRANCH = "main";
const RAW_BASE = `https://raw.githubusercontent.com/${GH_OWNER}/${GH_REPO}/${GH_BRANCH}`;

// === 型別定義 ===
type ReturnsResp = { name?: string; factor?: string; dates: string[]; ret: number[] };
type MetaResp = Record<string, any>;
type HoldingsResp = {
  factor: string;
  asof: string | null;
  months: string[];
  holdings: Record<string, string[]>;
};
// 股票名稱對照表型別
type StockNamesResp = Record<string, string>;

// === 數學計算函式 (復用自首頁) ===
function toCum(retArr: number[]) {
  let v = 1;
  return retArr.map((r) => (v *= 1 + r));
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

// 計算績效指標
function calcMetrics(ret: number[], freq = 252) {
  if (!ret.length) {
    return { ann_return: 0, ann_vol: 0, sharpe: 0, maxdd: 0 };
  }

  let nav = 1;
  for (const r of ret) nav *= 1 + r;
  const n = ret.length;
  // 年化報酬 (CAGR)
  const ann_return = Math.pow(nav, freq / n) - 1;

  // 年化波動率
  const mean = ret.reduce((a, b) => a + b, 0) / n;
  const var_ = ret.reduce((a, r) => a + (r - mean) ** 2, 0) / Math.max(1, n - 1);
  const ann_vol = Math.sqrt(var_ * freq);

  // 夏普比率 (假設 Rf=0)
  const sharpe = ann_vol === 0 ? 0 : (mean * freq) / ann_vol;

  // 最大回撤
  const maxdd = maxDrawdownFromReturns(ret);

  return { ann_return, ann_vol, sharpe, maxdd };
}

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) {
    throw new Error(`fetch failed`);
  }
  return (await r.json()) as T;
}

export default function FactorDetailClient({ name }: { name?: string }) {
  const pathname = usePathname();

  // 1. 取得安全名稱
  const safeName = useMemo(() => {
    if (name && name !== "undefined" && name.trim().length > 0) {
      return name;
    }
    if (!pathname) return "";
    const segments = pathname.split("/").filter(Boolean);
    const last = segments.pop();
    return last ? decodeURIComponent(last) : "";
  }, [name, pathname]);

  const [meta, setMeta] = useState<MetaResp | null>(null);
  const [ret, setRet] = useState<ReturnsResp | null>(null);
  const [hold, setHold] = useState<HoldingsResp | null>(null);
  const [stockNames, setStockNames] = useState<StockNamesResp>({}); // 儲存股票名稱
  const [month, setMonth] = useState<string>("");

  // 2. 讀取資料
  useEffect(() => {
    if (!safeName) return;

    (async () => {
      try {
        // 同時抓取所有資料，包含 stock_names.json (如果有的話)
        const [m, r, h, names] = await Promise.all([
          fetchJson<MetaResp>(`${RAW_BASE}/data/factors/${encodeURIComponent(safeName)}.json`).catch(() => null),
          fetchJson<ReturnsResp>(`${RAW_BASE}/data/returns/${encodeURIComponent(safeName)}.json`).catch(() => null),
          fetchJson<HoldingsResp>(`${RAW_BASE}/data/holdings/${encodeURIComponent(safeName)}.json`).catch(() => null),
          // 嘗試抓取股票名稱對照表，如果沒有該檔案則回傳空物件，不影響主程式
          fetchJson<StockNamesResp>(`${RAW_BASE}/data/stock_names.json`).catch(() => ({}) as StockNamesResp),
        ]);

        setMeta(m);
        setRet(r);
        setHold(h);
        setStockNames(names || {});

        const months = h?.months || [];
        setMonth(months.length ? months[months.length - 1] : "");
      } catch (e) {
        console.error(e);
      }
    })();
  }, [safeName]);

  const holdingsList = useMemo(() => {
    if (!hold || !month) return [];
    return hold.holdings?.[month] || [];
  }, [hold, month]);

  // 3. 計算該因子的績效指標
  const metrics = useMemo(() => {
    if (!ret || !ret.ret || ret.ret.length === 0) return null;
    return calcMetrics(ret.ret);
  }, [ret]);

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans">
      <header className="sticky top-0 z-50 w-full border-b border-slate-200 bg-white/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-extrabold tracking-tight text-slate-900">{safeName || "-"}</h1>
            <span className="rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-bold text-blue-700 border border-blue-200">
              因子詳情
            </span>
          </div>
          <Link href="/" className="text-sm font-semibold text-blue-600 hover:underline">
            ← 回首頁
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6 space-y-8">
        
        {/* Meta Section (選股邏輯) */}
        <section className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
          <h2 className="text-lg font-bold text-slate-800 mb-3">選股邏輯</h2>
          {!meta ? (
            <div className="text-slate-400">找不到 factors/{safeName}.json（可能尚未匯出）</div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                <div className="rounded-xl bg-slate-50 border border-slate-100 p-3">
                  <div className="text-xs text-slate-500 font-bold mb-1">顯示名稱</div>
                  <div className="font-semibold">{meta.display_name ?? "-"}</div>
                </div>
                <div className="rounded-xl bg-slate-50 border border-slate-100 p-3">
                  <div className="text-xs text-slate-500 font-bold mb-1">分類</div>
                  <div className="font-semibold">{meta.category ?? "-"}</div>
                </div>
                <div className="rounded-xl bg-slate-50 border border-slate-100 p-3">
                  <div className="text-xs text-slate-500 font-bold mb-1">再平衡</div>
                  <div className="font-semibold">{meta.rebalance ?? "-"}</div>
                </div>
                <div className="rounded-xl bg-slate-50 border border-slate-100 p-3">
                  <div className="text-xs text-slate-500 font-bold mb-1">投資宇宙</div>
                  <div className="font-semibold">{meta.universe ?? "-"}</div>
                </div>
              </div>

              <div className="rounded-xl bg-slate-50 border border-slate-100 p-4">
                <div className="text-xs text-slate-500 font-bold mb-2">持有規則</div>
                <div className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">
                  {meta.holding_rule ?? "-"}
                </div>
              </div>

              <div className="rounded-xl bg-slate-50 border border-slate-100 p-4">
                <div className="text-xs text-slate-500 font-bold mb-2">參數</div>
                <pre className="text-xs text-slate-700 overflow-auto">
                  {JSON.stringify(meta.params ?? {}, null, 2)}
                </pre>
              </div>
            </div>
          )}
        </section>

        {/* Returns Chart Section (歷史表現) */}
        <section className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
          <h2 className="text-lg font-bold text-slate-800 mb-4">歷史表現（累積報酬）</h2>
          
          {/* ✅ 新增：績效數據卡片 (Grid 佈局) */}
          {metrics && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
              <div className="p-4 rounded-xl bg-slate-50 border border-slate-100 text-center">
                <div className="text-xs text-slate-500 font-bold uppercase tracking-wider mb-1">年化報酬</div>
                <div className={`text-xl font-extrabold ${metrics.ann_return >= 0 ? "text-emerald-600" : "text-rose-600"}`}>
                  {(metrics.ann_return * 100).toFixed(2)}%
                </div>
              </div>
              <div className="p-4 rounded-xl bg-slate-50 border border-slate-100 text-center">
                <div className="text-xs text-slate-500 font-bold uppercase tracking-wider mb-1">年化波動</div>
                <div className="text-xl font-extrabold text-slate-700">
                  {(metrics.ann_vol * 100).toFixed(2)}%
                </div>
              </div>
              <div className="p-4 rounded-xl bg-slate-50 border border-slate-100 text-center">
                <div className="text-xs text-slate-500 font-bold uppercase tracking-wider mb-1">夏普比率</div>
                <div className="text-xl font-extrabold text-slate-700">
                  {metrics.sharpe.toFixed(2)}
                </div>
              </div>
              <div className="p-4 rounded-xl bg-slate-50 border border-slate-100 text-center">
                <div className="text-xs text-slate-500 font-bold uppercase tracking-wider mb-1">最大回撤</div>
                <div className="text-xl font-extrabold text-rose-600">
                  {(metrics.maxdd * 100).toFixed(2)}%
                </div>
              </div>
            </div>
          )}

          {!ret?.dates?.length ? (
            <div className="text-slate-400">找不到 returns/{safeName}.json（可能尚未匯出）</div>
          ) : (
            <div className="w-full h-[380px]">
              <Plot
                data={[
                  {
                    x: ret.dates,
                    y: toCum(ret.ret || []),
                    type: "scatter",
                    mode: "lines",
                    name: safeName,
                    line: { color: "#2563eb", width: 2 },
                  },
                ] as any}
                layout={{
                  autosize: true,
                  margin: { l: 40, r: 20, t: 20, b: 40 },
                  showlegend: false,
                  xaxis: { gridcolor: "#f1f5f9" },
                  yaxis: { gridcolor: "#f1f5f9" },
                }}
                style={{ width: "100%", height: "100%" }}
                useResizeHandler
                config={{ displayModeBar: false }}
              />
            </div>
          )}
        </section>

        {/* Holdings Section (持股名單) */}
        <section className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
            <h2 className="text-lg font-bold text-slate-800">選股名單（可回看）</h2>
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold uppercase text-slate-400 tracking-wider">月份</span>
              <select
                className="rounded-lg border-slate-200 text-sm font-medium focus:border-blue-500 focus:ring-blue-500 text-slate-700 bg-slate-50"
                value={month}
                onChange={(e) => setMonth(e.target.value)}
                disabled={!hold?.months?.length}
              >
                {(hold?.months || []).map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {!hold ? (
            <div className="text-slate-400">找不到 holdings/{safeName}.json（指數或尚未匯出）</div>
          ) : (
            <>
              <div className="text-xs text-slate-500 mb-4 pb-2 border-b border-slate-100">
                asof: <span className="font-mono font-medium text-slate-700">{hold.asof ?? "-"}</span>
                　|　本月持股數：<span className="font-mono font-medium text-slate-700">{holdingsList.length}</span>
              </div>

              {holdingsList.length === 0 ? (
                <div className="text-slate-400">此月份無持股（或資料缺漏）</div>
              ) : (
                // ✅ 修改：更整齊的 Grid 佈局，並顯示公司名稱
                <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                  {holdingsList.map((ticker) => {
                    const stockName = stockNames[ticker] || "";
                    return (
                      <div
                        key={ticker}
                        className="flex flex-col items-center justify-center rounded-lg bg-slate-50 border border-slate-200 p-2 text-center hover:bg-blue-50 hover:border-blue-200 transition-colors"
                      >
                        <span className="text-lg font-bold text-slate-800 font-mono tracking-tight">
                          {ticker}
                        </span>
                        {/* 如果有抓到名稱就顯示，否則不顯示 */}
                        {stockName && (
                          <span className="text-xs font-medium text-slate-500 mt-0.5">
                            {stockName}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </section>
      </main>
    </div>
  );
}