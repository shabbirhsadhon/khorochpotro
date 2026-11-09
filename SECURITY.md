# Security — খরচপত্র

## Never commit secrets

- Never put a GitHub token, password, API key, keystore (`.jks` / `.keystore`) or
  `local.properties` in this repo. They are listed in `.gitignore`, but do not
  rely on that alone — check before every commit.
- The app's GitHub backup token is entered in the app settings and stored
  **only on your device** (browser/app storage). It is never sent anywhere
  except to `api.github.com` when you press Backup or Restore.

## Automatic sync — how your data is protected

- **Encrypted before upload.** The backup is encrypted on your device with
  your own passphrase (AES-GCM, key derived with PBKDF2) before anything is
  sent to GitHub. GitHub stores only the encrypted file — without your
  passphrase nobody can read your entries, not even with full repo access.
- **The passphrase is never stored on GitHub.** It lives only on your devices.
  If you forget it, the backup cannot be opened again — there is no recovery.
  Keep it somewhere safe, separate from the repo.
- **The GitHub token** (needed so the app can write to the repo) is entered
  once in the app settings and stored only on your device. It is sent only to
  `api.github.com` when the app syncs. Use a fine-grained token that can write
  to this repo only, nothing else.
- **No sync buttons, no accidental exposure.** Sync runs by itself: every
  entry uploads automatically after it is saved, and the app loads the latest
  backup when it opens. Nothing is uploaded in plain text, ever.
- **Offline is safe.** With no internet, entries stay saved on the device
  (local storage) and upload automatically when the connection returns.

- Your entries (amounts, categories, notes) are personal financial data.
- **While this repo is private**, a backup file at `data/backup.json` is
  visible only to you (and anyone you give repo access to).
- **If you make this repo public** (needed for GitHub Pages on GitHub Free),
  do NOT keep `data/backup.json` in it — anyone on the internet could read
  your expenses. In that case keep backup in a secret Gist or a separate
  private repo, and keep this repo for code only.
- GitHub Pages sites are public even when the source repo is private on a
  paid plan. Never put expense data, tokens or keys in a Pages site.

## GitHub Pages visibility

- GitHub Free: Pages works only from a **public** repository.
- GitHub Pro / Team: Pages can build from a private repository, but the
  published site is still public to anyone with the link.
- Only GitHub Enterprise Cloud can restrict who opens a Pages site.
- Decide before enabling Pages: public repo + code only, or private repo
  + no Pages (use the Android app and the Muse link instead).

## Reporting a problem

If you find a security problem in this project, tell the owner privately
instead of opening a public issue.
