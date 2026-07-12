# 📚 Reading Library

An installable (PWA) reading tracker for Michelle. Scan a physical book's barcode to
add it, import Kindle + NAS eBooks, set reading goals, keep a "read next" queue, see a
stats dashboard, rate books **1–10**, and get recommendations based on what she loves.
Runs on GitHub Pages; data syncs across her devices via **Supabase**.

## Tabs
- **Scan** — camera reads a UPC/ISBN barcode → looks up cover/title/author → one tap to add. Also: search by title, enter ISBN, and bulk imports.
- **Library** — the whole collection, searchable/filterable. Tap a book to set status (To read / Reading / Finished), rate 1–10, add notes, queue it, or delete.
- **Queue** — an ordered "read next" list (reorder with ▲▼).
- **Stats** — books & pages read this year, currently reading, average rating, goal progress, and a 1–10 rating histogram.
- **Goals** — set targets (e.g. 24 books in 2026); finished books count automatically.
- **For You** — recommendations from favorite authors/genres, weighted by ratings 7+.

## Files
- `index.html`, `styles.css`, `app.js` — the app
- `config.js` — Supabase URL + **publishable** (anon) key. Safe to commit; the app relies on Row Level Security. **Never** put the `sb_secret_…` key here.
- `schema.sql` — run once in Supabase to create the tables
- `nas-scan.sh` — run on your Mac to list NAS eBooks for import
- `manifest.webmanifest`, `sw.js`, `icons/` — PWA install + offline

## One-time setup

### 1. Create the database tables (required for sync)
1. Supabase dashboard → **SQL Editor → New query**.
2. Paste the entire contents of [`schema.sql`](schema.sql) and click **Run**.
   That creates `books` + `goals` and turns on security policies.
   *Until you do this the app still works — it just says "saved locally" and syncs once the tables exist.*

### 2. Put it on GitHub Pages
```bash
cd ~/Desktop/reading-library
gh repo create reading-library --private --source=. --push   # private is recommended
```
Then on GitHub: **Settings → Pages → Build from branch → `main` / root → Save.**
Open `https://hunterberryhill85.github.io/reading-library/` in Safari on Michelle's
phone → **Share → Add to Home Screen**. It launches full-screen like a native app.

> **Why private?** The anon key is public by design and locked down by RLS, but for a
> personal library there's no reason to expose it — a private repo is the simplest safe
> choice. (Want it truly multi-user-secure? We can add Supabase email login later.)

## Run locally (to test on your Mac)
```bash
cd ~/Desktop/reading-library
python3 -m http.server 8749
# open http://localhost:8749
```
Camera scanning needs HTTPS (or localhost), which GitHub Pages provides automatically.

## Importing eBooks

### Kindle
Amazon → **Account → Content Library** (a.k.a. *Manage Your Content and Devices*) →
export/download your list as **CSV** → in the app: **Scan → Kindle CSV** → upload it.
The app adds them as eBooks and fetches covers in the background.

### NAS
On your Mac (with the NAS mounted), run:
```bash
cd ~/Desktop/reading-library
./nas-scan.sh "/Volumes/Berryhill-NAS/Books" > ~/Desktop/nas-books.txt
```
Then in the app: **Scan → NAS eBooks** → upload `nas-books.txt` (or paste the lines).
For best matching, name files `Title - Author.epub`.

## Data & backup
- Primary store is **Supabase**; every device with the app stays in sync.
- A copy is also kept on-device so the app works offline; changes re-sync when back online.
- **⚙︎ → Export JSON** saves a full backup file; **Import JSON** restores it.

## Book data sources
Open Library (primary — free, reliable) and Google Books (secondary). No API keys needed.

## Updating the app later
Edit the files, then **bump `VERSION` in `sw.js`** (e.g. `lib-v1` → `lib-v2`) so devices
pick up the new version instead of the cached one. Commit and push; Pages redeploys.
