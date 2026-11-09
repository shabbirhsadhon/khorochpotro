# খরচপত্র মাল্টি-ইউজার (Khorochpotro Multi-User)

প্রতিদিনের আয়-খরচের হিসাবের অ্যাপ — ইমেইল + পাসওয়ার্ড দিয়ে লগইন,
প্রত্যেক ব্যবহারকারীর হিসাব সম্পূর্ণ আলাদা। ভয়েস (বাংলা) দিয়ে
এন্ট্রি, মাসিক বাজেট, ক্যাটাগরি ডোনাট, PDF রিপোর্ট, CSV
ইমপোর্ট/এক্সপোর্ট, আর GitHub-এ এনক্রিপ্টেড (AES-256-GCM) ব্যাকআপ।

## গঠন

- `client/` — React + TypeScript ফ্রন্টএন্ড (`client/src/App.tsx`,
  `client/src/theme.css`, ফন্ট `client/src/assets/fonts/`)
- `server/` — সার্ভার অ্যাকশন ও ডেটাবেজ স্কিমা
  (`server/src/actions.ts`, `server/src/schema.ts`,
  `server/src/privileged.ts` — পাসওয়ার্ড হ্যাশিং ও সোর্স-আর্কাইভের
  মতো হোস্ট-ক্ষমতার কাজ)
- `drizzle/` — SQLite মাইগ্রেশন
- `space.json` — Muse ওয়েব-আর্টিফ্যাক্টের মেটাডেটা

## চালানো / বিল্ড

এই প্রজেক্ট Muse ওয়েব-আর্টিফ্যাক্ট রানটাইমে
(`@hatch/space-sdk`) চলে।

```sh
bun install
bun run typecheck
bun run build
```

## ডেটা সুরক্ষা

ব্যবহারকারীর ডেটাবেজ (`app.db`) এই আর্কাইভে নেই এবং Git-এও ওঠা
উচিত নয় — `.gitignore`-এ বাদ দেওয়া আছে। পাসওয়ার্ড সার্ভারে শুধু
সল্টেড PBKDF2-SHA256 হ্যাশ হিসেবে থাকে।
