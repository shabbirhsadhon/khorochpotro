# খরচপত্র

Bangla daily expense tracker for one person. No login, no server — everything
stays on your device.

## What it does
- Add entries by typing or by Bangla voice (offline Whisper; the model
  downloads once, then works without net). Every voice entry shows a
  preview first — amount, type (খরচ / জমা-আয়) and category — and you can
  fix it before tapping "অ্যাড করুন".
- Monthly income, expense and balance, category-wise expense, monthly
  budget with a progress bar.
- Add / edit / delete entries, search and filter, period previews with
  interactive donuts, month-stepper navigation.
- Monthly PDF report, CSV export and import.
- Encrypted GitHub backup (entries + monthly budget): AES-GCM encrypted
  on the device with your passphrase, auto-backup after every change,
  restore from "ব্যাকআপ থেকে আনুন". The GitHub token and passphrase never
  leave your device — the repo only holds ciphertext.
- Bangla number words, paisa-integer maths, Atma + Hind Siliguri fonts
  bundled.

## Use it
- Website: https://shabbirhsadhon.github.io/khorochpotro/ (GitHub Pages)
- Android: build from the Pages URL with WebIntoApp.
- Data lives in the browser (localStorage). There is no account — the app
  opens straight into your ledger.

## Files
- `index.html` — the whole app in one file
- `model/parser-model.json` — voice parser rules (v3); the "মডেল আপডেট"
  button checks this file on GitHub for newer rules

## Security
See SECURITY.md. Never commit tokens, passphrases or unencrypted backups.
