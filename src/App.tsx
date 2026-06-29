import { useMemo, useState, type ReactNode } from 'react';
import {
  Activity,
  Boxes,
  Calculator,
  Cpu,
  Database,
  HardDrive,
  Info,
  Plus,
  Server,
  Sparkles,
  Trash2,
} from 'lucide-react';

/* ------------------------------------------------------------------ *
 *  Pricing reference — sourced directly from "Cost breakdown.md"
 *  All figures are editable defaults the client can override in-app.
 * ------------------------------------------------------------------ */

interface LLMModel {
  name: string;
  /** USD per 1M input tokens */
  inputPer1M: number;
  /** USD per 1M output tokens */
  outputPer1M: number;
}

type LLMKey = 'deepseek-flash' | 'deepseek-pro' | 'claude-sonnet-46';

const LLM_MODELS: Record<LLMKey, LLMModel> = {
  'deepseek-flash': {
    name: 'DeepSeek-V4 Flash (Global)',
    inputPer1M: 0.19,
    outputPer1M: 0.51,
  },
  'deepseek-pro': {
    name: 'DeepSeek-V4 Pro (Global)',
    inputPer1M: 1.74,
    outputPer1M: 3.48,
  },
  'claude-sonnet-46': {
    name: 'Claude Sonnet 4.6',
    inputPer1M: 2.0,
    outputPer1M: 8.0,
  },
};

/** Fixed infrastructure unit prices (USD / month) from the breakdown. */
const INFRA = {
  postgresPerInstance: 12.41, // Postgres (1 core, 2GB) — holds ~130k resumes / ~2GB
  vmPerInstance: 36.938, // VM (1 vCPU / 4GB RAM)
  blobPerGB: 0.18, // Azure Blob storage, $/GB/month
};

/** Capacity + sizing assumptions from the breakdown. */
const SIZING = {
  pgInstanceCapacityGB: 2, // a single $12.41 Postgres instance ≈ 2GB ≈ 130k resumes
  defaultTokensPerResume: 2000, // 1 resume ≈ 2000 tokens
  defaultPgKbPerResume: 16, // embedding + metadata per resume in Postgres
  defaultBlobKbPerResume: 50, // raw resume file in Azure Blob (not in source — editable)
};

/* ------------------------------------------------------------------ *
 *  Feature (token-consuming pipeline step) model
 * ------------------------------------------------------------------ */

type LLMTier = 'extraction' | 'reasoning';

interface Feature {
  id: string;
  name: string;
  tier: LLMTier;
  /** how many times this step runs per resume processed */
  runsPerResume: number;
  avgInputTokens: number;
  avgOutputTokens: number;
}

const INITIAL_FEATURES: Feature[] = [
  {
    id: 'f1',
    name: 'Resume Parsing & Field Extraction',
    tier: 'extraction',
    runsPerResume: 1,
    avgInputTokens: 2000,
    avgOutputTokens: 600,
  },
  {
    id: 'f2',
    name: 'Job-Fit Scoring & Ranking',
    tier: 'reasoning',
    runsPerResume: 1,
    avgInputTokens: 3500,
    avgOutputTokens: 700,
  },
  {
    id: 'f3',
    name: 'Candidate Summary Generation',
    tier: 'extraction',
    runsPerResume: 1,
    avgInputTokens: 2500,
    avgOutputTokens: 400,
  },
  {
    id: 'f4',
    name: 'Screening Q&A Generation',
    tier: 'reasoning',
    runsPerResume: 0.5,
    avgInputTokens: 2000,
    avgOutputTokens: 800,
  },
];

/* ------------------------------------------------------------------ *
 *  Helpers
 * ------------------------------------------------------------------ */

const KB_PER_GB = 1024 * 1024;

const fmtUSD = (n: number, frac = 2): string =>
  n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: frac,
    maximumFractionDigits: frac,
  });

const fmtNum = (n: number): string =>
  n.toLocaleString('en-US', { maximumFractionDigits: 0 });

interface BreakdownLine {
  label: string;
  group: 'LLM Usage' | 'Compute' | 'Database' | 'Storage';
  cost: number;
}

interface Architecture {
  extractionLLM: LLMKey;
  reasoningLLM: LLMKey;
  vmCount: number;
}

/* ------------------------------------------------------------------ *
 *  App
 * ------------------------------------------------------------------ */

export default function App() {
  const [activeTab, setActiveTab] = useState<'calculator' | 'features'>(
    'calculator',
  );

  // Volume / traffic
  const [monthlyResumes, setMonthlyResumes] = useState(5000);
  const [totalResumesStored, setTotalResumesStored] = useState(130000);
  const [pgKbPerResume, setPgKbPerResume] = useState(
    SIZING.defaultPgKbPerResume,
  );
  const [blobKbPerResume, setBlobKbPerResume] = useState(
    SIZING.defaultBlobKbPerResume,
  );

  // Architecture
  const [arch, setArch] = useState<Architecture>({
    extractionLLM: 'deepseek-flash',
    reasoningLLM: 'claude-sonnet-46',
    vmCount: 1,
  });

  // Features
  const [features, setFeatures] = useState<Feature[]>(INITIAL_FEATURES);

  const costs = useMemo(() => {
    const breakdown: BreakdownLine[] = [];

    // 1. Variable LLM usage --------------------------------------------------
    let llmTotal = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    features.forEach((feat) => {
      const executions = monthlyResumes * feat.runsPerResume;
      const inTok = executions * feat.avgInputTokens;
      const outTok = executions * feat.avgOutputTokens;
      const model =
        LLM_MODELS[feat.tier === 'extraction' ? arch.extractionLLM : arch.reasoningLLM];
      const cost =
        (inTok / 1_000_000) * model.inputPer1M +
        (outTok / 1_000_000) * model.outputPer1M;

      totalInputTokens += inTok;
      totalOutputTokens += outTok;
      llmTotal += cost;

      if (cost > 0) {
        breakdown.push({
          label: `${feat.name} · ${model.name}`,
          group: 'LLM Usage',
          cost,
        });
      }
    });

    // 2. Compute (VMs) -------------------------------------------------------
    const vmCost = arch.vmCount * INFRA.vmPerInstance;
    breakdown.push({
      label: `Application VM × ${arch.vmCount} (1 vCPU / 4GB)`,
      group: 'Compute',
      cost: vmCost,
    });

    // 3. Database (Postgres / pgvector) -------------------------------------
    const pgRequiredGB = (totalResumesStored * pgKbPerResume) / KB_PER_GB;
    const pgInstances = Math.max(
      1,
      Math.ceil(pgRequiredGB / SIZING.pgInstanceCapacityGB),
    );
    const pgCost = pgInstances * INFRA.postgresPerInstance;
    breakdown.push({
      label: `Postgres + pgvector × ${pgInstances} (${pgRequiredGB.toFixed(2)} GB)`,
      group: 'Database',
      cost: pgCost,
    });

    // 4. Object storage (Azure Blob) ----------------------------------------
    const blobGB = (totalResumesStored * blobKbPerResume) / KB_PER_GB;
    const blobCost = blobGB * INFRA.blobPerGB;
    breakdown.push({
      label: `Azure Blob — raw resumes (${blobGB.toFixed(2)} GB)`,
      group: 'Storage',
      cost: blobCost,
    });

    const fixedTotal = vmCost + pgCost + blobCost;
    const total = llmTotal + fixedTotal;

    return {
      breakdown,
      llmTotal,
      fixedTotal,
      total,
      totalInputTokens,
      totalOutputTokens,
      pgRequiredGB,
      pgInstances,
      blobGB,
      perResume: total / (monthlyResumes || 1),
      annual: total * 12,
    };
  }, [
    monthlyResumes,
    totalResumesStored,
    pgKbPerResume,
    blobKbPerResume,
    arch,
    features,
  ]);

  // Feature handlers
  const updateFeature = <K extends keyof Feature>(
    id: string,
    field: K,
    value: Feature[K],
  ) => {
    setFeatures((prev) =>
      prev.map((f) => (f.id === id ? { ...f, [field]: value } : f)),
    );
  };
  const addFeature = () => {
    setFeatures((prev) => [
      ...prev,
      {
        id: `f${prev.length + 1}-${prev.reduce((m, f) => m + f.name.length, 0)}`,
        name: 'New Step',
        tier: 'extraction',
        runsPerResume: 1,
        avgInputTokens: 1000,
        avgOutputTokens: 300,
      },
    ]);
  };
  const removeFeature = (id: string) =>
    setFeatures((prev) => prev.filter((f) => f.id !== id));

  const groupColors: Record<BreakdownLine['group'], string> = {
    'LLM Usage': 'text-sky-300',
    Compute: 'text-emerald-300',
    Database: 'text-amber-300',
    Storage: 'text-fuchsia-300',
  };

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      <div className="mx-auto max-w-6xl px-4 py-8 md:px-8">
        {/* Header */}
        <header className="mb-8 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-600 to-violet-600 text-white shadow-md">
              <Calculator size={22} />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-slate-900">
                AHORA · AI Recruitment Cost Estimator
              </h1>
              <p className="text-sm text-slate-500">
                Model monthly infrastructure & token spend for the resume
                intelligence platform.
              </p>
            </div>
          </div>
          <div className="flex rounded-lg border border-slate-200 bg-white p-1 shadow-sm">
            {(['calculator', 'features'] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`rounded-md px-4 py-2 text-sm font-medium capitalize transition-colors ${
                  activeTab === tab
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                {tab === 'features' ? 'Pipeline & Pricing' : 'Calculator'}
              </button>
            ))}
          </div>
        </header>

        {activeTab === 'calculator' && (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
            {/* Left: inputs */}
            <div className="space-y-6 lg:col-span-2">
              {/* Volume */}
              <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                <h2 className="mb-4 flex items-center gap-2 border-b border-slate-100 pb-3 text-base font-semibold text-slate-800">
                  <Activity size={18} className="text-indigo-500" />
                  Volume & Data
                </h2>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <NumberField
                    label="Resumes processed / month"
                    value={monthlyResumes}
                    onChange={setMonthlyResumes}
                    hint="Drives all token (LLM) usage costs."
                  />
                  <NumberField
                    label="Total resumes in database"
                    value={totalResumesStored}
                    onChange={setTotalResumesStored}
                    hint="Cumulative store — drives Postgres + Blob storage."
                  />
                  <NumberField
                    label="Embedding + metadata / resume (KB)"
                    value={pgKbPerResume}
                    onChange={setPgKbPerResume}
                    hint="Source: 16 KB per resume in Postgres."
                  />
                  <NumberField
                    label="Raw resume file / resume (KB)"
                    value={blobKbPerResume}
                    onChange={setBlobKbPerResume}
                    hint="Stored in Azure Blob (estimate — adjust to taste)."
                  />
                </div>
              </section>

              {/* Architecture */}
              <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                <h2 className="mb-4 flex items-center gap-2 border-b border-slate-100 pb-3 text-base font-semibold text-slate-800">
                  <Server size={18} className="text-emerald-500" />
                  Architecture & Infrastructure
                </h2>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <SelectField
                    label="Extraction / Parsing LLM"
                    value={arch.extractionLLM}
                    onChange={(v) =>
                      setArch((a) => ({ ...a, extractionLLM: v as LLMKey }))
                    }
                    options={LLM_MODELS}
                  />
                  <SelectField
                    label="Reasoning / Scoring LLM"
                    value={arch.reasoningLLM}
                    onChange={(v) =>
                      setArch((a) => ({ ...a, reasoningLLM: v as LLMKey }))
                    }
                    options={LLM_MODELS}
                  />
                  <NumberField
                    label="Application VMs (1 vCPU / 4GB)"
                    value={arch.vmCount}
                    onChange={(v) =>
                      setArch((a) => ({ ...a, vmCount: Math.max(1, v) }))
                    }
                    hint={`${fmtUSD(INFRA.vmPerInstance)} / VM / month`}
                  />
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-500">
                    <div className="mb-1 flex items-center gap-1.5 font-medium text-slate-600">
                      <Database size={14} /> Auto-scaled Postgres
                    </div>
                    {costs.pgInstances} × {fmtUSD(INFRA.postgresPerInstance)}{' '}
                    instance(s) for {costs.pgRequiredGB.toFixed(2)} GB of vectors
                    (~{SIZING.pgInstanceCapacityGB} GB each).
                  </div>
                </div>
              </section>
            </div>

            {/* Right: summary */}
            <aside className="lg:col-span-1">
              <div className="sticky top-6 rounded-2xl bg-gradient-to-b from-slate-900 to-slate-800 p-6 text-white shadow-xl">
                <h2 className="mb-5 flex items-center gap-2 border-b border-slate-700 pb-3 text-base font-semibold text-slate-200">
                  <Sparkles size={18} className="text-indigo-400" />
                  Monthly Estimate
                </h2>

                <div className="mb-5 space-y-3 text-sm">
                  <Row label="LLM token usage" value={fmtUSD(costs.llmTotal)} />
                  <Row label="Fixed infrastructure" value={fmtUSD(costs.fixedTotal)} />
                  <div className="flex items-center justify-between border-t border-slate-700 pt-4">
                    <span className="font-semibold text-slate-100">Total / month</span>
                    <span className="font-mono text-2xl font-bold text-emerald-400">
                      {fmtUSD(costs.total)}
                    </span>
                  </div>
                </div>

                <div className="mb-5 grid grid-cols-2 gap-2 text-center">
                  <Stat label="Per resume" value={fmtUSD(costs.perResume, 4)} />
                  <Stat label="Annual run-rate" value={fmtUSD(costs.annual, 0)} />
                </div>

                <div className="mb-5 rounded-lg bg-slate-800/70 p-3 text-xs text-slate-400">
                  <div className="flex justify-between">
                    <span>Input tokens / mo</span>
                    <span className="font-mono text-slate-200">
                      {fmtNum(costs.totalInputTokens)}
                    </span>
                  </div>
                  <div className="mt-1 flex justify-between">
                    <span>Output tokens / mo</span>
                    <span className="font-mono text-slate-200">
                      {fmtNum(costs.totalOutputTokens)}
                    </span>
                  </div>
                </div>

                <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Cost breakdown
                </h3>
                <div className="custom-scrollbar max-h-64 space-y-2 overflow-y-auto pr-2">
                  {[...costs.breakdown]
                    .sort((a, b) => b.cost - a.cost)
                    .map((item, idx) => (
                      <div
                        key={idx}
                        className="flex items-start justify-between border-b border-slate-800 pb-2 text-xs"
                      >
                        <span className="pr-2 text-slate-300">
                          <span
                            className={`mr-1.5 font-medium ${groupColors[item.group]}`}
                          >
                            ●
                          </span>
                          {item.label}
                        </span>
                        <span className="whitespace-nowrap font-mono text-slate-100">
                          {fmtUSD(item.cost)}
                        </span>
                      </div>
                    ))}
                </div>
              </div>
            </aside>
          </div>
        )}

        {activeTab === 'features' && (
          <div className="space-y-6">
            {/* Pipeline config */}
            <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="mb-5 flex items-center justify-between border-b border-slate-100 pb-4">
                <div>
                  <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-800">
                    <Cpu size={20} className="text-violet-500" />
                    AI Pipeline Steps
                  </h2>
                  <p className="mt-1 text-sm text-slate-500">
                    Each step runs per resume. Token volume drives usage-based
                    LLM cost.
                  </p>
                </div>
                <button
                  onClick={addFeature}
                  className="flex items-center gap-2 rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-700"
                >
                  <Plus size={16} /> Add Step
                </button>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-left text-sm">
                  <thead className="bg-slate-50 text-xs font-semibold uppercase text-slate-500">
                    <tr>
                      <th className="rounded-l-lg p-3">Step</th>
                      <th className="p-3">LLM Tier</th>
                      <th className="p-3">Runs / Resume</th>
                      <th className="p-3">Avg Input Tok</th>
                      <th className="p-3">Avg Output Tok</th>
                      <th className="rounded-r-lg p-3" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {features.map((feat) => (
                      <tr key={feat.id} className="hover:bg-slate-50">
                        <td className="p-2">
                          <input
                            type="text"
                            value={feat.name}
                            onChange={(e) =>
                              updateFeature(feat.id, 'name', e.target.value)
                            }
                            className="w-full rounded border border-slate-300 p-2 focus:border-violet-500 focus:ring-1 focus:ring-violet-500"
                          />
                        </td>
                        <td className="p-2">
                          <select
                            value={feat.tier}
                            onChange={(e) =>
                              updateFeature(
                                feat.id,
                                'tier',
                                e.target.value as LLMTier,
                              )
                            }
                            className="w-full rounded border border-slate-300 bg-white p-2 focus:border-violet-500 focus:ring-1 focus:ring-violet-500"
                          >
                            <option value="extraction">Extraction LLM</option>
                            <option value="reasoning">Reasoning LLM</option>
                          </select>
                        </td>
                        <td className="p-2">
                          <input
                            type="number"
                            step="0.1"
                            value={feat.runsPerResume}
                            onChange={(e) =>
                              updateFeature(
                                feat.id,
                                'runsPerResume',
                                Number(e.target.value),
                              )
                            }
                            className="w-24 rounded border border-slate-300 p-2 focus:border-violet-500 focus:ring-1 focus:ring-violet-500"
                          />
                        </td>
                        <td className="p-2">
                          <input
                            type="number"
                            value={feat.avgInputTokens}
                            onChange={(e) =>
                              updateFeature(
                                feat.id,
                                'avgInputTokens',
                                Number(e.target.value),
                              )
                            }
                            className="w-28 rounded border border-slate-300 p-2 focus:border-violet-500 focus:ring-1 focus:ring-violet-500"
                          />
                        </td>
                        <td className="p-2">
                          <input
                            type="number"
                            value={feat.avgOutputTokens}
                            onChange={(e) =>
                              updateFeature(
                                feat.id,
                                'avgOutputTokens',
                                Number(e.target.value),
                              )
                            }
                            className="w-28 rounded border border-slate-300 p-2 focus:border-violet-500 focus:ring-1 focus:ring-violet-500"
                          />
                        </td>
                        <td className="p-2 text-center">
                          <button
                            onClick={() => removeFeature(feat.id)}
                            className="rounded-full p-2 text-rose-400 transition-colors hover:bg-rose-50 hover:text-rose-600"
                            aria-label="Remove step"
                          >
                            <Trash2 size={18} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            {/* Pricing reference */}
            <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <h2 className="mb-4 flex items-center gap-2 border-b border-slate-100 pb-3 text-base font-semibold text-slate-800">
                <Boxes size={18} className="text-amber-500" />
                Pricing Reference{' '}
                <span className="text-xs font-normal text-slate-400">
                  (from Cost breakdown.md)
                </span>
              </h2>
              <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                <div>
                  <h3 className="mb-2 text-sm font-semibold text-slate-600">
                    LLM models ($ / 1M tokens)
                  </h3>
                  <table className="w-full text-sm">
                    <thead className="text-xs uppercase text-slate-400">
                      <tr>
                        <th className="py-1 text-left">Model</th>
                        <th className="py-1 text-right">Input</th>
                        <th className="py-1 text-right">Output</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {Object.values(LLM_MODELS).map((m) => (
                        <tr key={m.name}>
                          <td className="py-2 text-slate-700">{m.name}</td>
                          <td className="py-2 text-right font-mono text-slate-600">
                            {fmtUSD(m.inputPer1M)}
                          </td>
                          <td className="py-2 text-right font-mono text-slate-600">
                            {fmtUSD(m.outputPer1M)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div>
                  <h3 className="mb-2 text-sm font-semibold text-slate-600">
                    Infrastructure (monthly)
                  </h3>
                  <ul className="space-y-2 text-sm">
                    <RefItem
                      icon={<Server size={14} className="text-emerald-500" />}
                      label="VM (1 vCPU / 4GB RAM)"
                      value={`${fmtUSD(INFRA.vmPerInstance)} / mo`}
                    />
                    <RefItem
                      icon={<Database size={14} className="text-amber-500" />}
                      label="Postgres (1 core, 2GB ≈ 130k resumes)"
                      value={`${fmtUSD(INFRA.postgresPerInstance)} / mo`}
                    />
                    <RefItem
                      icon={<HardDrive size={14} className="text-fuchsia-500" />}
                      label="Azure Blob storage"
                      value={`${fmtUSD(INFRA.blobPerGB)} / GB / mo`}
                    />
                  </ul>
                  <div className="mt-3 flex gap-2 rounded-lg border border-blue-100 bg-blue-50 p-3 text-xs text-blue-800">
                    <Info size={16} className="mt-0.5 shrink-0 text-blue-500" />
                    <span>
                      Resume ≈ 2000 tokens · 16 KB embedding+metadata in
                      Postgres. Embedding generation runs on the application VM
                      (no per-token API cost).
                    </span>
                  </div>
                </div>
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  Small presentational components
 * ------------------------------------------------------------------ */

function NumberField({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  hint?: string;
}) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-slate-700">
        {label}
      </label>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full rounded-md border border-slate-300 p-2 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
      />
      {hint && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
    </div>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Record<string, { name: string }>;
}) {
  return (
    <div>
      <label className="mb-1 block text-sm font-medium text-slate-700">
        {label}
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-slate-300 bg-slate-50 p-2 text-sm focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500"
      >
        {Object.entries(options).map(([key, val]) => (
          <option key={key} value={key}>
            {val.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-slate-400">{label}</span>
      <span className="font-mono font-medium text-slate-100">{value}</span>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-slate-800/70 p-2">
      <div className="font-mono text-sm font-semibold text-slate-100">
        {value}
      </div>
      <div className="text-[11px] uppercase tracking-wide text-slate-500">
        {label}
      </div>
    </div>
  );
}

function RefItem({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <li className="flex items-center justify-between rounded-lg border border-slate-100 bg-slate-50 px-3 py-2">
      <span className="flex items-center gap-2 text-slate-700">
        {icon}
        {label}
      </span>
      <span className="font-mono text-slate-600">{value}</span>
    </li>
  );
}
