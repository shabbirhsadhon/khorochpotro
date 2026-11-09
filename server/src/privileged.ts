// Host-only crypto for the email + password auth.
//
// Action code runs in a portable bundle that may not import Node/Bun
// host modules, so password hashing and session-token generation live
// here as privileged functions. actions.ts imports only the contract
// descriptors (via `@space/privileged`) and calls
// ctx.executePrivileged(...); the plaintext password crosses this
// boundary only in memory, and only the salted hash is ever stored.

import { pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import {
definePrivilegedContracts,
definePrivilegedHandlers,
z,
} from "@hatch/space-sdk";

const PBKDF2_ITERATIONS = 100_000;

export const Privileged = definePrivilegedContracts({
  hashPassword: {
    request: z.object({ password: z.string().min(1).max(200) }),
    response: z.object({ stored: z.string() }),
  },
  verifyPassword: {
    request: z.object({
      password: z.string().max(200),
      stored: z.string().max(500),
    }),
    response: z.object({ ok: z.boolean() }),
  },
  newSessionToken: {
    request: z.object({}),
    response: z.object({ token: z.string() }),
  },
  exportSourceArchive: {
    request: z.object({}),
    response: z.object({
      ok: z.boolean(),
      filename: z.string(),
      base64: z.string(),
      fileCount: z.number(),
    }),
  },
});

/* --------------------- Project source ZIP export ---------------------- */
// The user wants the whole project on GitHub. The action bundle cannot
// read the filesystem, so the archive is assembled here on the host:
// every source file of this space (client, server, migrations, config)
// is zipped and returned base64-encoded. User data is NEVER included —
// app.db and its journals, build output, dependencies, and audit
// artifacts are all excluded by name below.

const ZIP_SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "dist-cvm",
  "audits",
  "blobs",
]);

function isSkippedFile(name: string): boolean {
  return (
    name.startsWith("app.db") ||
    name.includes(".tsbuildinfo") ||
    name === ".xmds-icon"
  );
}

function collectSourceFiles(
  root: string,
): { rel: string; abs: string }[] {
  const out: { rel: string; abs: string }[] = [];
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const abs = join(dir, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (name.startsWith(".") || ZIP_SKIP_DIRS.has(name)) continue;
        walk(abs);
      } else if (st.isFile()) {
        if (isSkippedFile(name)) continue;
        if (st.size > 8 * 1024 * 1024) continue;
        out.push({ rel: relative(root, abs).split(sep).join("/"), abs });
      }
    }
  };
  walk(root);
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (CRC_TABLE[(crc ^ (buf[i] ?? 0)) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Minimal ZIP writer: deflate per file (stored when deflate would not
// shrink), UTF-8 filename flag, fixed 1980-01-01 timestamps so the
// archive bytes are deterministic for the same source tree.
function buildZip(entries: { name: string; data: Buffer }[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    let method = 8;
    let stored: Buffer = deflateRawSync(entry.data, { level: 9 });
    if (stored.length >= entry.data.length) {
      method = 0;
      stored = entry.data;
    }
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, stored);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0x21, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(stored.length, 20);
    cen.writeUInt32LE(entry.data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + stored.length;
  }
  const centralStart = offset;
  let centralSize = 0;
  for (const part of central) centralSize += part.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...chunks, ...central, end]);
}

const ARCHIVE_README = `# খরচপত্র মাল্টি-ইউজার (Khorochpotro Multi-User)

প্রতিদিনের আয়-খরচের হিসাবের অ্যাপ — ইমেইল + পাসওয়ার্ড দিয়ে লগইন,
প্রত্যেক ব্যবহারকারীর হিসাব সম্পূর্ণ আলাদা। ভয়েস (বাংলা) দিয়ে
এন্ট্রি, মাসিক বাজেট, ক্যাটাগরি ডোনাট, PDF রিপোর্ট, CSV
ইমপোর্ট/এক্সপোর্ট, আর GitHub-এ এনক্রিপ্টেড (AES-256-GCM) ব্যাকআপ।

## গঠন

- \`client/\` — React + TypeScript ফ্রন্টএন্ড (\`client/src/App.tsx\`,
  \`client/src/theme.css\`, ফন্ট \`client/src/assets/fonts/\`)
- \`server/\` — সার্ভার অ্যাকশন ও ডেটাবেজ স্কিমা
  (\`server/src/actions.ts\`, \`server/src/schema.ts\`,
  \`server/src/privileged.ts\` — পাসওয়ার্ড হ্যাশিং ও সোর্স-আর্কাইভের
  মতো হোস্ট-ক্ষমতার কাজ)
- \`drizzle/\` — SQLite মাইগ্রেশন
- \`space.json\` — Muse ওয়েব-আর্টিফ্যাক্টের মেটাডেটা

## চালানো / বিল্ড

এই প্রজেক্ট Muse ওয়েব-আর্টিফ্যাক্ট রানটাইমে
(\`@hatch/space-sdk\`) চলে।

\`\`\`sh
bun install
bun run typecheck
bun run build
\`\`\`

## ডেটা সুরক্ষা

ব্যবহারকারীর ডেটাবেজ (\`app.db\`) এই আর্কাইভে নেই এবং Git-এও ওঠা
উচিত নয় — \`.gitignore\`-এ বাদ দেওয়া আছে। পাসওয়ার্ড সার্ভারে শুধু
সল্টেড PBKDF2-SHA256 হ্যাশ হিসেবে থাকে।
`;

const ARCHIVE_GITIGNORE = `node_modules/
app.db
app.db-shm
app.db-wal
.space-build/
.space-build-cvm/
.bun-cache/
.harness/
audits/
blobs/
client/dist/
client/dist-cvm/
server/dist/
server/.generated/
*.tsbuildinfo
`;

function spaceRootDir(): string {
  const env = process.env.HATCH_SPACE_DIR?.trim();
  if (env) return env;
  // This file builds to <root>/server/dist/privileged.js.
  return join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
}

export const PrivilegedHandlers = definePrivilegedHandlers(Privileged, {
  hashPassword: ({ password }) => {
    const salt = randomBytes(16);
    const hash = pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 32, "sha256");
    return {
      stored: `pbkdf2$${PBKDF2_ITERATIONS}$${salt.toString("base64")}$${hash.toString("base64")}`,
    };
  },
  verifyPassword: ({ password, stored }) => {
    const parts = stored.split("$");
    if (parts.length !== 4 || parts[0] !== "pbkdf2") return { ok: false };
    const iterations = Number(parts[1]);
    const salt = Buffer.from(parts[2] ?? "", "base64");
    const expected = Buffer.from(parts[3] ?? "", "base64");
    if (!Number.isFinite(iterations) || iterations <= 0 || expected.length === 0) {
      return { ok: false };
    }
    const actual = pbkdf2Sync(password, salt, iterations, expected.length, "sha256");
    return { ok: timingSafeEqual(actual, expected) };
  },
  newSessionToken: () => {
    return { token: randomBytes(32).toString("base64url") };
  },
  exportSourceArchive: () => {
    try {
      const root = spaceRootDir();
      const files = collectSourceFiles(root);
      if (files.length === 0) {
        return { ok: false, filename: "", base64: "", fileCount: 0 };
      }
      const entries: { name: string; data: Buffer }[] = files.map((f) => ({
        name: `khorochpotro-multi-user/${f.rel}`,
        data: readFileSync(f.abs),
      }));
      if (!files.some((f) => f.rel === "README.md")) {
        entries.push({
          name: "khorochpotro-multi-user/README.md",
          data: Buffer.from(ARCHIVE_README, "utf8"),
        });
      }
      if (!files.some((f) => f.rel === ".gitignore")) {
        entries.push({
          name: "khorochpotro-multi-user/.gitignore",
          data: Buffer.from(ARCHIVE_GITIGNORE, "utf8"),
        });
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const zip = buildZip(entries);
      return {
        ok: true,
        filename: "khorochpotro-multi-user-source.zip",
        base64: zip.toString("base64"),
        fileCount: entries.length,
      };
    } catch {
      return { ok: false, filename: "", base64: "", fileCount: 0 };
    }
  },
});
