import { useMemo, useState, type ReactNode } from 'react';
import {
  Activity,
  Boxes,
  Calculator,
  Cpu,
  Database,
  Info,
  Plus,
  Server,
  Sparkles,
  Trash2,
} from 'lucide-react';

/* ------------------------------------------------------------------ *
 *  Pricing reference — sourced directly from "Cost breakdown.md"
 *  LLM rates are editable references; infra + sizing are fixed.
 * ------------------------------------------------------------------ */

interface LLMModel {
  name: string;
  /** USD per 1M input tokens */
  inputPer1M: number;
  /** USD per 1M output tokens */
  outputPer1M: number;
}

type LLMKey = 'deepseek-flash' | 'deepseek-pro' | 'gpt-41';

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
  'gpt-41': {
    name: 'GPT-4.1',
    inputPer1M: 2.0,
    outputPer1M: 8.0,
  },
};

/** Fixed infrastructure unit prices (USD / month) from the breakdown. */
const INFRA = {
  postgres: 12.41, // Postgres (1 core, 2GB)
  vm: 36.938, // VM (1 vCPU / 4GB RAM)
  blobPerGB: 0.18, // Azure Blob ($/GB/mo) — not itemized, see note
};

/** Capacity + sizing assumptions from the breakdown. */
const SIZING = {
  pgInstanceCapacityGB: 2, // a single $12.41 Postgres instance ≈ 2GB
  kbPerEmbedding: 16, // embedding + metadata per resume in Postgres
  inputTokensPerResume: 2000, // fixed assumption: ~2000 input tokens / resume
  outputTokensPerResume: 500, // fixed assumption: ~500 output tokens / resume
};

const KB_PER_GB = 1024 * 1024;

/** Single source of truth — keeps prose, breakdown & reference in sync. */
const VM_LABEL = 'Application VM (1 vCPU / 4GB RAM)';
const PG_LABEL = 'Postgres + pgvector (1 core, 2GB)';
const INPUT_TOKENS = SIZING.inputTokensPerResume;
const OUTPUT_TOKENS = SIZING.outputTokensPerResume;

/** How many resumes the fixed 2GB Postgres tier can hold. */
const PG_CAPACITY_RESUMES = Math.floor(
  (SIZING.pgInstanceCapacityGB * KB_PER_GB) / SIZING.kbPerEmbedding,
);

/* ------------------------------------------------------------------ *
 *  Pipeline step model — one AI operation performed on each resume
 * ------------------------------------------------------------------ */

interface Feature {
  id: string;
  name: string;
  model: LLMKey;
}

const INITIAL_FEATURES: Feature[] = [
  { id: 'f1', name: 'Resume Parsing & Field Extraction', model: 'deepseek-flash' },
  { id: 'f2', name: 'Job-Fit Scoring & Ranking', model: 'gpt-41' },
  { id: 'f3', name: 'Candidate Summary Generation', model: 'deepseek-flash' },
  { id: 'f4', name: 'Screening Q&A Generation', model: 'gpt-41' },
];

/* ------------------------------------------------------------------ *
 *  Helpers
 * ------------------------------------------------------------------ */

const fmtUSD = (n: number, frac = 2): string =>
  n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: frac,
    maximumFractionDigits: frac,
  });

const fmtNum = (n: number): string =>
  n.toLocaleString('en-US', { maximumFractionDigits: 0 });

const fmtCompact = (n: number): string =>
  n.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 1 });

interface BreakdownLine {
  label: string;
  group: 'LLM Usage' | 'Infrastructure';
  cost: number;
}

/* ------------------------------------------------------------------ *
 *  App — single live page: edit drivers on the left, cost updates right
 * ------------------------------------------------------------------ */

export default function App() {
  // Volume / traffic
  const [monthlyResumes, setMonthlyResumes] = useState(5000);
  const [totalResumesStored, setTotalResumesStored] = useState(130000);

  // Pipeline steps
  const [features, setFeatures] = useState<Feature[]>(INITIAL_FEATURES);

  const costs = useMemo(() => {
    const breakdown: BreakdownLine[] = [];

    // 1. Variable LLM usage — one line per step, in pipeline order ----------
    let llmTotal = 0;
    let totalTokens = 0;

    features.forEach((feat) => {
      const inTokens = monthlyResumes * INPUT_TOKENS;
      const outTokens = monthlyResumes * OUTPUT_TOKENS;
      const model = LLM_MODELS[feat.model];
      const cost =
        (inTokens / 1_000_000) * model.inputPer1M +
        (outTokens / 1_000_000) * model.outputPer1M;

      totalTokens += inTokens + outTokens;
      llmTotal += cost;

      breakdown.push({
        label: `${feat.name} · ${model.name}`,
        group: 'LLM Usage',
        cost,
      });
    });

    // 2. Fixed infrastructure (1 VM + 1 Postgres) — always last, in order ---
    breakdown.push({ label: VM_LABEL, group: 'Infrastructure', cost: INFRA.vm });
    breakdown.push({ label: PG_LABEL, group: 'Infrastructure', cost: INFRA.postgres });

    const fixedTotal = INFRA.vm + INFRA.postgres;
    const total = llmTotal + fixedTotal;

    return {
      breakdown,
      llmTotal,
      fixedTotal,
      total,
      totalTokens,
      perResume: total / (monthlyResumes || 1),
      annual: total * 12,
      overCapacity: totalResumesStored > PG_CAPACITY_RESUMES,
    };
  }, [monthlyResumes, totalResumesStored, features]);

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
        model: 'deepseek-flash',
      },
    ]);
  };
  const removeFeature = (id: string) =>
    setFeatures((prev) => prev.filter((f) => f.id !== id));

  const groupColors: Record<BreakdownLine['group'], string> = {
    'LLM Usage': 'text-sky-300',
    Infrastructure: 'text-emerald-300',
  };

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      <div className="mx-auto max-w-6xl space-y-6 px-4 py-8 md:px-8">
        {/* Header */}
        <header className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-600 to-violet-600 text-white shadow-md">
            <Calculator size={22} />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">
              AHORA · AI Recruitment Cost Estimator
            </h1>
            <p className="text-sm text-slate-500">
              Edit the volume, pipeline, and models — the monthly cost updates
              live.
            </p>
          </div>
        </header>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* Left: cost drivers */}
          <div className="space-y-6 lg:col-span-2">
            {/* Volume */}
            <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <SectionHeader
                icon={<Activity size={18} className="text-indigo-500" />}
                title="Volume & Data"
                subtitle="Monthly throughput that drives token usage and storage."
              />
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <NumberField
                  label="Resumes processed / month"
                  value={monthlyResumes}
                  onChange={setMonthlyResumes}
                  hint="Drives all LLM usage costs."
                />
                <NumberField
                  label="Total resumes in database"
                  value={totalResumesStored}
                  onChange={setTotalResumesStored}
                  hint="Cumulative store — checked against the 2GB Postgres tier."
                />
              </div>
            </section>

            {/* Pipeline steps */}
            <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <div className="mb-4 flex items-start justify-between gap-4 border-b border-slate-100 pb-3">
                <SectionHeader
                  icon={<Cpu size={18} className="text-violet-500" />}
                  title="AI Pipeline Steps"
                  subtitle="Each AI step runs once per resume. Pick the model for each — changing it updates the cost on the right."
                  flush
                />
                <button
                  onClick={addFeature}
                  className="flex shrink-0 items-center gap-2 rounded-md bg-violet-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-700"
                >
                  <Plus size={16} /> Add Step
                </button>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full min-w-[400px] text-left text-sm">
                  <thead className="bg-slate-50 text-xs font-semibold uppercase text-slate-500">
                    <tr>
                      <th className="rounded-l-lg p-3">Step</th>
                      <th className="p-3">LLM Model</th>
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
                            value={feat.model}
                            onChange={(e) =>
                              updateFeature(
                                feat.id,
                                'model',
                                e.target.value as LLMKey,
                              )
                            }
                            className="w-full rounded border border-slate-300 bg-white p-2 focus:border-violet-500 focus:ring-1 focus:ring-violet-500"
                          >
                            {Object.entries(LLM_MODELS).map(([key, m]) => (
                              <option key={key} value={key}>
                                {m.name}
                              </option>
                            ))}
                          </select>
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

              <div className="mt-4 flex gap-2 rounded-lg border border-blue-100 bg-blue-50 p-3 text-xs text-blue-800">
                <Info size={16} className="mt-0.5 shrink-0 text-blue-500" />
                <span>
                  Each step assumes{' '}
                  <strong>
                    ~{fmtNum(INPUT_TOKENS)} input + {fmtNum(OUTPUT_TOKENS)} output
                    tokens / resume
                  </strong>
                  , priced at the selected model's input & output rates.
                </span>
              </div>
            </section>

            {/* Infrastructure — fixed baseline */}
            <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <SectionHeader
                icon={<Server size={18} className="text-emerald-500" />}
                title="Infrastructure"
                subtitle="Fixed monthly baseline — independent of resume volume."
              />
              <ul className="space-y-2 text-sm">
                <RefItem
                  icon={<Server size={14} className="text-emerald-500" />}
                  label={VM_LABEL}
                  value={`${fmtUSD(INFRA.vm)} / mo`}
                />
                <RefItem
                  icon={<Database size={14} className="text-amber-500" />}
                  label={PG_LABEL}
                  value={`${fmtUSD(INFRA.postgres)} / mo`}
                />
              </ul>
              <div
                className={`mt-3 flex gap-2 rounded-lg border p-3 text-xs ${
                  costs.overCapacity
                    ? 'border-amber-200 bg-amber-50 text-amber-800'
                    : 'border-blue-100 bg-blue-50 text-blue-800'
                }`}
              >
                <Info
                  size={16}
                  className={`mt-0.5 shrink-0 ${
                    costs.overCapacity ? 'text-amber-500' : 'text-blue-500'
                  }`}
                />
                <span>
                  <strong>Assumption:</strong> a single VM + one{' '}
                  {SIZING.pgInstanceCapacityGB}&nbsp;GB Postgres instance, which
                  holds embeddings + metadata for up to{' '}
                  <strong>~{fmtNum(PG_CAPACITY_RESUMES)} resumes</strong> (
                  {SIZING.kbPerEmbedding} KB each).{' '}
                  {costs.overCapacity
                    ? `Your store of ${fmtNum(totalResumesStored)} exceeds this — additional instances would be needed.`
                    : 'Beyond that, additional instances would be added.'}
                </span>
              </div>
              <p className="mt-2 text-xs text-slate-400">
                Not included: raw resume files in Azure Blob (~
                {fmtUSD(INFRA.blobPerGB)}/GB/mo, negligible).
              </p>
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
                <Row label="LLM usage" value={fmtUSD(costs.llmTotal)} />
                <Row label="Fixed infrastructure" value={fmtUSD(costs.fixedTotal)} />
                <div className="flex items-center justify-between border-t border-slate-700 pt-4">
                  <span className="font-semibold text-slate-100">Total / month</span>
                  <span className="font-mono text-2xl font-bold text-emerald-400">
                    {fmtUSD(costs.total)}
                  </span>
                </div>
              </div>

              <div className="mb-5 grid grid-cols-3 gap-2 text-center">
                <Stat label="Per resume" value={fmtUSD(costs.perResume, 3)} />
                <Stat label="Annual" value={fmtUSD(costs.annual)} />
                <Stat label="Tokens / mo" value={fmtCompact(costs.totalTokens)} />
              </div>

              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">
                Cost breakdown
              </h3>
              <div className="space-y-2">
                {costs.breakdown.map((item, idx) => (
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

        {/* Pricing reference (read-only LLM rates, full width) */}
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <SectionHeader
            icon={<Boxes size={18} className="text-amber-500" />}
            title="LLM Reference Pricing"
            subtitle="Per-million-token rates behind each model in the pipeline."
          />
          <table className="w-full max-w-xl text-sm">
            <thead className="text-xs uppercase text-slate-400">
              <tr>
                <th className="py-1 text-left">Model</th>
                <th className="py-1 text-right">Input / 1M</th>
                <th className="py-1 text-right">Output / 1M</th>
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
        </section>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 *  Small presentational components
 * ------------------------------------------------------------------ */

function SectionHeader({
  icon,
  title,
  subtitle,
  flush,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  flush?: boolean;
}) {
  return (
    <div className={flush ? '' : 'mb-4 border-b border-slate-100 pb-3'}>
      <h2 className="flex items-center gap-2 text-base font-semibold text-slate-800">
        {icon}
        {title}
      </h2>
      <p className="mt-1 text-sm text-slate-500">{subtitle}</p>
    </div>
  );
}

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
      <div className="truncate font-mono text-sm font-semibold text-slate-100">
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
