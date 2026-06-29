import { useMemo, useState, type ReactNode } from 'react';
import {
  FileText,
  Info,
  Receipt,
  Server,
  Tag,
  Trash2,
  Workflow,
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
  { id: 'f1', name: 'Resume Parsing & Field Extraction', model: 'deepseek-pro' },
  { id: 'f2', name: 'Job-Fit Scoring & Ranking', model: 'deepseek-pro' },
  { id: 'f3', name: 'Candidate Summary Generation', model: 'deepseek-pro' },
  { id: 'f4', name: 'Screening Q&A Generation', model: 'deepseek-pro' },
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
  /** per-line explanation rows (resumes × tokens = total × rate = cost) */
  detail?: string[];
}

/* ------------------------------------------------------------------ *
 *  App — single live page: edit drivers on the left, cost updates right
 * ------------------------------------------------------------------ */

export default function App() {
  const [monthlyResumes, setMonthlyResumes] = useState(500);
  const [totalResumesStored, setTotalResumesStored] = useState(0);
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
      const inCost = (inTokens / 1_000_000) * model.inputPer1M;
      const outCost = (outTokens / 1_000_000) * model.outputPer1M;
      const cost = inCost + outCost;

      totalTokens += inTokens + outTokens;
      llmTotal += cost;

      breakdown.push({
        label: `${feat.name} · ${model.name}`,
        group: 'LLM Usage',
        cost,
        detail: [
          `in: ${fmtNum(monthlyResumes)} × ${fmtNum(INPUT_TOKENS)} = ${fmtCompact(inTokens)} × ${fmtUSD(model.inputPer1M)}/M = ${fmtUSD(inCost)}`,
          `out: ${fmtNum(monthlyResumes)} × ${fmtNum(OUTPUT_TOKENS)} = ${fmtCompact(outTokens)} × ${fmtUSD(model.outputPer1M)}/M = ${fmtUSD(outCost)}`,
        ],
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

  const updateFeature = <K extends keyof Feature>(
    id: string,
    field: K,
    value: Feature[K],
  ) => {
    setFeatures((prev) =>
      prev.map((f) => (f.id === id ? { ...f, [field]: value } : f)),
    );
  };
  const removeFeature = (id: string) =>
    setFeatures((prev) => prev.filter((f) => f.id !== id));

  return (
    <div className="min-h-screen">
      <div className="mx-auto max-w-6xl space-y-8 px-5 py-10 md:px-8 md:py-14">
        {/* Header */}
        <header>
          <p className="text-xs font-medium uppercase tracking-[0.22em] text-accent">
            AHORA
          </p>
          <h1 className="mt-1 text-3xl font-bold leading-tight tracking-tight text-ink md:text-4xl">
            AI Recruitment Cost Estimator
          </h1>
          <p className="mt-3 max-w-xl text-ink-soft">
            Edit the volume, pipeline, and models. The monthly cost updates live.
          </p>
        </header>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* Left: cost drivers */}
          <div className="space-y-6 lg:col-span-2">
            {/* Volume */}
            <section className="rounded-xl border border-line bg-card p-6">
              <SectionHeader
                icon={<FileText size={16} strokeWidth={1.75} />}
                title="Volume & Data"
                subtitle="Monthly throughput that drives token usage and storage."
              />
              <div className="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-2">
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
                  hint="Cumulative store, checked against the 2 GB Postgres tier."
                />
              </div>
            </section>

            {/* Pipeline steps */}
            <section className="rounded-xl border border-line bg-card p-6">
              <SectionHeader
                icon={<Workflow size={16} strokeWidth={1.75} />}
                title="AI Pipeline Steps"
                subtitle="Each AI step runs once per resume. Pick a model per step; the cost on the right updates instantly."
              />

              <div className="mt-5 overflow-x-auto">
                <table className="w-full min-w-[400px] border-separate border-spacing-y-1 text-left text-sm">
                  <thead>
                    <tr className="text-[11px] font-medium uppercase tracking-wider text-ink-faint">
                      <th className="px-2 pb-1 font-medium">Step</th>
                      <th className="px-2 pb-1 font-medium">LLM Model</th>
                      <th className="w-10 pb-1" />
                    </tr>
                  </thead>
                  <tbody>
                    {features.map((feat) => (
                      <tr key={feat.id}>
                        <td className="pr-2">
                          <input
                            type="text"
                            value={feat.name}
                            onChange={(e) =>
                              updateFeature(feat.id, 'name', e.target.value)
                            }
                            className="w-full rounded-lg border border-line bg-paper px-3 py-2 text-ink outline-none transition-colors focus:border-accent focus:ring-1 focus:ring-accent"
                          />
                        </td>
                        <td className="pr-2">
                          <select
                            value={feat.model}
                            onChange={(e) =>
                              updateFeature(
                                feat.id,
                                'model',
                                e.target.value as LLMKey,
                              )
                            }
                            className="w-full rounded-lg border border-line bg-paper px-3 py-2 text-ink outline-none transition-colors focus:border-accent focus:ring-1 focus:ring-accent"
                          >
                            {Object.entries(LLM_MODELS).map(([key, m]) => (
                              <option key={key} value={key}>
                                {m.name}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="text-center">
                          <button
                            onClick={() => removeFeature(feat.id)}
                            className="rounded-md p-2 text-ink-faint transition-colors hover:text-accent"
                            aria-label="Remove step"
                          >
                            <Trash2 size={16} strokeWidth={1.75} />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <Note>
                Each step assumes{' '}
                <strong className="font-medium text-ink">
                  ~{fmtNum(INPUT_TOKENS)} input and {fmtNum(OUTPUT_TOKENS)} output
                  tokens per resume
                </strong>
                , priced at the selected model's input and output rates.
              </Note>
            </section>

            {/* Infrastructure — fixed baseline */}
            <section className="rounded-xl border border-line bg-card p-6">
              <SectionHeader
                icon={<Server size={16} strokeWidth={1.75} />}
                title="Infrastructure"
                subtitle="Fixed monthly baseline, independent of resume volume."
              />
              <ul className="mt-5 space-y-1.5 text-sm">
                <RefItem label={VM_LABEL} value={`${fmtUSD(INFRA.vm)} / mo`} />
                <RefItem
                  label={PG_LABEL}
                  value={`${fmtUSD(INFRA.postgres)} / mo`}
                />
              </ul>
              {costs.overCapacity ? (
                <Note tone="warn">
                  <strong className="font-medium">Over capacity:</strong> the 2 GB
                  Postgres tier holds embeddings for ~
                  {fmtNum(PG_CAPACITY_RESUMES)} resumes ({SIZING.kbPerEmbedding} KB
                  each). Your store of {fmtNum(totalResumesStored)} exceeds it, so
                  additional instances would be needed.
                </Note>
              ) : (
                <Note>
                  <strong className="font-medium text-ink">Assumption:</strong> a
                  single VM and one {SIZING.pgInstanceCapacityGB} GB Postgres
                  instance, which holds embeddings and metadata for up to ~
                  {fmtNum(PG_CAPACITY_RESUMES)} resumes ({SIZING.kbPerEmbedding} KB
                  each). Beyond that, additional instances would be added.
                </Note>
              )}
              <p className="mt-2 text-xs text-ink-faint">
                Not included: raw resume files in Azure Blob (~
                {fmtUSD(INFRA.blobPerGB)}/GB/mo, negligible).
              </p>
            </section>
          </div>

          {/* Right: summary */}
          <aside className="lg:col-span-1">
            <div className="sticky top-6 rounded-xl bg-panel p-6 text-paper shadow-lg">
              <div className="flex items-center gap-2 border-b border-panel-line pb-3 text-paper/80">
                <Receipt size={16} strokeWidth={1.75} />
                <h2 className="text-sm font-semibold uppercase tracking-wider">
                  Monthly Estimate
                </h2>
              </div>

              <div className="mt-5 space-y-2.5 text-sm">
                <Row label="LLM usage" value={fmtUSD(costs.llmTotal)} />
                <Row label="Fixed infrastructure" value={fmtUSD(costs.fixedTotal)} />
              </div>

              <div className="mt-4 flex items-end justify-between border-t border-panel-line pt-4">
                <span className="text-sm text-paper/70">Total / month</span>
                <span className="font-mono text-3xl font-medium tracking-tight text-paper">
                  {fmtUSD(costs.total)}
                </span>
              </div>

              <div className="mt-5 grid grid-cols-3 gap-2 text-center">
                <Stat label="Per resume" value={fmtUSD(costs.perResume, 3)} />
                <Stat label="Annual" value={fmtUSD(costs.annual)} />
                <Stat label="Tokens / mo" value={fmtCompact(costs.totalTokens)} />
              </div>

              <h3 className="mt-6 text-[11px] font-semibold uppercase tracking-wider text-paper/70">
                Cost breakdown
              </h3>
              <p className="mb-3 mt-1 text-[11px] text-paper/60">
                resumes × tokens/resume = monthly tokens × model rate = cost
              </p>
              <div className="space-y-2.5">
                {costs.breakdown.map((item, idx) => (
                  <div
                    key={idx}
                    className="border-b border-panel-line/60 pb-2.5 text-xs last:border-0"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="text-paper/85">
                        <span
                          className={`mr-1.5 ${
                            item.group === 'LLM Usage'
                              ? 'text-accent'
                              : 'text-paper/35'
                          }`}
                        >
                          ●
                        </span>
                        {item.label}
                      </span>
                      <span className="whitespace-nowrap font-mono text-paper">
                        {fmtUSD(item.cost)}
                      </span>
                    </div>
                    {item.detail && (
                      <div className="mt-1.5 space-y-0.5 pl-3.5 font-mono text-[11px] text-paper/65">
                        {item.detail.map((line, i) => (
                          <div key={i}>{line}</div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </aside>
        </div>

        {/* Pricing reference (read-only LLM rates, full width) */}
        <section className="rounded-xl border border-line bg-card p-6">
          <SectionHeader
            icon={<Tag size={16} strokeWidth={1.75} />}
            title="LLM Reference Pricing"
            subtitle="Per-million-token rates behind each model in the pipeline."
          />
          <table className="mt-5 w-full max-w-2xl text-sm">
            <thead>
              <tr className="text-[11px] uppercase tracking-wider text-ink-faint">
                <th className="py-1.5 text-left font-medium">Model</th>
                <th className="py-1.5 text-right font-medium">Input / 1M</th>
                <th className="py-1.5 text-right font-medium">Output / 1M</th>
              </tr>
            </thead>
            <tbody>
              {Object.values(LLM_MODELS).map((m) => (
                <tr key={m.name} className="border-t border-line">
                  <td className="py-2.5 text-ink">{m.name}</td>
                  <td className="py-2.5 text-right font-mono text-ink-soft">
                    {fmtUSD(m.inputPer1M)}
                  </td>
                  <td className="py-2.5 text-right font-mono text-ink-soft">
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
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
}) {
  return (
    <div>
      <h2 className="flex items-center gap-2 text-base font-semibold text-ink">
        <span className="text-ink-faint">{icon}</span>
        {title}
      </h2>
      <p className="mt-1 text-sm text-ink-soft">{subtitle}</p>
    </div>
  );
}

function Note({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'warn';
}) {
  const styles =
    tone === 'warn'
      ? 'border-warn/30 bg-warn-soft text-ink'
      : 'border-line bg-paper text-ink-soft';
  const iconColor = tone === 'warn' ? 'text-warn' : 'text-ink-faint';
  return (
    <div className={`mt-4 flex gap-2 rounded-lg border p-3 text-xs ${styles}`}>
      <Info size={15} strokeWidth={1.75} className={`mt-0.5 shrink-0 ${iconColor}`} />
      <span className="leading-relaxed">{children}</span>
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
      <label className="mb-1.5 block text-sm font-medium text-ink">{label}</label>
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full rounded-lg border border-line bg-paper px-3 py-2 font-mono text-ink outline-none transition-colors focus:border-accent focus:ring-1 focus:ring-accent"
      />
      {hint && <p className="mt-1.5 text-xs text-ink-faint">{hint}</p>}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-paper/75">{label}</span>
      <span className="font-mono text-paper">{value}</span>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-panel-soft px-2 py-2.5">
      <div className="truncate font-mono text-sm font-medium text-paper">
        {value}
      </div>
      <div className="mt-0.5 text-[10px] uppercase tracking-wide text-paper/65">
        {label}
      </div>
    </div>
  );
}

function RefItem({ label, value }: { label: string; value: string }) {
  return (
    <li className="flex items-center justify-between border-b border-line py-2 last:border-0">
      <span className="text-ink">{label}</span>
      <span className="font-mono text-ink-soft">{value}</span>
    </li>
  );
}
