# AHORA · AI Recruitment Cost Estimator

An interactive estimator for the monthly infrastructure and LLM-token spend of
the AHORA resume-intelligence platform. Built with React + TypeScript + Vite and
styled with Tailwind CSS v4.

## What it models

All pricing defaults come from the project's `Cost breakdown.md` and are fully
editable in the UI.

**LLM models** (USD / 1M tokens)

| Model | Input | Output |
| --- | --- | --- |
| DeepSeek-V4 Flash (Global) | $0.19 | $0.51 |
| DeepSeek-V4 Pro (Global) | $1.74 | $3.48 |
| GPT-4.1 | $2.00 | $8.00 |

**Infrastructure** (monthly)

| Item | Price |
| --- | --- |
| VM (1 vCPU / 4GB RAM) | $36.938 / mo |
| Postgres (1 core, 2GB ≈ 130k resumes) | $12.41 / mo |
| Azure Blob storage | $0.18 / GB / mo |

**Sizing assumptions:** ~2,000 tokens per resume, ~16 KB embedding + metadata per
resume in Postgres. Embedding generation is assumed to run on the application VM
(no per-token API cost).

## How the estimate is built

1. **LLM usage** — each pipeline step (parsing, scoring, summary, screening) runs
   per resume; token volume × model price = usage cost.
2. **Compute** — `vmCount × $36.938`.
3. **Database** — Postgres auto-scales by 2GB instances based on total stored
   resumes × KB/resume.
4. **Storage** — Azure Blob = total resumes × raw-file KB × $0.18/GB.

## Develop

```bash
npm install
npm run dev      # local dev server
npm run build    # type-check + production build to dist/
npm run preview  # serve the production build
```

## Deploy

Hosted on [Render](https://render.com) as a static site via the `render.yaml`
Blueprint (build `npm ci && npm run build`, publish `./dist`).
