# SQL Lab · BigQuery

A local practice app for BigQuery SQL — a follow-up to DataCamp's *Intermediate SQL*.
25 auto-graded exercises in three modules, all on Google's public **thelook_ecommerce** dataset (a fictitious online clothing store):

1. **BigQuery basics, joins & CTEs** — table names, BigQuery date functions, INNER/LEFT joins, subqueries, CTEs, `SAFE_DIVIDE`, `COUNTIF`
2. **Window functions & QUALIFY** — running totals, `LAG`, `RANK`, `ROW_NUMBER`, `QUALIFY`, `TIMESTAMP_DIFF`, moving averages, `NTILE`
3. **ARRAY, STRUCT & UNNEST** — `ARRAY_AGG`, `ARRAY_LENGTH`, `GENERATE_DATE_ARRAY`, structs, lookup tables, `IN UNNEST`

You write the query, press **Run** to see the result and **Submit** to have it checked. Your query runs in real BigQuery; the app runs the reference solution too and compares the two results (column order, small rounding differences and — unless the task asks for sorting — row order don't matter). Hints, solutions, the table schemas and how much data each query scanned are all shown in the app. Progress is saved in your browser.

---

## Setup (once, ~15 minutes)

### 1. Install Node.js
Download the LTS version from <https://nodejs.org> (version 18 or newer) and install it.

### 2. Create a free BigQuery sandbox
1. Go to <https://console.cloud.google.com/bigquery> and sign in with a Google account.
2. Create a new project when asked (e.g. *sql-lab*). No credit card is needed — without billing the project runs as a **sandbox** with a free monthly query allowance, far more than these exercises use.
3. Note the **project ID** (shown in the project picker, e.g. `sql-lab-123456`).

### 3. Install the Google Cloud CLI and log in
1. Install it from <https://cloud.google.com/sdk/docs/install>.
2. Open a terminal (on Windows: *Google Cloud SDK Shell* or PowerShell) and run:

```bash
gcloud auth login
gcloud config set project YOUR-PROJECT-ID
```

The app borrows this login — no keys or passwords are stored in the app.

### 4. Start the app
Unzip the folder, open a terminal in it and run:

```bash
npm start
```

Then open <http://localhost:3000>. The pill in the top-right corner turns green when BigQuery is connected.
No `npm install` is needed — the app has no dependencies.

*Optional:* instead of `gcloud config set project`, copy `.env.example` to `.env` and put the project ID there.

---

## Tips

- **Ctrl + Enter** runs the query, **Ctrl + Shift + Enter** submits it. **Ctrl + Space** autocompletes table and column names.
- Blanks (`___`) in the starter code are highlighted — fill them all in.
- *Show solution* unlocks after two attempts or once all hints are used. After solving, the **Expected output** tab shows the reference result.
- The dataset is refreshed regularly by Google, so the numbers can change from day to day. That's fine — the answer is always computed fresh.
- Every query has a 10 GB scan limit as a safety net (the biggest exercise scans a fraction of that).

## Troubleshooting

| Problem | Fix |
|---|---|
| "Could not get a Google access token" | Run `gcloud auth login` again. Check that `gcloud` works in a new terminal. |
| "No Google Cloud project set" | `gcloud config set project YOUR-PROJECT-ID` or set `GCP_PROJECT_ID` in `.env`. |
| "Access Denied … bigquery.jobs.create" | The project ID is wrong, or BigQuery isn't enabled yet — open the BigQuery console in that project once. |
| Port 3000 in use | Add `PORT=3001` to `.env`. |

## Adding exercises

Exercises live in `exercises/*.json` (one file per module) and are reloaded every time the page loads. Each exercise has:

```jsonc
{
  "id": "m4-e01",                 // unique
  "title": "…",
  "context": ["markdown lines", "", "…"],
  "instructions": ["step 1", "step 2"],
  "starter": ["SELECT ___", "FROM …"],   // ___ marks a blank
  "solution": ["SELECT …", "FROM …"],
  "hints": ["…", "…"],
  "tables": ["orders"],
  "orderMatters": false,          // optional: true if the task asks for a sort order
  "tolerance": 0.01,              // optional: allowed numeric difference
  "requiredPatterns": [           // optional: e.g. force a technique
    { "pattern": "\\bQUALIFY\\b", "message": "Use QUALIFY …" }
  ]
}
```

Run `npm test` to check the exercise files and grading logic (works offline).
