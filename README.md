# 👛 Mošnja — personal monthly budget

A deliberately simple budgeting app: enter this month's **income** (salary, side work, firewood sales, …)
and **planned expenses** (loan, utility bills, VISA, …) and see how much money is actually left to spend.

- Mobile-first, single `index.html`, **no external libraries** (nothing third-party runs on a page with financial data)
- Data lives in **your own Google Sheet** via a Google Apps Script Web App
- Protected by a **6-digit PIN checked on the server**
- Hosted on **GitHub Pages**

## Features (v2)

| | |
|---|---|
| Month view | Income, planned expenses, "Na voljo" (left over), % of income already committed |
| Items | One-off (belongs to one month) or **recurring series**: from month X, until month Y or with no end (∞) |
| Changing a recurring item | Pick the scope: **only this month** (e.g. VISA is higher in December), **this and following months** (e.g. salary raise from January), or **all months** |
| Deleting a recurring item | Skip only this month, end the series from this month on, or delete it everywhere |
| Year view | 12 months side by side: native SVG chart (income vs. expenses), table with every item per month, totals and "Na voljo" per month, tightest month highlighted. Tap a month to open it |
| PIN | Set on first launch, change in ⚙️, auto-lock after 5 min of inactivity |
| Demo mode | If `API_URL` is empty, the app runs fully in the browser with sample data |

## Security model

The repo is public, so **nothing secret lives in it**. The Apps Script URL is not a secret — the PIN is what protects the data.

- PIN is stored only as a salted, iterated SHA-256 hash in Apps Script **Script Properties** (not in the sheet, not in the repo).
- 5 wrong PINs → API locked for 15 minutes (server-side, so it can't be bypassed from the browser).
- Correct PIN → random session token, valid 10 min (sliding). Every data request needs it.
- Text starting with `= + - @` is stored as plain text (no formula injection into the sheet).
- Forgot the PIN? Open the Apps Script editor → run `resetPin` → open the app and set a new one.

## Setup

1. **Google Sheet** — create a new sheet (e.g. "Mošnja"). The `Postavke` tab is created automatically on first save.
2. **Apps Script** — in the sheet: *Extensions → Apps Script*. Replace the contents of `Code.gs` with
   [`apps-script/Code.gs`](apps-script/Code.gs). Save.
3. **Deploy** — *Deploy → New deployment → Web app*
   - Execute as: **Me**
   - Who has access: **Anyone** (required so the page can call it; the PIN guards the data)
   - Authorize, then copy the Web App URL (ends with `/exec`).
4. **Connect** — in `index.html` set `const API_URL = 'https://script.google.com/macros/s/…/exec';`
5. **GitHub** — create the repo `mosnja`, upload `index.html` (and this README), then
   *Settings → Pages → Deploy from branch → main / root*.
6. Open the Pages URL on your phone, set your PIN, *Share → Add to Home Screen*.

**Updating the backend later:** *Deploy → Manage deployments → ✏️ → Version: New version → Deploy* (URL stays the same).

## Data structure (`Postavke` sheet)

| ID | Mesec | Tip | Naziv | Kategorija | Znesek | Ponavljajoce | Opomba | Ustvarjeno | Posodobljeno | DoMeseca | Nadrejena | Preskoci |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| a1b2c3d4 | 2026-11 | odhodek | Stanovanjski kredit | Kredit | 420 | TRUE | | … | … | 2029-03 | | FALSE |
| e5f6a7b8 | 2026-12 | odhodek | VISA | Kartica | 620 | FALSE | darila | … | … | | c9d0e1f2 | FALSE |

- **One-off item:** `Ponavljajoce = FALSE`, `Mesec` = its month.
- **Series:** `Ponavljajoce = TRUE`, `Mesec` = first month, `DoMeseca` = last month (empty = no end).
- **Month override:** `Nadrejena` = series ID. Replaces the amount for that month, or skips it (`Preskoci = TRUE`).

The app computes every month from these rows, so the year view always shows the plan into the future.

## Roadmap ideas

- Actual vs. planned per item ("plačano" checkbox)
- Annual costs spread over 12 months (car insurance, registration, NUSZ)
- Rolling "next 12 months" view
- Export year to CSV
