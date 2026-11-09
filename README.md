# খরচপত্র (khorochpotro)

Daily expense tracker in Bangla — manual entry and Bangla voice input, with automatic category and expense/deposit detection. Single file, no framework, no build step. Works on phone and laptop.

> **Status:** Web version ready. Android app (APK) is being built from this same code. Offline on-device voice and automatic GitHub sync are in progress.

## Open it

- **Website (GitHub Pages):** enable Pages in Settings → Pages → Deploy from a branch → `main` / root, then open `https://shabbirhsadhon.github.io/khorochpotro/` — Pages needs a **public** repository on GitHub Free (see [Security](#security)).
- **On your phone:** open the Pages link in Brave/Chrome → menu → Add to Home screen. It opens like an app.
- **Offline:** after the first load, the page works from the installed shortcut. Voice needs the on-device model (see below).

## Features

- Manual entry for expenses and deposits, with edit and delete
- Bangla voice input (microphone, `bn-BD`): speak an amount and it detects the amount, whether it is an expense or a deposit, and the category
- Bangla number words: সাড়ে সাতশো = 750, এক হাজার দুইশো = 1200, দেড় হাজার = 1500
- Balance, today / weekly / monthly totals, average daily expense
- Category chart, monthly budget progress, search and filter
- Monthly report as a real PDF file, plus CSV export / import
- Microphone permission: granted once in the browser, then remembered. Open over HTTPS — a downloaded file opened directly (`content://` / `file://`) cannot use the microphone.
- Offline voice (in progress): an on-device Whisper model, downloaded once while online, then transcribes on the phone with no internet. The built-in browser voice needs internet.
- Automatic sync (in progress): **no buttons.** Every entry uploads to GitHub by itself right after it is saved. No internet? Entries stay saved on the device and upload automatically when the connection returns. Opening the app or website on any device loads the latest backup from GitHub, so phone and laptop always show the same data. See [Security](#security) for how the backup is protected.

## Project layout

```text
khorochpotro/
├── index.html      # the whole app — open it directly or serve it with Pages
├── README.md       # this file
├── SECURITY.md     # security notes — read before enabling Pages or sync
├── .gitignore      # keeps tokens, local backups and build outputs out of the repo
├── data/           # sync file location (created by the app; see SECURITY.md)
└── android/        # Capacitor Android project (APK build — coming soon)
```

## Development

No build step. Edit `index.html` and reload. All maths uses paisa integers, so totals have no rounding errors.

## Security

See [SECURITY.md](SECURITY.md). Short version: the backup is encrypted on your device before upload, so GitHub only ever stores unreadable data. Never commit a token, a keystore, or your unencrypted backup to a public repo.

Built with Muse for Shabbir Hossin Sadhon — https://github.com/shabbirhsadhon
