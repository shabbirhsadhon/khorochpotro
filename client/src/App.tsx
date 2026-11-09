import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { bytesToBase64 } from "@hatch/space-sdk/client";
import { api, type ApiResponse } from "./api";

// খরচপত্র — the original final app's UI and functions, with the
// multi-user login/logout system on top: every account's ledger lives
// on the server under its own user id, and the device keeps only the
// session token until the user explicitly logs out.

type Entry = ApiResponse<typeof api, "listAllEntries">["entries"][number];
type EntryType = "expense" | "income";

const TOKEN_KEY = "khorochpotro-mu-token";

/* ---------------------------- Request timeout --------------------------- */

// Action calls ride on a plain fetch with no built-in deadline: on a
// stalled connection the promise never settles, so a tapped button sits
// on its "waiting" label forever with no error and no way forward
// (reported on the login button). Racing the call against a deadline
// turns a dead connection into a normal, retryable failure instead.
const REQUEST_TIMEOUT_MS = 30_000;

class RequestTimeoutError extends Error {
  constructor() {
    super("request-timeout");
    this.name = "RequestTimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, ms = REQUEST_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new RequestTimeoutError()), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

/* ------------------------------ Categories ------------------------------ */

const EXPENSE_CATS = [
  "খাবার", "বাজার-সদাই", "যাতায়াত", "বিল ও ভাড়া", "স্বাস্থ্য",
  "শিক্ষা", "কেনাকাটা", "বিনোদন", "অন্যান্য",
];
const INCOME_CATS = [
  "ফ্যামিলি থেকে প্রাপ্ত", "টিউশন", "ফ্রিল্যান্স", "ক্রিপ্টো / P2P",
  "উপহার", "অন্যান্য",
];
const ALL_CATS = [
  ...EXPENSE_CATS,
  ...INCOME_CATS.filter((c) => !EXPENSE_CATS.includes(c)),
];
const CAT_COLORS = [
  "#0b6e4f", "#2563eb", "#d97706", "#b3261e", "#7c3aed", "#0891b2",
  "#db2777", "#65a30d", "#64748b", "#0d9488", "#9333ea", "#ea580c",
  "#4f46e5", "#be185d",
];
function catColor(cat: string): string {
  const i = ALL_CATS.indexOf(cat);
  return CAT_COLORS[(i < 0 ? ALL_CATS.length : i) % CAT_COLORS.length] ?? "#64748b";
}

const MONTH_NAMES = [
  "জানুয়ারি", "ফেব্রুয়ারি", "মার্চ", "এপ্রিল", "মে", "জুন",
  "জুলাই", "আগস্ট", "সেপ্টেম্বর", "অক্টোবর", "নভেম্বর", "ডিসেম্বর",
];
const DAY_NAMES = [
  "রবিবার", "সোমবার", "মঙ্গলবার", "বুধবার", "বৃহস্পতিবার", "শুক্রবার", "শনিবার",
];

/* --------------------------- Number formatting --------------------------- */

const BN_DIGITS = ["০", "১", "২", "৩", "৪", "৫", "৬", "৭", "৮", "৯"];
const BN_DIGIT_MAP: Record<string, string> = {};
"০১২৩৪৫৬৭৮৯".split("").forEach((ch, i) => (BN_DIGIT_MAP[ch] = String(i)));
"٠١٢٣٤٥٦٧٨٩".split("").forEach((ch, i) => (BN_DIGIT_MAP[ch] = String(i)));

function normalizeDigits(s: string): string {
  return String(s ?? "").replace(/[০-৯٠-٩]/g, (ch) => BN_DIGIT_MAP[ch] ?? ch);
}
function toBnDigits(s: string | number): string {
  return String(s).replace(/\d/g, (d) => BN_DIGITS[Number(d)] ?? d);
}

const fmtNum0 = new Intl.NumberFormat("bn-BD", { maximumFractionDigits: 0 });
const fmtNum2 = new Intl.NumberFormat("bn-BD", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const fmtNumVar = new Intl.NumberFormat("bn-BD", { maximumFractionDigits: 2 });
const fmtYearFmt = new Intl.NumberFormat("bn-BD", {
  useGrouping: false,
  maximumFractionDigits: 0,
});
function bnYear(n: number): string {
  return fmtYearFmt.format(n);
}
function bnInt(n: number): string {
  return fmtNum0.format(n);
}
function fmtPct(pct: number): string {
  return fmtNumVar.format(Math.round(pct * 10) / 10);
}

/** Poisha -> "৳ ১,২৫০" / "৳ ১,২৫০.৫০" (poisha part always two digits). */
function fmtMoney(poisha: number): string {
  const neg = poisha < 0;
  const abs = Math.abs(Math.round(poisha));
  const taka = Math.floor(abs / 100);
  const p = abs % 100;
  const txt = p === 0 ? fmtNum0.format(taka) : fmtNum2.format(taka + p / 100);
  return `${neg ? "−" : ""}৳ ${txt}`;
}
function fmtSigned(poisha: number, type: EntryType): string {
  return `${type === "income" ? "+" : "−"}${fmtMoney(Math.abs(poisha))}`;
}

/** User-typed amount -> poisha, or null when invalid. */
function parseAmountToPoisha(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const s = normalizeDigits(String(raw))
    .replace(/[,，\s'’]/g, "")
    .replace(/৳/g, "")
    .replace(/টাকা/g, "");
  if (!s) return null;
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(s)) return null;
  const parts = s.split(".");
  const takaPart = parts[0] ?? "0";
  const poisha =
    parseInt(takaPart, 10) * 100 +
    (parts[1] ? parseInt((parts[1] + "0").slice(0, 2), 10) : 0);
  if (!Number.isFinite(poisha) || poisha <= 0 || poisha > 99999999999) return null;
  return poisha;
}

/** Poisha -> text for the budget input (keeps the poisha part). */
function budgetInputText(poisha: number): string {
  const taka = Math.floor(poisha / 100);
  const p = poisha % 100;
  return p ? `${taka}.${String(p).padStart(2, "0")}` : String(taka);
}

/* --------------------------------- Dates -------------------------------- */

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
function dateStr(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function todayKey(): string {
  return dateStr(new Date());
}
function monthOf(dateString: string): string {
  return String(dateString).slice(0, 7);
}
function currentMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}
function parseDateLocal(s: string): Date {
  const p = String(s).split("-");
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}
function monthLabel(ym: string): string {
  const p = String(ym).split("-");
  return `${MONTH_NAMES[Number(p[1]) - 1] ?? ""} ${bnYear(Number(p[0]))}`;
}
function shiftMonth(ym: string, delta: number): string {
  const p = String(ym).split("-");
  const d = new Date(Number(p[0]), Number(p[1]) - 1 + delta, 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}
function dayLabel(ds: string): string {
  const t = todayKey();
  const y = dateStr(new Date(Date.now() - 86400000));
  if (ds === t) return "আজ";
  if (ds === y) return "গতকাল";
  if (ds === dateStr(new Date(Date.now() + 86400000))) return "আগামীকাল";
  const d = parseDateLocal(ds);
  return `${DAY_NAMES[d.getDay()] ?? ""}, ${fmtNum0.format(d.getDate())} ${MONTH_NAMES[d.getMonth()] ?? ""}`;
}
function todayLine(): string {
  const now = new Date();
  return `${DAY_NAMES[now.getDay()] ?? ""}, ${fmtNum0.format(now.getDate())} ${MONTH_NAMES[now.getMonth()] ?? ""} ${bnYear(now.getFullYear())}`;
}
/** This week: Sunday through Saturday. */
function weekRange(): { start: string; end: string } {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const start = new Date(now);
  start.setDate(now.getDate() - now.getDay());
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return { start: dateStr(start), end: dateStr(end) };
}
function daysInMonth(ym: string): number {
  const p = ym.split("-");
  return new Date(Number(p[0]), Number(p[1]), 0).getDate();
}
function validDateStr(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || "")) return false;
  const p = String(s).split("-");
  const mo = Number(p[1]);
  const da = Number(p[2]);
  if (mo < 1 || mo > 12 || da < 1) return false;
  return da <= daysInMonth(`${p[0]}-${p[1]}`);
}
function elapsedDaysInMonth(ym: string): number {
  if (ym === currentMonth()) return new Date().getDate();
  if (ym > currentMonth()) return 0;
  return daysInMonth(ym);
}
function sumEntries(list: Entry[], type: EntryType): number {
  let total = 0;
  for (const e of list) if (e.type === type) total += e.amountPoisha;
  return total;
}

/* ------------------------- Voice parsing (Bengali) ------------------------ */
/* Ported from the original app's trained parser: number words (সাড়ে /
   পৌনে / সোয়া, শো-compounds, lakh/crore multipliers), person-aware
   give/send detection (আমাকে দিছে = জমা, আমি দিয়েছি = খরচ), and the
   full category keyword rules. */

const WORD_NUM: Record<string, number> = {
  "শূন্য": 0, "এক": 1, "একটা": 1, "দুই": 2, "দুইটা": 2, "দুটো": 2, "তিন": 3, "তিনটা": 3, "চার": 4, "চারটা": 4,
  "পাঁচ": 5, "পাঁচটা": 5, "ছয়": 6, "ছয়টা": 6, "সাত": 7, "সাতটা": 7, "আট": 8, "আটটা": 8, "নয়": 9, "নয়টা": 9, "দশটা": 10,
  "দশ": 10, "এগারো": 11, "বারো": 12, "তেরো": 13, "চৌদ্দ": 14, "পনেরো": 15, "পনের": 15,
  "ষোলো": 16, "ষোল": 16, "সতেরো": 17, "সতের": 17, "আঠারো": 18, "আঠার": 18, "উনিশ": 19, "ঊনিশ": 19,
  "বিশ": 20, "কুড়ি": 20, "একুশ": 21, "বাইশ": 22, "তেইশ": 23, "চব্বিশ": 24, "পঁচিশ": 25,
  "ছাব্বিশ": 26, "সাতাশ": 27, "আটাশ": 28, "ঊনত্রিশ": 29, "ত্রিশ": 30, "একত্রিশ": 31,
  "বত্রিশ": 32, "তেত্রিশ": 33, "চৌত্রিশ": 34, "পঁয়ত্রিশ": 35, "ছত্রিশ": 36, "সাইত্রিশ": 37,
  "আটত্রিশ": 38, "ঊনচল্লিশ": 39, "চল্লিশ": 40, "একচল্লিশ": 41, "বিয়াল্লিশ": 42, "তেতাল্লিশ": 43,
  "চুয়াল্লিশ": 44, "পঁয়তাল্লিশ": 45, "ছেচল্লিশ": 46, "সাতচল্লিশ": 47, "আটচল্লিশ": 48,
  "ঊনপঞ্চাশ": 49, "পঞ্চাশ": 50,
  "একান্ন": 51, "বাহান্ন": 52, "তিপ্পান্ন": 53, "চুয়ান্ন": 54, "পঞ্চান্ন": 55,
  "ছাপ্পান্ন": 56, "সাতান্ন": 57, "আটান্ন": 58, "ঊনষাট": 59, "ষাট": 60,
  "একষট্টি": 61, "বাষট্টি": 62, "তেষট্টি": 63, "চৌষট্টি": 64, "পঁয়ষট্টি": 65,
  "ছেষট্টি": 66, "সাতষট্টি": 67, "আটষট্টি": 68, "ঊনসত্তর": 69, "সত্তর": 70,
  "একাত্তর": 71, "বাহাত্তর": 72, "তিয়াত্তর": 73, "তেহাত্তর": 73, "চুয়াত্তর": 74, "পঁচাত্তর": 75,
  "ছিয়াত্তর": 76, "সাতাত্তর": 77, "আটাত্তর": 78, "ঊনআশি": 79, "আশি": 80,
  "একাশি": 81, "বিরাশি": 82, "তিরাশি": 83, "চুরাশি": 84, "পঁচাশি": 85,
  "ছিয়াশি": 86, "সাতাশি": 87, "আটাশি": 88, "ঊননব্বই": 89, "নব্বই": 90,
  "একানব্বই": 91, "বিরানব্বই": 92, "তিরানব্বই": 93, "চুরানব্বই": 94, "পঁচানব্বই": 95,
  "ছিয়ানব্বই": 96, "সাতানব্বই": 97, "আটানব্বই": 98, "নিরানব্বই": 99,
};
const SPECIAL_NUM: Record<string, number> = {
  "দেড়শো": 150, "আড়াইশো": 250, "দেড়": 1.5, "আড়াই": 2.5,
  "দেড়হাজার": 1500, "আড়াইহাজার": 2500, "আধা": 0.5,
};
const NUM_EXTRA_PREFIX: Record<string, number> = { "দু": 2 };

function wordNumberFromTokens(tokens: string[]): number | null {
  const candidates: number[] = [];
  let total = 0;
  let current = 0;
  let found = false;
  let halfPending = false;
  let quarterPending = 0;
  function quarterOf(v: number): number {
    if (v <= 0) return 0.25;
    return Math.pow(10, String(Math.floor(v)).length - 1) / 4;
  }
  function closeSegment(isPaisa: boolean) {
    if (found) {
      const seg = total + current;
      if (seg > 0) {
        if (isPaisa) {
          if (candidates.length) {
            candidates[candidates.length - 1] =
              (candidates[candidates.length - 1] ?? 0) + seg / 100;
          } else candidates.push(seg / 100);
        } else candidates.push(seg);
      }
    }
    total = 0;
    current = 0;
    found = false;
    halfPending = false;
    quarterPending = 0;
  }
  for (const t of tokens) {
    if (t === "পয়সা") {
      closeSegment(true);
      continue;
    }
    if (/^\d+$/.test(t)) {
      let dv = parseInt(t, 10);
      if (halfPending) {
        dv += dv > 0 ? Math.pow(10, String(dv).length - 1) / 2 : 0.5;
        halfPending = false;
      }
      if (quarterPending) {
        dv += quarterPending * quarterOf(dv);
        quarterPending = 0;
      }
      current += dv;
      found = true;
      continue;
    }
    if (/^\d+\.\d+$/.test(t)) {
      current +=
        parseFloat(t) +
        (halfPending ? 0.5 : 0) +
        (quarterPending ? quarterPending * 0.25 : 0);
      halfPending = false;
      quarterPending = 0;
      found = true;
      continue;
    }
    if (t === "সাড়ে") {
      halfPending = true;
      continue;
    }
    if (t === "পৌনে") {
      quarterPending = -1;
      continue;
    }
    if (t === "সোয়া") {
      quarterPending = 1;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(SPECIAL_NUM, t)) {
      current += SPECIAL_NUM[t] ?? 0;
      found = true;
      continue;
    }
    const shoMatch = t.match(/^(.+?)(শো|শ)$/);
    if (
      shoMatch &&
      (Object.prototype.hasOwnProperty.call(WORD_NUM, shoMatch[1] ?? "") ||
        Object.prototype.hasOwnProperty.call(NUM_EXTRA_PREFIX, shoMatch[1] ?? ""))
    ) {
      const shoBase =
        WORD_NUM[shoMatch[1] ?? ""] ?? NUM_EXTRA_PREFIX[shoMatch[1] ?? ""] ?? 0;
      const shoLimit = shoMatch[2] === "শো" ? 99 : 9;
      if (shoBase >= 1 && shoBase <= shoLimit) {
        current +=
          shoBase * 100 +
          (halfPending ? 50 : 0) +
          (quarterPending ? quarterPending * 25 : 0);
        halfPending = false;
        quarterPending = 0;
        found = true;
        continue;
      }
    }
    const multMatch = t.match(/^(.+?)(হাজার|লাখ|লক্ষ|কোটি)$/);
    if (multMatch) {
      let multBase: number | null = null;
      const base = multMatch[1] ?? "";
      if (/^\d+(\.\d+)?$/.test(base)) multBase = parseFloat(base);
      else if (Object.prototype.hasOwnProperty.call(WORD_NUM, base))
        multBase = WORD_NUM[base] ?? null;
      else if (Object.prototype.hasOwnProperty.call(NUM_EXTRA_PREFIX, base))
        multBase = NUM_EXTRA_PREFIX[base] ?? null;
      else if (Object.prototype.hasOwnProperty.call(SPECIAL_NUM, base))
        multBase = SPECIAL_NUM[base] ?? null;
      if (multBase != null && multBase > 0) {
        const multVal =
          multMatch[2] === "হাজার"
            ? 1000
            : multMatch[2] === "কোটি"
              ? 10000000
              : 100000;
        if (halfPending) {
          multBase += 0.5;
          halfPending = false;
        }
        if (quarterPending) {
          multBase += quarterPending * 0.25;
          quarterPending = 0;
        }
        total += (current + multBase) * multVal;
        current = 0;
        found = true;
        continue;
      }
    }
    if (Object.prototype.hasOwnProperty.call(WORD_NUM, t)) {
      let v = WORD_NUM[t] ?? 0;
      if (halfPending) {
        v += 0.5;
        halfPending = false;
      }
      if (quarterPending) {
        v += quarterPending * 0.25;
        quarterPending = 0;
      }
      current += v;
      found = true;
      continue;
    }
    if (t === "শত" || t === "শতক" || t === "শ" || t === "শো") {
      current = (current || 1) * 100;
      if (quarterPending) {
        current += quarterPending * 25;
        quarterPending = 0;
      }
      found = true;
      continue;
    }
    if (t === "হাজার") {
      let hz = (current || 1) * 1000;
      if (quarterPending) {
        hz += quarterPending * 250;
        quarterPending = 0;
      }
      total += hz;
      current = 0;
      found = true;
      continue;
    }
    if (t === "লাখ" || t === "লক্ষ") {
      let lk = (current || 1) * 100000;
      if (quarterPending) {
        lk += quarterPending * 25000;
        quarterPending = 0;
      }
      total += lk;
      current = 0;
      found = true;
      continue;
    }
    if (t === "কোটি") {
      let kt = (current || 1) * 10000000;
      if (quarterPending) {
        kt += quarterPending * 2500000;
        quarterPending = 0;
      }
      total += kt;
      current = 0;
      found = true;
      continue;
    }
    closeSegment(false);
  }
  closeSegment(false);
  if (!candidates.length) return null;
  let best = candidates[0] ?? 0;
  for (const c of candidates) if (c > best) best = c;
  return best;
}

const GIVE_3RD = ["দিয়েছে", "দিছে", "দিচ্ছে", "দিয়েছেন", "দিছেন", "দিচ্ছেন", "দিলো", "দিলেন", "দিল", "দিয়েছিল", "দিয়েছিলেন", "দিছিল", "দিছিলেন", "দিচ্ছিল", "দিচ্ছিলেন", "দিসে", "দেবে", "দিবে", "দেবেন", "দিবেন", "দেওয়া হয়েছে", "দেয়া হয়েছে"];
const SEND_3RD = ["পাঠিয়েছে", "পাঠাইছে", "পাঠিয়েছেন", "পাঠাইছেন", "পাঠিয়েছিল", "পাঠিয়েছিলেন", "পাঠাইছিল", "পাঠাইছিলেন", "পাঠাচ্ছিল", "পাঠাচ্ছিলেন", "পাঠালো", "পাঠালেন", "পাঠাইসে", "পাঠিয়ে দিয়েছে", "পাঠিয়ে দিছে", "পাঠানো হয়েছে", "পাঠানো হইছে"];
const GIVE_1ST = ["দিলাম", "দিয়েছি", "দিছি", "দিয়েছিলাম", "দিছিলাম", "দিচ্ছি", "দিচ্ছিলাম", "দিয়ে দিলাম", "দিয়ে দিয়েছি"];
const SEND_1ST = ["পাঠিয়েছি", "পাঠাইছি", "পাঠালাম", "পাঠিয়েছিলাম", "পাঠাইছিলাম", "পাঠাচ্ছি", "পাঠাচ্ছিলাম", "পাঠিয়ে দিলাম", "পাঠিয়ে দিয়েছি"];
const RECEIVE_WORDS = ["পাইছি", "পাইসি", "পেয়েছি", "পেলাম", "পাইলাম", "পাইছিলাম", "পেয়েছিলাম", "টাকা পাই", "টাকা পেয়ে", "পাওয়া গেছে", "পাওয়া গেল", "থেকে টাকা পাইছি", "থেকে টাকা পেয়েছি", "থেকে টাকা পেলাম", "থেকে টাকা পাইলাম", "কাছ থেকে পাইছি", "কাছ থেকে পেয়েছি", "কাছ থেকে পেলাম", "থেকে পাইছি", "থেকে পেয়েছি", "থেকে পেলাম"];
const ARRIVE_WORDS = ["জমা হয়েছে", "জমা হইছে", "জমা হলো", "জমা হয়ে গেছে", "টাকা ঢুকেছে", "টাকা ঢুকছে", "টাকা ঢুকে গেছে", "টাকা ঢুকলো", "টাকা ঢুকল", "টাকা এসেছে", "টাকা এসে গেছে", "টাকা এসে পড়েছে", "টাকা আসছে", "টাকা এলো", "টাকা আসলো", "পেমেন্ট এসেছে", "পেমেন্ট ঢুকেছে", "ক্রেডিট হয়েছে", "ক্রেডিট হইছে", "ট্রান্সফার হয়েছে", "একাউন্টে এসেছে", "অ্যাকাউন্টে এসেছে", "বিকাশে এসেছে", "বিকাশে ঢুকেছে", "বিকাশে পাঠিয়েছে", "বিকাশে পাঠাইছে"];
const EARN_WORDS = ["উপার্জন করেছি", "উপার্জন হয়েছে", "আয় করেছি", "আয় হয়েছে", "ইনকাম হয়েছে", "ইনকাম করেছি"];
const DEPOSIT_WORDS = ["জমা দিলাম", "জমা করলাম", "জমা দিয়েছি", "জমা দিছি", "জমা দিচ্ছি", "জমা করেছি", "জমা রাখলাম", "ডিপোজিট করলাম", "ডিপোজিট করেছি"];
const LOAN_IN_WORDS = ["ধার নিয়েছি", "ধার নিলাম", "ধার নিছি", "ধার নিয়েছিলাম", "ধার এনেছি", "ধার করে এনেছি", "লোন নিয়েছি", "লোন নিলাম", "লোন নিয়েছিলাম", "ঋণ নিয়েছি", "ঋণ নিলাম", "ঋণ নিয়েছিলাম"];
const TAKE_WORDS = ["টাকা নিছি", "টাকা নিয়েছি", "টাকা নিলাম", "টাকা নিছিলাম", "টাকা নিয়েছিলাম", "টাকা নিচ্ছি", "থেকে নিছি", "থেকে নিয়েছি", "থেকে নিলাম", "থেকে নিছিলাম", "কাছ থেকে নিছি", "কাছ থেকে নিয়েছি", "কাছ থেকে নিলাম", "থেকে টাকা নিছি", "থেকে টাকা নিয়েছি", "থেকে টাকা নিলাম", "থেকে টাকা নিছিলাম", "থেকে টাকা নিয়েছিলাম", "নিছি টাকা", "নিয়েছি টাকা"];
const SENDER_WORDS = ["আব্বু", "আব্বা", "আম্মু", "আম্মা", "বাবা", "মা ", "ভাইয়া", "আপু", "ভাই", "বোন", "বন্ধু", "বান্ধবী", "চাচা", "চাচি", "মামা", "মামি", "খালা", "খালু", "ফুফু", "ফুফা", "নানা", "নানি", "দাদা", "দাদি", "স্যার", "ম্যাডাম", "টিউশন", "ছাত্র", "ছাত্রী", "স্টুডেন্ট", "ক্লায়েন্ট", "অফিস", "কোম্পানি", "বস", "মালিক", "ভাবি", "দুলাভাই", "শ্বশুর", "শাশুড়ি", "আত্মীয়"];
const EXPENSE_STRONG = ["খরচ", "খরচা", "ব্যয়", "কিনলাম", "কিনেছি", "কিনছি", "কিনলো", "কিনে ফেললাম", "কিনে ফেলেছি", "কেনা হলো", "কেনাকাটা", "শপিং", "পেমেন্ট", "পরিশোধ করলাম", "পরিশোধ করেছি", "বিল দিলাম", "বিল দিয়েছি", "বিল দিছি"];
const SALARY_WORDS = ["বেতন", "স্যালারি", "মাইনে", "সম্মানী", "বোনাস", "ভাতা", "পেনশন", "বৃত্তি", "স্কলারশিপ"];
const ME_WORDS = ["আমাকে", "আমারে", "আমায়"];

function hasAnyWord(text: string, list: string[]): boolean {
  for (const w of list) if (text.indexOf(w) !== -1) return true;
  return false;
}
function hasTakeForm(text: string): boolean {
  if (
    text.indexOf("কিনে নিলাম") !== -1 ||
    text.indexOf("কিনে নিছি") !== -1 ||
    text.indexOf("কিনে নিয়েছি") !== -1 ||
    text.indexOf("কিনে নিলেন") !== -1
  )
    return false;
  const forms = ["নিয়েছি", "নিয়েছিলাম", "নিচ্ছি", "নিছি", "নিছিলাম"];
  for (const f of forms) if (text.indexOf(f) !== -1) return true;
  let p = text.indexOf("নিলাম");
  while (p !== -1) {
    if (text.charAt(p + 5) !== "ে") return true;
    p = text.indexOf("নিলাম", p + 1);
  }
  return false;
}
function bareDilPos(text: string): number {
  const m = String(text).match(/(^|[\s।,.!?;:"'()])দিল(?=$|[\s।,.!?;:"'()])/);
  return m ? (m.index ?? 0) + (m[1]?.length ?? 0) : -1;
}
function hasGive3rd(text: string): boolean {
  for (const w of GIVE_3RD) {
    if (w === "দিল") {
      if (bareDilPos(text) !== -1) return true;
    } else if (text.indexOf(w) !== -1) return true;
  }
  return false;
}
function hasFirstPersonForm(text: string, list: string[]): boolean {
  for (const w of list) {
    let p = text.indexOf(w);
    while (p !== -1) {
      if (text.charAt(p + w.length) !== "ল") return true;
      p = text.indexOf(w, p + 1);
    }
  }
  return false;
}
function meNearGiveVerb(text: string): boolean {
  const verbs = [...GIVE_3RD, ...SEND_3RD];
  for (const me of ME_WORDS) {
    let p = text.indexOf(me);
    while (p !== -1) {
      for (const v of verbs) {
        let pos = v === "দিল" ? bareDilPos(text) : text.indexOf(v);
        while (pos !== -1) {
          if (Math.abs(pos - p) <= 44) return true;
          pos = v === "দিল" ? -1 : text.indexOf(v, pos + 1);
        }
      }
      p = text.indexOf(me, p + 1);
    }
  }
  return false;
}
function detectType(text: string): EntryType {
  const t = String(text || "");
  if (
    hasAnyWord(t, ME_WORDS) &&
    (meNearGiveVerb(t) || hasAnyWord(t, RECEIVE_WORDS))
  )
    return "income";
  if (
    hasAnyWord(t, RECEIVE_WORDS) ||
    hasAnyWord(t, ARRIVE_WORDS) ||
    hasAnyWord(t, EARN_WORDS)
  )
    return "income";
  if (hasAnyWord(t, TAKE_WORDS)) return "income";
  if ((t.indexOf("থেকে") !== -1 || t.indexOf("টাকা") !== -1) && hasTakeForm(t))
    return "income";
  if (hasAnyWord(t, DEPOSIT_WORDS)) return "income";
  if (hasAnyWord(t, LOAN_IN_WORDS)) return "income";
  if (hasFirstPersonForm(t, GIVE_1ST) || hasFirstPersonForm(t, SEND_1ST))
    return "expense";
  if (hasAnyWord(t, SENDER_WORDS) && (hasGive3rd(t) || hasAnyWord(t, SEND_3RD)))
    return "income";
  if (hasGive3rd(t) || hasAnyWord(t, SEND_3RD)) return "income";
  if (hasAnyWord(t, EXPENSE_STRONG)) return "expense";
  if (hasAnyWord(t, SALARY_WORDS)) return "income";
  return "expense";
}

const CAT_RULES: [string, string[]][] = [
  ["বিল ও ভাড়া", ["বাসা ভাড়া", "বাসার ভাড়া", "বাড়ি ভাড়া", "বাড়ির ভাড়া", "ঘর ভাড়া", "ঘরের ভাড়া", "ফ্ল্যাট ভাড়া", "রুম ভাড়া", "সিট ভাড়া", "মেস ভাড়া", "মেসের ভাড়া", "মেসের খরচ", "মেসের বিল", "হোস্টেল ভাড়া", "হোস্টেলের", "দোকান ভাড়া", "অফিস ভাড়া", "গ্যারেজ ভাড়া", "বিদ্যুৎ বিল", "বিদ্যুতের বিল", "বিদ্যুৎ", "কারেন্ট বিল", "কারেন্টের বিল", "কারেন্টের টাকা", "কারেন্টের", "পানির বিল", "পানি বিল", "ওয়াসা", "গ্যাস বিল", "গ্যাসের বিল", "ডিশ বিল", "ডিশের বিল", "ডিশের", "কেবল বিল", "ইন্টারনেট", "ওয়াইফাই", "ব্রডব্যান্ড", "নেটের বিল", "নেট বিল", "রিচার্জ", "ফ্লেক্সিলোড", "মোবাইল বিল", "পোস্টপেইড", "সিমের", "সার্ভিস চার্জ", "ময়লার বিল", "ময়লা বিল", "গার্ডের", "দারোয়ানের", "কেয়ারটেকার", "লিফট বিল", "জেনারেটর", "হোল্ডিং ট্যাক্স", "খাজনা", "কিস্তি", "ইএমআই", "বিল দিলাম", "বিল দিয়েছি", "বিল দিছি", "বিল পরিশোধ", "বিলের টাকা", "মাসিক বিল", "ইউটিলিটি", "বিল"]],
  ["যাতায়াত", ["রিকশা", "রিক্সা", "সিএনজি", "বাস ভাড়া", "বাসের ভাড়া", "বাসের টিকিট", "বাসের টিকেট", "বাসে", "উবার", "পাঠাও", "ট্রেন", "ট্রেনের টিকিট", "ট্রেনের টিকেট", "মেট্রোরেল", "মেট্রো", "লঞ্চ", "লঞ্চের টিকিট", "স্টিমার", "ফেরি", "নৌকার ভাড়া", "বিমান", "বিমানের টিকিট", "ফ্লাইট", "এয়ার টিকিট", "পেট্রোল", "পেট্রল", "ডিজেল", "অকটেন", "জ্বালানি", "গাড়ির তেল", "গাড়ি ভাড়া", "গাড়ির ভাড়া", "মাইক্রো", "প্রাইভেট কার", "মোটরসাইকেলের", "বাইকের", "অটোরিকশা", "ইজিবাইক", "মিশুক", "লেগুনা", "টেম্পু", "টোল", "পার্কিং", "যাতায়াত", "যাওয়ার ভাড়া", "আসার ভাড়া", "যাওয়া-আসা", "আসা-যাওয়া", "ভাড়া", "ট্যাক্সি", "ক্যাব", "অটো"]],
  ["বাজার-সদাই", ["কাঁচাবাজার", "কাঁচা বাজার", "বাজার-সদাই", "বাজারের", "বাজার করা", "বাজার করছে", "বাজার করছি", "বাজার করেছে", "বাজার করেছি", "বাজার করলাম", "আজকের বাজার", "বাজার থেকে", "সদাই", "মুদি", "মুদি দোকান", "সুপার শপ", "সুপারশপ", "চাল", "আটা", "ময়দা", "সুজি", "ডাল", "মসুর", "মুগ", "ছোলা", "বুটের ডাল", "চিনি", "লবণ", "সবজি", "তরকারি", "শাক", "শাকসবজি", "আলু", "পেঁয়াজ", "রসুন", "আদা", "কাঁচামরিচ", "কাঁচা মরিচ", "শুকনা মরিচ", "হলুদ", "মরিচ", "জিরা", "ধনিয়া", "এলাচ", "দারুচিনি", "তেজপাতা", "মসলা", "গরম মসলা", "লাউ", "কুমড়া", "চালকুমড়া", "বেগুন", "ঢেঁড়স", "পটল", "ঝিঙা", "ঝিঙে", "করলা কিন", "করলার", "উচ্ছে", "শসা", "টমেটো", "গাজর", "ফুলকপি", "বাঁধাকপি", "পালং", "লালশাক", "পুঁইশাক", "কাঁচকলা", "লেবু", "ধনেপাতা", "পুদিনা", "নারিকেল", "নারকেল", "মাছ", "ইলিশ", "রুই", "কাতলা", "কাতল", "মৃগেল", "পাবদা", "টেংরা", "শিং", "মাগুর", "কই", "তেলাপিয়া", "পাঙ্গাস", "চিংড়ি", "শুঁটকি", "মাংস", "গরুর মাংস", "খাসির মাংস", "মুরগি", "মোরগ", "হাঁস", "কবুতর", "ডিম", "দুধ", "ঘি", "মাখন", "পনির", "সরিষার তেল", "সয়াবিন তেল", "রাইস ব্র্যান তেল", "তেল কিন", "তেলের", "বেসন", "সাবান", "কাপড় কাচার সাবান", "গুঁড়া সাবান", "ডিটারজেন্ট", "সার্ফ", "শ্যাম্পু", "টুথপেস্ট", "টিস্যু", "আম কিন"]],
  ["খাবার", ["খাবার", "খাবারের", "খাওয়া-দাওয়া", "খাওয়ার", "ভাত", "দুপুরের খাওয়া", "দুপুরের খাবার", "রাতের খাবার", "সকালের খাবার", "রাতের খাওয়া", "নাস্তা", "সকালের নাস্তা", "সন্ধ্যার নাস্তা", "হোটেল", "রেস্টুরেন্ট", "রেস্তোরাঁ", "ক্যাফে", "বেকারি", "টং দোকান", "চায়ের দোকান", "ভাতঘর", "বিরিয়ানি", "কাচ্চি", "তেহারি", "খিচুড়ি", "পোলাও", "মোরগ পোলাও", "বার্গার", "পিজ্জা", "পিৎজা", "স্যান্ডউইচ", "শর্মা", "গ্রিল", "কাবাব", "শিক কাবাব", "তন্দুরি", "নান", "রুমালি", "চা ", "চায়ের", "কফি", "জুস", "মিল্কশেক", "লাচ্ছি", "ফালুদা", "বোরহানি", "শরবত", "কোল্ড ড্রিংকস", "সফট ড্রিংকস", "কোক", "পেপসি", "স্প্রাইট", "এনার্জি ড্রিংক", "মিনারেল ওয়াটার", "পানি কিন", "বোতলের পানি", "মিষ্টি", "দই", "টক দই", "মিষ্টি দই", "রসমালাই", "রসগোল্লা", "জিলাপি", "জিলিপি", "চমচম", "সন্দেশ", "মিষ্টান্ন", "কেক", "পেস্ট্রি", "কুকিজ", "বিস্কুট", "পাউরুটি", "রুটি", "পরোটা", "লুচি", "পুরি", "সিঙ্গারা", "সমুচা", "ফুচকা", "চটপটি", "হালিম", "ঝালমুড়ি", "ঝাল মুড়ি", "মুড়ি", "চিড়া", "চিপস", "আইসক্রিম", "চকলেট", "ফল", "কলা", "আপেল", "কমলা", "মাল্টা", "আঙুর", "তরমুজ", "পেয়ারা", "লিচু", "কাঁঠাল", "ডালিম", "বেদানা", "খেজুর", "আম খে", "আমের", "পেঁপে", "আনারস", "বরই", "বাদাম", "কাজু", "কিসমিশ", "খেয়েছি", "খাওয়া", "খেলাম", "খাইছি", "ট্রিট", "খাওয়ালাম", "খাওয়ানো"]],
  ["স্বাস্থ্য", ["ডাক্তার", "ডাক্তারের", "ওষুধ", "ঔষধ", "মেডিসিন", "ট্যাবলেট", "ক্যাপসুল", "সিরাপ", "মলম", "ড্রপ", "ইনজেকশন", "স্যালাইন", "ব্যান্ডেজ", "হাসপাতাল", "চিকিৎসা", "ফার্মেসি", "দাঁতের", "দাঁত তোলা", "দাঁতের ডাক্তার", "ডেন্টিস্ট", "চোখের ডাক্তার", "চক্ষু", "ক্লিনিক", "ডায়াগনস্টিক", "প্যাথলজি", "ল্যাব", "মেডিকেল", "রক্ত পরীক্ষা", "রক্তের টেস্ট", "মেডিকেল টেস্ট", "পরীক্ষা-নিরীক্ষা", "এক্সরে", "এক্স-রে", "আল্ট্রাসনোগ্রাম", "আলট্রাসাউন্ড", "ইসিজি", "সিটি স্ক্যান", "এমআরআই", "এম আর আই", "থেরাপি", "ফিজিওথেরাপি", "ভ্যাকসিন", "টিকা", "ডায়াবেটিস", "প্রেসার", "ব্লাড প্রেসার", "সার্জারি", "অপারেশন", "অপারেশনের", "নার্সিং", "অ্যাম্বুলেন্স", "হোমিওপ্যাথি", "হোমিও", "কবিরাজ", "ভিটামিন", "সাপ্লিমেন্ট", "স্যানিটাইজার", "হ্যান্ড স্যানিটাইজার", "মাস্ক", "থার্মোমিটার", "ওজন মাপা"]],
  ["শিক্ষা", ["বই", "বইয়ের", "খাতা", "নোটখাতা", "ডায়েরি", "কলম", "পেন্সিল", "রাবার", "শার্পনার", "স্কেল", "জ্যামিতি", "ক্যালকুলেটর", "কোর্স", "কোর্সের", "অনলাইন কোর্স", "ভর্তি", "ভর্তির", "পরীক্ষার ফি", "পরীক্ষার", "ফরম ফিলাপ", "ফরম ফিলাপের", "রেজিস্ট্রেশন", "রেজিস্ট্রেশনের", "আবেদন ফি", "আবেদনের", "ভাইভা", "সার্টিফিকেট", "সনদ", "মার্কশিট", "ট্রান্সক্রিপ্ট", "সেমিস্টার", "সেমিস্টারের", "সেশন চার্জ", "ক্রেডিট ফি", "ল্যাব ফি", "ল্যাবের", "প্র্যাকটিক্যাল", "অ্যাসাইনমেন্ট", "অ্যাসাইনমেন্টের", "প্রিন্ট করা", "প্রিন্ট করালাম", "প্রিন্টের", "ফটোকপি", "বাঁধাই", "স্পাইরাল", "বিশ্ববিদ্যালয়", "বিশ্ববিদ্যালয়ের", "ভার্সিটি", "ভার্সিটির", "স্কুল ফি", "স্কুলের ফি", "স্কুলের", "কলেজ ফি", "কলেজের", "মাদ্রাসা", "মাদ্রাসার", "পড়াশোনা", "পড়াশোনার", "পড়ার", "টিউশন ফি", "টিউশনের ফি", "কোচিং", "কোচিংয়ের", "কোচিং ফি", "সেমিনার", "ওয়ার্কশপ", "কনফারেন্স", "লাইব্রেরি", "লাইব্রেরির", "বইমেলা", "স্টেশনারি", "কাগজ", "এফোর কাগজ", "খাতা-কলম"]],
  ["কেনাকাটা", ["জ্যাকেট", "জামা", "কাপড়", "কাপড়চোপড়", "পোশাক", "শার্ট", "টি-শার্ট", "টিশার্ট", "গেঞ্জি", "প্যান্ট", "জিন্স", "ট্রাউজার", "লুঙ্গি", "গামছা", "পাজামা", "পায়জামা", "পাঞ্জাবি", "কুর্তা", "শাড়ি", "থ্রি পিস", "থ্রি-পিস", "থ্রিপিস", "কামিজ", "সালোয়ার", "সালোয়ার-কামিজ", "ওড়না", "হিজাব", "বোরকা", "স্কার্ফ", "সোয়েটার", "হুডি", "কোট", "ব্লেজার", "টুপি", "মাফলার", "মোজা", "আন্ডারওয়্যার", "জুতা", "জুতো", "স্যান্ডেল", "স্যান্ডাল", "কেডস", "স্নিকার", "বুট", "হিল", "লোফার", "মোবাইল", "মোবাইল ফোন", "স্মার্টফোন", "ফোন কিন", "ফোনের", "হেডফোন", "ইয়ারফোন", "ইয়ারবাড", "ইয়ারবাডস", "এয়ারপড", "চার্জার", "চার্জিং", "কেবল", "ক্যাবল", "পাওয়ার ব্যাংক", "পাওয়ারব্যাংক", "মেমোরি কার্ড", "মেমরি কার্ড", "পেনড্রাইভ", "পেন ড্রাইভ", "হার্ডডিস্ক", "হার্ড ডিস্ক", "ল্যাপটপ", "কম্পিউটার", "মনিটর", "মাউস", "কীবোর্ড", "প্রিন্টার", "রাউটার", "মডেম", "টিভি", "টেলিভিশন", "ফ্রিজ", "রেফ্রিজারেটর", "ওয়াশিং মেশিন", "এসি", "এয়ার কন্ডিশনার", "ফ্যান", "সিলিং ফ্যান", "টেবিল ফ্যান", "লাইট", "বাল্ব", "টিউব লাইট", "এলইডি", "আয়রন", "ইস্ত্রি", "ব্লেন্ডার", "জুসার", "মিক্সার", "ওভেন", "মাইক্রোওভেন", "রাইস কুকার", "প্রেসার কুকার", "হাঁড়ি", "হাড়ি", "কড়াই", "তাওয়া", "প্লেট", "বাটি", "মগ", "জগ", "ফ্লাস্ক", "বালতি", "ঝাড়ু", "মপ", "আসবাব", "ফার্নিচার", "খাট", "আলমারি", "ওয়ারড্রোব", "ড্রেসিং টেবিল", "সোফা", "টেবিল", "চেয়ার", "র‍্যাক", "তোশক", "জাজিম", "বালিশ", "কম্বল", "কাঁথা", "চাদর", "বেডশিট", "পর্দা", "কার্পেট", "ঘড়ি", "হাতঘড়ি", "ওয়াল ঘড়ি", "দেয়াল ঘড়ি", "চশমা", "সানগ্লাস", "ফ্রেম", "ওয়ালেট", "মানিব্যাগ", "বেল্ট", "ব্যাগ", "স্কুল ব্যাগ", "ব্যাকপ্যাক", "লাগেজ", "ট্রলি", "ছাতা", "রেইনকোট", "খেলনা", "পুতুল", "বল কিন", "ক্রিকেট ব্যাট", "ব্যাডমিন্টন", "সাইকেল", "প্রসাধনী", "কসমেটিকস", "কসমেটিক", "মেকআপ", "লিপস্টিক", "নেইল পালিশ", "পারফিউম", "পারফিউমের", "আতর", "বডি স্প্রে", "ডিওডোরেন্ট", "ক্রিম", "ফেস ক্রিম", "লোশন", "ফেসওয়াশ", "ফেস ওয়াশ", "সানস্ক্রিন", "হেয়ার অয়েল", "চুলের তেল", "ট্রিমার", "রেজর", "শেভিং", "হেয়ার ড্রায়ার", "দারাজ", "অনলাইন শপিং", "অনলাইনে কিন", "কেনাকাটা", "শপিং", "শপিংয়ে"]],
  ["বিনোদন", ["সিনেমা", "সিনেমার টিকিট", "সিনেমার টিকেট", "মুভি", "মুভির টিকিট", "ওয়েব সিরিজ", "নাটক", "থিয়েটার", "খেলা দেখ", "খেলা দেখতে", "ম্যাচ দেখ", "ম্যাচের টিকিট", "ক্রিকেট ম্যাচ", "ফুটবল ম্যাচ", "স্টেডিয়াম", "গেম", "গেমস", "গেমিং", "পাবজি", "ফ্রি ফায়ার", "টপ আপ", "টপআপ", "ডায়মন্ড", "নেটফ্লিক্স", "ইউটিউব প্রিমিয়াম", "স্পটিফাই", "সাবস্ক্রিপশন", "ভ্রমণ", "ভ্রমণে", "ট্যুর", "ট্যুরে", "পিকনিক", "বেড়াতে", "বেড়ানো", "বেড়াতে গিয়ে", "ঘুরতে", "ঘোরাঘুরি", "ঘুরে", "পার্ক", "শিশু পার্ক", "চিড়িয়াখানা", "জাদুঘর", "মেলা", "মেলায়", "সার্কাস", "রিসোর্ট", "রিসোর্টে", "কক্সবাজার", "সাজেক", "বান্দরবান", "রাঙামাটি", "সেন্টমার্টিন", "কুয়াকাটা", "সুন্দরবন", "কনসার্ট", "কনসার্টের", "গানের অনুষ্ঠান", "পার্টি", "আড্ডা", "আড্ডায়", "বিনোদন", "বিনোদনের"]],
];
const INCOME_CAT_RULES: [string, string[]][] = [
  ["ফ্যামিলি থেকে প্রাপ্ত", ["আব্বু", "আব্বা", "বাবা", "বাবার", "আম্মু", "আম্মা", "মা ", "মায়ের", "আম্মুর", "আব্বুর", "ফ্যামিলি", "পরিবার", "পরিবারের", "ভাইয়া", "ভাইয়ার", "বড় ভাই", "ছোট ভাই", "বড় বোন", "ছোট বোন", "বড় আপু", "ছোট আপু", "আপু", "আপুর", "ভাই", "ভাইয়ের", "বোন ", "বোনের", "চাচা", "চাচার", "চাচি", "চাচী", "কাকা", "কাকি", "কাকী", "জেঠা", "জেঠি", "জেঠী", "মামা", "মামার", "মামি", "মামী", "খালা", "খালার", "খালু", "খালুর", "ফুফু", "ফুফুর", "ফুফা", "ফুফার", "নানা", "নানার", "নানি", "নানির", "দাদা", "দাদার", "দাদি", "দাদির", "দাদু", "নানু", "ঠাকুরদা", "ঠাকুমা", "পিসি", "পিসা", "মাসি", "মেসো", "ভাবি", "ভাবী", "ভাবির", "দুলাভাই", "দুলাভাইয়ের", "শ্বশুর", "শ্বশুরের", "শাশুড়ি", "শাশুড়ির", "শ্বশুরবাড়ি", "শ্বশুর বাড়ি", "স্ত্রী", "স্ত্রীর", "স্বামী", "স্বামীর", "ছেলে", "ছেলের", "মেয়ে", "মেয়ের", "জামাই", "জামাইয়ের", "কাজিন", "খালাতো", "মামাতো", "চাচাতো", "ফুফাতো", "আত্মীয়", "আত্মীয়ের", "প্রবাসী", "বাসা থেকে", "বাড়ি থেকে", "বাসার সবাই", "পরিজন"]],
  ["ক্রিপ্টো / P2P", ["ক্রিপ্টো", "ক্রিপ্টোকারেন্সি", "বাইনান্স", "বাইনাঞ্চ", "বিনান্স", "বাইনান্সে", "বাইবিট", "বিটকয়েন", "বিটিসি", "ইথেরিয়াম", "ইথার", "সোলানা", "ডজকয়েন", "টোকেন", "ইউএসডিটি", "usdt", "USDT", "p2p", "P2P", "পি২পি", "পিটুপি", "পি টু পি", "পিয়ার টু পিয়ার", "ট্রেডিং", "ট্রেডিংয়ে", "ট্রেড করে", "স্পটে", "ফিউচারসে", "কয়েন বিক্রি", "কয়েন বেচে", "কয়েন বেচলাম", "টোকেন বিক্রি", "ডলার বিক্রি করে", "ডলার বেচে", "ডলার সেল", "এক্সচেঞ্জ", "মাইনিং", "এয়ারড্রপ", "স্টেকিং", "রেমিট্যান্স"]],
  ["টিউশন", ["টিউশন", "টিউশনের", "টিউশনি", "পড়িয়ে", "পড়ানোর", "পড়াই", "পড়িয়ে দিই", "হোম টিউটর", "হোম টিউশন", "টিউটর", "গৃহশিক্ষক", "প্রাইভেট", "প্রাইভেটের", "কোচিং", "কোচিংয়ের", "কোচিং থেকে", "ব্যাচের", "ব্যাচ থেকে", "ছাত্রের", "ছাত্রীর", "ছাত্র থেকে", "ছাত্রী থেকে", "স্টুডেন্টের", "স্টুডেন্ট থেকে", "অভিভাবক"]],
  ["ফ্রিল্যান্স", ["ফ্রিল্যান্স", "ফ্রিল্যান্সিং", "ক্লায়েন্ট", "ক্লায়েন্টের", "ক্লায়েন্ট থেকে", "বায়ার", "বায়ারের", "প্রজেক্টের টাকা", "প্রজেক্টের", "প্রজেক্ট থেকে", "আপওয়ার্ক", "ফাইভার", "রিমোট জব", "রিমোট কাজ", "অনলাইন কাজ", "অনলাইনে কাজ", "অনলাইন ইনকাম", "ডিজাইনের", "লোগো ডিজাইন", "লোগোর", "ওয়েব ডিজাইন", "ওয়েবসাইট বানিয়ে", "ওয়েবসাইটের", "ভিডিও এডিটিং", "ভিডিও এডিট", "এডিটিংয়ের", "কনটেন্ট", "কনটেন্টের", "ডাটা এন্ট্রি", "ডেটা এন্ট্রি", "প্রোগ্রামিং", "প্রোগ্রামিংয়ের", "কোডিং", "কোডিংয়ের", "এসইও", "ডিজিটাল মার্কেটিং", "মার্কেটিংয়ের", "গ্রাফিক্স", "গ্রাফিক ডিজাইন"]],
  ["উপহার", ["উপহার", "উপহারের", "উপহার হিসেবে", "হাদিয়া", "সেলামি", "সালামি", "ঈদি", "ঈদের সেলামি", "গিফট", "গিফটের", "সারপ্রাইজ গিফট", "জন্মদিন", "জন্মদিনের", "জন্মদিনে", "বকশিশ", "বখশিশ", "ইনাম", "পুরস্কার", "পুরস্কারের", "প্রাইজ", "প্রাইজ মানি", "লটারি", "লটারির", "অনুদান", "নজরানা", "টাকা উপহার", "উপহার পেয়েছি", "উপহার পাইছি"]],
];
const BUY_WORDS = ["কিনলাম", "কিনেছি", "কিনছি", "কিনলো", "কিনলে", "কিনলেন", "কিনছেন", "কিনবে", "কিনব", "কিনতে", "কিনে ফেললাম", "কিনে ফেলেছি", "কিনে আনলাম", "কিনে আনছি", "কেনা হলো", "কেনা হয়েছে", "কেনাকাটা", "শপিং", "ক্রয়"];

// "বাজার" as its own word ("আজকের বাজার করছে", "বাজার করলাম", "বাজারে
// গেলাম") means grocery shopping. It must not fire when "বাজার" is only
// part of a longer word — "কক্সবাজার" is a trip (বিনোদন), not সদাই.
function hasStandaloneBazar(text: string): boolean {
  return /(^|[\s।,.!?;:"'()\-])বাজার/.test(text);
}

function detectCategory(text: string, type: EntryType): string {
  const rules = type === "income" ? INCOME_CAT_RULES : CAT_RULES;
  for (const [cat, words] of rules) {
    if (cat === "বাজার-সদাই" && hasStandaloneBazar(text)) return cat;
    for (const w of words) {
      if (text.indexOf(w) !== -1) return cat;
    }
  }
  if (type === "expense" && hasAnyWord(text, BUY_WORDS)) return "কেনাকাটা";
  return "অন্যান্য";
}

type VoiceParse = {
  raw: string;
  poisha: number | null;
  type: EntryType;
  category: string;
  desc: string;
  date: string;
};

function parseVoiceText(rawText: string): VoiceParse {
  const text = String(rawText || "").trim();
  const normalized = normalizeDigits(text);
  let poisha: number | null = null;
  const decMatch = normalized.match(/\d[\d,]*\.\d{1,2}/);
  if (decMatch && decMatch.index !== undefined) {
    const afterDecTok = normalized
      .slice(decMatch.index + decMatch[0].length)
      .replace(/^[\s,]+/, "")
      .split(/\s+/)[0];
    if (
      !["হাজার", "লাখ", "লক্ষ", "কোটি", "শত", "শতক", "শো", "শ"].includes(
        afterDecTok ?? "",
      )
    ) {
      poisha = parseAmountToPoisha(decMatch[0]);
    }
  }
  if (poisha == null) {
    const numText = normalized.replace(/(\d),(\d)/g, "$1$2");
    const tokens = numText
      .replace(/(\d)\.(\d)/g, "$1\u0001$2")
      .replace(/[।,.!?;:"'()]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => t.replace(/\u0001/g, "."));
    const wordVal = wordNumberFromTokens(tokens);
    if (wordVal != null) {
      poisha = Math.round(wordVal * 100);
      if (poisha <= 0 || poisha > 99999999999) poisha = null;
    }
  }
  if (poisha == null) {
    const m = normalized.match(/\d[\d,]*(\.\d{1,2})?/);
    if (m) poisha = parseAmountToPoisha(m[0]);
  }
  const type = detectType(text);
  const category = detectCategory(text, type);
  const descTokens = normalized
    .replace(/[।,.!?;:"'()]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => {
      if (/^\d/.test(t)) return false;
      if (
        t === "টাকা" || t === "টাকায়" || t === "খরচ" || t === "হয়েছে" ||
        t === "করেছি" || t === "হলো"
      )
        return false;
      if (
        t === "গতকাল" || t === "গতপরশু" || t === "গত" || t === "পরশু" ||
        t === "আজকে" || t === "আজ" || t === "আগামীকাল" || t === "আগামীপরশু" ||
        t === "আগামী"
      )
        return false;
      if (Object.prototype.hasOwnProperty.call(WORD_NUM, t)) return false;
      if (Object.prototype.hasOwnProperty.call(SPECIAL_NUM, t)) return false;
      if (
        t === "শত" || t === "শতক" || t === "শ" || t === "শো" || t === "হাজার" ||
        t === "লাখ" || t === "লক্ষ" || t === "কোটি" || t === "সাড়ে" ||
        t === "পৌনে" || t === "সোয়া" || t === "পয়সা"
      )
        return false;
      const sm = t.match(/^(.+?)(শো|শ)$/);
      if (
        sm &&
        (Object.prototype.hasOwnProperty.call(WORD_NUM, sm[1] ?? "") ||
          Object.prototype.hasOwnProperty.call(NUM_EXTRA_PREFIX, sm[1] ?? ""))
      ) {
        const sb =
          WORD_NUM[sm[1] ?? ""] ?? NUM_EXTRA_PREFIX[sm[1] ?? ""] ?? 0;
        if (sb >= 1 && sb <= (sm[2] === "শো" ? 99 : 9)) return false;
      }
      const mm = t.match(/^(.+?)(হাজার|লাখ|লক্ষ|কোটি)$/);
      if (
        mm &&
        (/^\d+$/.test(mm[1] ?? "") ||
          Object.prototype.hasOwnProperty.call(WORD_NUM, mm[1] ?? "") ||
          Object.prototype.hasOwnProperty.call(SPECIAL_NUM, mm[1] ?? "") ||
          Object.prototype.hasOwnProperty.call(NUM_EXTRA_PREFIX, mm[1] ?? ""))
      )
        return false;
      return true;
    });
  let desc = descTokens.join(" ").trim();
  if (!desc) desc = category;
  if (desc.length > 120) desc = desc.slice(0, 120);
  // Date words: গতকাল / পরশু / আগামীকাল shift the entry's day.
  let vdate = todayKey();
  const shiftDay = (delta: number) => {
    const d = new Date();
    d.setDate(d.getDate() + delta);
    vdate = dateStr(d);
  };
  if (text.indexOf("আগামী") !== -1 && text.indexOf("পরশু") !== -1) shiftDay(2);
  else if (text.indexOf("আগামীকাল") !== -1) shiftDay(1);
  else if (text.indexOf("গতকাল") !== -1) shiftDay(-1);
  else if (text.indexOf("পরশু") !== -1) shiftDay(-2);
  return { raw: text, poisha, type, category, desc, date: vdate };
}

const EXAMPLES = [
  "দুপুরের খাবারে ২৫০ টাকা খরচ করেছি",
  "রিকশা ভাড়া পঞ্চাশ টাকা খরচ হয়েছে",
  "বাজারে এক হাজার দুইশো টাকা খরচ হয়েছে",
  "মোবাইল রিচার্জে একশো টাকা খরচ হয়েছে",
  "আব্বু আমাকে টাকা দিছে ১০০০০ টাকা",
  "টিউশন থেকে তিন হাজার টাকা পেলাম",
  "ওমরের থেকে টাকা পাইছি এক হাজার টাকা",
  "আম্মু আমারে ২০০০ টাকা পাঠাইছে",
  "বাইনান্স P2P থেকে পাঁচ হাজার টাকা পাইছি",
  "আমি আব্বুকে ৫০০ টাকা দিয়েছি",
  "আব্বু আমাকে টাকা দিচ্ছে ৫০০০ টাকা",
];
const EX_USE_KEY = "khorochpotro_example_use";
function loadExUse(): Record<string, number> {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(EX_USE_KEY) || "{}",
    ) as Record<string, number>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/* ---------------------------------- CSV ---------------------------------- */

function csvEscape(v: string): string {
  return `"${String(v ?? "").replace(/"/g, '""')}"`;
}
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] ?? "";
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

type ImportedEntry = {
  date: string;
  type: EntryType;
  category: string;
  description: string;
  amountPoisha: number;
};

/** Parses the খরচপত্র CSV export format:
    তারিখ,ধরন,ক্যাটাগরি,বিবরণ,টাকার পরিমাণ — ধরন is জমা or খরচ. */
function parseKhorochpotroCsv(text: string): ImportedEntry[] {
  const clean = text.replace(/^﻿/, "");
  const lines = clean.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const out: ImportedEntry[] = [];
  for (const line of lines) {
    const cols = parseCsvLine(line);
    if (cols.length < 5) continue;
    const [date = "", kind = "", category = "", description = "", amountRaw = ""] =
      cols;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date.trim())) continue;
    const type: EntryType | null =
      kind.trim() === "জমা" ? "income" : kind.trim() === "খরচ" ? "expense" : null;
    if (!type) continue;
    const amount = Number(amountRaw.replace(/[,،\s]/g, ""));
    if (!Number.isFinite(amount) || amount <= 0) continue;
    out.push({
      date: date.trim(),
      type,
      category: category.trim() || "অন্যান্য",
      description: description.trim(),
      amountPoisha: Math.round(amount * 100),
    });
  }
  return out;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 400);
}
function downloadTextFile(filename: string, text: string) {
  downloadBlob(
    new Blob(["﻿" + text], { type: "text/csv;charset=utf-8" }),
    filename,
  );
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/* ------------------------- Monthly PDF report ---------------------------- */
/* Ported from the original app: the report is drawn on a high-res
   canvas and the pages are embedded as JPEGs in a hand-built PDF —
   a real .pdf file downloads, no print window involved. */

function canvasToJpegBytes(canvas: HTMLCanvasElement): Uint8Array {
  const b64 = canvas.toDataURL("image/jpeg", 0.95).split(",")[1] ?? "";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

type PdfPage = { bytes: Uint8Array; w: number; h: number };

function buildPdfBlob(pages: PdfPage[]): Blob {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let total = 0;
  function push(data: string | Uint8Array) {
    const u = typeof data === "string" ? enc.encode(data) : data;
    parts.push(u);
    total += u.length;
  }
  const n = pages.length;
  const objCount = 2 + 3 * n;
  push("%PDF-1.4\n");
  offsets[1] = total;
  push(
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`,
  );
  const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(" ");
  offsets[2] = total;
  push(
    `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${n} >>\nendobj\n`,
  );
  pages.forEach((page, i) => {
    const pageObj = 3 + i * 3;
    const contentObj = pageObj + 1;
    const imageObj = pageObj + 2;
    const pw = 595;
    const ph = 842;
    offsets[pageObj] = total;
    push(
      `${pageObj} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 ${imageObj} 0 R >> >> /Contents ${contentObj} 0 R >>\nendobj\n`,
    );
    const stream = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
    offsets[contentObj] = total;
    push(
      `${contentObj} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
    );
    offsets[imageObj] = total;
    push(
      `${imageObj} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${page.w} /Height ${page.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.bytes.length} >>\nstream\n`,
    );
    push(page.bytes);
    push("\nendstream\nendobj\n");
  });
  const xrefPos = total;
  let xref = `xref\n0 ${objCount + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objCount; i++) {
    xref += `${String(offsets[i] ?? 0).padStart(10, "0")} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${objCount + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  push(xref);
  return new Blob(parts as BlobPart[], { type: "application/pdf" });
}

function fitCanvasText(
  ctx: CanvasRenderingContext2D,
  s: string,
  maxW: number,
): string {
  const str = String(s);
  if (ctx.measureText(str).width <= maxW) return str;
  let out = str;
  while (out.length > 1 && ctx.measureText(out + "…").width > maxW) {
    out = out.slice(0, -1);
  }
  return out + "…";
}

function generateMonthlyPdf(
  allEntries: Entry[],
  ym: string,
  budgetPoisha: number,
): void {
  const list = allEntries
    .filter((e) => monthOf(e.date) === ym)
    .slice()
    .sort((a, b) =>
      a.date === b.date ? a.id - b.id : a.date < b.date ? -1 : 1,
    );
  const inc = sumEntries(list, "income");
  const exp = sumEntries(list, "expense");
  const days = elapsedDaysInMonth(ym);
  const avg = days > 0 ? Math.round(exp / days) : 0;
  const W = 1240;
  const H = 1754;
  const S = 2;
  const FONT = '"Hind Siliguri","Noto Sans Bengali",sans-serif';
  const X = { date: 60, cat: 250, desc: 480, incR: 1000, expR: 1180 };
  const pages: PdfPage[] = [];
  let y = 0;

  function tableHeader(c: CanvasRenderingContext2D) {
    c.fillStyle = "#0b6e4f";
    c.fillRect(50, y - 34, W - 100, 48);
    c.fillStyle = "#ffffff";
    c.font = `600 25px ${FONT}`;
    c.textAlign = "left";
    c.fillText("তারিখ", X.date, y);
    c.fillText("ক্যাটাগরি", X.cat, y);
    c.fillText("বিবরণ", X.desc, y);
    c.textAlign = "right";
    c.fillText("জমা", X.incR, y);
    c.fillText("খরচ", X.expR, y);
    c.textAlign = "left";
    y += 44;
  }
  function newPage(first: boolean): {
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
  } | null {
    const cv = document.createElement("canvas");
    cv.width = W * S;
    cv.height = H * S;
    const c = cv.getContext("2d");
    if (!c) return null;
    c.scale(S, S);
    c.fillStyle = "#ffffff";
    c.fillRect(0, 0, W, H);
    c.fillStyle = "#14201b";
    y = 96;
    if (first) {
      c.font = `700 46px ${FONT}`;
      c.fillText("খরচপত্র — মাসিক খরচের প্রতিবেদন", 60, y);
      y += 52;
      c.font = `400 27px ${FONT}`;
      c.fillStyle = "#43554d";
      c.fillText(`${monthLabel(ym)} · তৈরি: ${toBnDigits(todayKey())}`, 60, y);
      y += 58;
      c.fillStyle = "#14201b";
      c.font = `600 28px ${FONT}`;
      const summary = [
        `মোট জমা: ${fmtMoney(inc)}`,
        `মোট খরচ: ${fmtMoney(exp)}`,
        `মাসের ব্যালান্স: ${fmtMoney(inc - exp)}`,
        `গড় দৈনিক খরচ: ${fmtMoney(avg)}`,
        `মোট এন্ট্রি: ${bnInt(list.length)}টি`,
      ];
      if (budgetPoisha > 0) summary.push(`বাজেট: ${fmtMoney(budgetPoisha)}`);
      for (const line of summary) {
        c.fillText(line, 60, y);
        y += 42;
      }
      y += 26;
    }
    tableHeader(c);
    return { canvas: cv, ctx: c };
  }

  const first = newPage(true);
  if (!first) return;
  let canvas = first.canvas;
  let ctx = first.ctx;
  ctx.font = `400 25px ${FONT}`;
  if (list.length === 0) {
    ctx.fillStyle = "#43554d";
    ctx.fillText("এই মাসে কোনো এন্ট্রি নেই।", X.date, y + 10);
    y += 50;
  }
  for (const e of list) {
    if (y > H - 130) {
      pages.push({ bytes: canvasToJpegBytes(canvas), w: W * S, h: H * S });
      const np = newPage(false);
      if (!np) return;
      canvas = np.canvas;
      ctx = np.ctx;
      ctx.font = `400 25px ${FONT}`;
    }
    ctx.fillStyle = "#14201b";
    ctx.fillText(toBnDigits(e.date), X.date, y);
    ctx.fillText(fitCanvasText(ctx, e.category, 210), X.cat, y);
    ctx.fillText(fitCanvasText(ctx, e.description, 300), X.desc, y);
    ctx.textAlign = "right";
    if (e.type === "income") ctx.fillText(fmtMoney(e.amountPoisha), X.incR, y);
    if (e.type === "expense") ctx.fillText(fmtMoney(e.amountPoisha), X.expR, y);
    ctx.textAlign = "left";
    ctx.strokeStyle = "#dbe4e0";
    ctx.beginPath();
    ctx.moveTo(50, y + 14);
    ctx.lineTo(W - 50, y + 14);
    ctx.stroke();
    y += 50;
  }
  if (y > H - 170) {
    pages.push({ bytes: canvasToJpegBytes(canvas), w: W * S, h: H * S });
    const np = newPage(false);
    if (!np) return;
    canvas = np.canvas;
    ctx = np.ctx;
  }
  y += 16;
  ctx.fillStyle = "#eef3f1";
  ctx.fillRect(50, y - 34, W - 100, 48);
  ctx.fillStyle = "#14201b";
  ctx.font = `700 26px ${FONT}`;
  ctx.fillText("মোট", X.date, y);
  ctx.textAlign = "right";
  ctx.fillText(fmtMoney(inc), X.incR, y);
  ctx.fillText(fmtMoney(exp), X.expR, y);
  ctx.textAlign = "left";
  y += 62;
  ctx.font = `600 27px ${FONT}`;
  ctx.fillText(`মাসের ব্যালান্স (জমা − খরচ): ${fmtMoney(inc - exp)}`, 60, y);
  pages.push({ bytes: canvasToJpegBytes(canvas), w: W * S, h: H * S });
  downloadBlob(buildPdfBlob(pages), `khorochpotro-report-${ym}.pdf`);
}

/* ----------------- GitHub encrypted backup (device-side) ----------------- */

const GH_SETTINGS_KEY = "khorochpotro-mu-github";

type GhSettings = { repo: string; token: string; passphrase: string };

function loadGhSettings(): GhSettings {
  try {
    const raw = localStorage.getItem(GH_SETTINGS_KEY);
    if (!raw) return { repo: "", token: "", passphrase: "" };
    const parsed = JSON.parse(raw) as Partial<GhSettings>;
    return {
      repo: typeof parsed.repo === "string" ? parsed.repo : "",
      token: typeof parsed.token === "string" ? parsed.token : "",
      passphrase: typeof parsed.passphrase === "string" ? parsed.passphrase : "",
    };
  } catch {
    return { repo: "", token: "", passphrase: "" };
  }
}
function ghConfigured(s: GhSettings): boolean {
  return s.repo.trim() !== "" && s.token.trim() !== "" && s.passphrase !== "";
}
function bytesToB64(bytes: Uint8Array): string {
  return bytesToBase64(bytes);
}
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function utf8ToB64(text: string): string {
  return bytesToB64(new TextEncoder().encode(text));
}
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
async function deriveBackupKey(
  passphrase: string,
  salt: Uint8Array,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 150000, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    usages,
  );
}
async function encryptBackupText(
  passphrase: string,
  plain: string,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveBackupKey(passphrase, salt, ["encrypt"]);
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plain),
  );
  return JSON.stringify({
    app: "khorochpotro-mu-backup",
    v: 1,
    salt: bytesToB64(salt),
    iv: bytesToB64(iv),
    data: bytesToB64(new Uint8Array(cipher)),
  });
}
async function decryptBackupText(
  passphrase: string,
  envelopeText: string,
): Promise<string> {
  const env = JSON.parse(envelopeText) as {
    salt?: string;
    iv?: string;
    data?: string;
  };
  if (!env.salt || !env.iv || !env.data) {
    throw new Error("ব্যাকআপ ফাইলের গঠন ঠিক নেই");
  }
  const key = await deriveBackupKey(passphrase, b64ToBytes(env.salt), [
    "decrypt",
  ]);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64ToBytes(env.iv) },
    key,
    b64ToBytes(env.data),
  );
  return new TextDecoder().decode(plain);
}

/* --------------------- Web Speech API (minimal types) -------------------- */

interface SpeechRecognitionResultLike {
  0: { transcript: string };
  isFinal: boolean;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: { length: number; [index: number]: SpeechRecognitionResultLike };
}
interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;
function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/* --------------------------------- Icons --------------------------------- */

function Icon({ d, size = 21 }: { d: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {d}
    </svg>
  );
}
function MicIcon({ size = 24 }: { size?: number }) {
  return (
    <Icon
      size={size}
      d={
        <>
          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" y1="19" x2="12" y2="22" />
        </>
      }
    />
  );
}
const ICON_UP = (
  <>
    <line x1="7" y1="17" x2="17" y2="7" />
    <polyline points="8 7 17 7 17 16" />
  </>
);
const ICON_DOWN = (
  <>
    <line x1="7" y1="7" x2="17" y2="17" />
    <polyline points="17 8 17 17 8 17" />
  </>
);
const ICON_EDIT = (
  <>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </>
);
const ICON_TRASH = (
  <>
    <path d="M3 6h18" />
    <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
  </>
);
const ICON_DOWNLOAD = (
  <>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </>
);
const ICON_UPLOAD = (
  <>
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="17 8 12 3 7 8" />
    <line x1="12" y1="3" x2="12" y2="15" />
  </>
);

/* --------------------------- Custom dropdown ----------------------------- */
/* The original app's themed dropdown: a pill button that opens the
   app's own panel (never the browser's native grey popup), closing on
   outside tap, Escape, page scroll, or resize. */

function Dropdown({
  value,
  options,
  onChange,
  ariaLabel,
  id,
  wrapClassName,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  ariaLabel: string;
  id?: string;
  wrapClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(false);
  const [style, setStyle] = useState<{
    left: number;
    top: number;
    width: number;
  } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<number | null>(null);

  const selected = options.find((o) => o.value === value);

  function close() {
    setShown(false);
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setOpen(false), 180);
  }
  function openPanel() {
    const btn = btnRef.current;
    if (!btn) return;
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    const r = btn.getBoundingClientRect();
    const h = Math.min(options.length * 50 + 12, 264);
    const below = window.innerHeight - r.bottom;
    const top =
      below < h + 12 && r.top > h + 12
        ? Math.max(8, r.top - h - 6)
        : r.bottom + 6;
    setStyle({ left: Math.max(8, r.left), top, width: r.width });
    setOpen(true);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setShown(true));
      const panel = panelRef.current;
      const sel = panel?.querySelector(".dd-item.sel");
      if (panel && sel instanceof HTMLElement) {
        panel.scrollTop = Math.max(
          0,
          sel.offsetTop - panel.clientHeight / 2 + sel.offsetHeight / 2,
        );
      }
    });
  }

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const t = e.target as Node;
      if (!btnRef.current?.contains(t) && !panelRef.current?.contains(t)) {
        close();
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    function onScroll(e: Event) {
      if (e.target !== panelRef.current) close();
    }
    document.addEventListener("click", onDocClick, true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("click", onDocClick, true);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", onScroll, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open ]);

  return (
    <div className={wrapClassName ? `dd-wrap ${wrapClassName}` : "dd-wrap"}>
      <button
        ref={btnRef}
        id={id}
        type="button"
        className="dd-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => (open ? close() : openPanel())}
      >
        <span className="dd-label">{selected?.label ?? ""}</span>
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && style && (
        <div
          ref={panelRef}
          className={`dd-panel${shown ? " open" : ""}`}
          role="listbox"
          aria-label={ariaLabel}
          style={{ left: style.left, top: style.top, width: style.width }}
        >
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              className={`dd-item${o.value === value ? " sel" : ""}`}
              onClick={() => {
                close();
                if (o.value !== value) onChange(o.value);
                btnRef.current?.focus();
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------- Auth gate ------------------------------- */

export function App() {
  const [token, setToken] = useState<string>(
    () => localStorage.getItem(TOKEN_KEY) ?? "",
  );

  const me = useQuery({
    queryKey: ["me", token],
    queryFn: () => withTimeout(api.me({ token })),
    enabled: token !== "",
  });

  useEffect(() => {
    if (token && me.data && me.data.user === null) {
      localStorage.removeItem(TOKEN_KEY);
      setToken("");
    }
  }, [token, me.data]);

  function handleAuthed(newToken: string) {
    localStorage.setItem(TOKEN_KEY, newToken);
    setToken(newToken);
  }

  async function handleLogout() {
    try {
      // Short deadline: dropping the local session must never wait on a
      // stalled connection.
      await withTimeout(api.logout({ token }), 5_000);
    } catch {
      // Local logout still proceeds; the token is dropped either way.
    }
    localStorage.removeItem(TOKEN_KEY);
    setToken("");
  }

  if (token === "") {
    return <AuthScreen onAuthed={handleAuthed} />;
  }
  if (me.isError) {
    return (
      <div className="wrap">
        <p style={{ textAlign: "center", color: "var(--ink-2)", paddingTop: 60 }}>
          সার্ভারে পৌঁছানো যাচ্ছে না — নেট সংযোগটা চেক করুন।
        </p>
        <div
          style={{
            display: "flex",
            gap: 10,
            justifyContent: "center",
            marginTop: 16,
            flexWrap: "wrap",
          }}
        >
          <button type="button" className="btn btn-primary" onClick={() => void me.refetch()}>
            আবার চেষ্টা করুন
          </button>
          <button type="button" className="btn" onClick={() => void handleLogout()}>
            লগইন পেজে যান
          </button>
        </div>
      </div>
    );
  }
  if (me.isPending || !me.data) {
    return (
      <div className="wrap">
        <p style={{ textAlign: "center", color: "var(--ink-2)", paddingTop: 60 }}>
          লোড হচ্ছে…
        </p>
      </div>
    );
  }
  if (me.data.user === null) {
    return <AuthScreen onAuthed={handleAuthed} />;
  }
  return (
    <Ledger
      token={token}
      userName={me.data.user.name}
      userEmail={me.data.user.email}
      onLogout={handleLogout}
    />
  );
}

/* ------------------------------ Auth screen ------------------------------ */

function AuthScreen({ onAuthed }: { onAuthed: (token: string) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");

  const authMutation = useMutation({
    mutationFn: async () =>
      withTimeout(
        mode === "register"
          ? api.register({ email, password, name })
          : api.login({ email, password }),
      ),
    onSuccess: (res) => {
      if (res.ok) onAuthed(res.token);
      else setError(res.error || "কিছু একটা ভুল হয়েছে, আবার চেষ্টা করুন");
    },
    onError: (err) =>
      setError(
        err instanceof RequestTimeoutError
          ? "সার্ভার সাড়া দিতে অনেক দেরি হচ্ছে — নেট সংযোগটা চেক করে আবার চেষ্টা করুন"
          : "সার্ভারে পৌঁছানো যাচ্ছে না, আবার চেষ্টা করুন",
      ),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    authMutation.mutate();
  }

  return (
    <div className="auth-wrap pt-safe">
      <header className="auth-head">
        <h1>খরচপত্র</h1>
        <p>প্রতিদিনের আয়-খরচের হিসাব, নিজের অ্যাকাউন্টে</p>
      </header>

      <div
        className={`seg${mode === "register" ? " income" : ""}`}
        role="tablist"
        aria-label="লগইন বা নতুন অ্যাকাউন্ট"
        style={{ marginBottom: 16 }}
      >
        <span className="seg-thumb" aria-hidden="true" />
        <button
          type="button"
          role="tab"
          data-type="expense"
          aria-pressed={mode === "login"}
          onClick={() => {
            setMode("login");
            setError("");
          }}
        >
          লগইন
        </button>
        <button
          type="button"
          role="tab"
          data-type="income"
          aria-pressed={mode === "register"}
          onClick={() => {
            setMode("register");
            setError("");
          }}
        >
          নতুন অ্যাকাউন্ট
        </button>
      </div>

      <form onSubmit={submit} className="card auth-card">
        {error && (
          <p role="alert" className="auth-err">
            {error}
          </p>
        )}
        {mode === "register" && (
          <div className="field">
            <label htmlFor="auth-name">আপনার নাম</label>
            <input
              id="auth-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="নাম লিখুন"
              autoComplete="name"
            />
          </div>
        )}
        <div className="field">
          <label htmlFor="auth-email">ইমেইল</label>
          <input
            id="auth-email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
            dir="ltr"
          />
        </div>
        <div className="field">
          <label htmlFor="auth-password">পাসওয়ার্ড</label>
          <div className="pw-wrap">
            <input
              id="auth-password"
              type={showPassword ? "text" : "password"}
              required
              minLength={mode === "register" ? 6 : 1}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={
                mode === "register" ? "কমপক্ষে ৬ অক্ষর" : "পাসওয়ার্ড দিন"
              }
              autoComplete={
                mode === "register" ? "new-password" : "current-password"
              }
              dir="ltr"
            />
            <button
              type="button"
              className="pw-toggle"
              onClick={() => setShowPassword((v) => !v)}
              aria-pressed={showPassword}
            >
              {showPassword ? "লুকান" : "দেখুন"}
            </button>
          </div>
        </div>
        <div className="form-actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={authMutation.isPending}
          >
            {authMutation.isPending
              ? "অপেক্ষা করুন…"
              : mode === "register"
                ? "অ্যাকাউন্ট খুলুন"
                : "লগইন করুন"}
          </button>
        </div>
      </form>

      <p className="auth-note">
        প্রত্যেকের হিসাব সম্পূর্ণ আলাদা — আপনার এন্ট্রি শুধু আপনিই দেখতে
        পারবেন।
      </p>
      <p className="auth-note">
        একবার লগইন করলেই এই ডিভাইসে লগইন সেভ থাকবে — নিজে লগআউট না করা
        পর্যন্ত বারবার লগইন করতে হবে না।
      </p>
    </div>
  );
}

/* -------------------------------- Ledger -------------------------------- */

type PeriodKind = "today" | "week" | "month";
type PieSel = { type: EntryType | null; cat: string | null };
type PieSeg = {
  type: EntryType;
  cat: string | null;
  label: string;
  val: number;
  start: number;
  end: number;
  color: string;
};
type VoiceDraft = {
  raw: string;
  poisha: number;
  type: EntryType;
  category: string;
  desc: string;
  date: string;
};
type VoiceBox =
  | { kind: "preview"; draft: VoiceDraft }
  | { kind: "edit"; draft: VoiceDraft }
  | { kind: "warn"; raw: string; filledForm: boolean }
  | { kind: "done"; draft: VoiceDraft }
  | { kind: "error"; message: string }
  | null;

function Ledger({
  token,
  userName,
  userEmail,
  onLogout,
}: {
  token: string;
  userName: string;
  userEmail: string;
  onLogout: () => void;
}) {
  const queryClient = useQueryClient();
  const [month, setMonth] = useState<string>(currentMonth());

  const allQuery = useQuery({
    queryKey: ["all", token],
    queryFn: () => api.listAllEntries({ token }),
  });
  const data = allQuery.data;

  useEffect(() => {
    if (data && !data.ok) onLogout();
  }, [data, onLogout]);

  const entriesAsc = useMemo<Entry[]>(
    () => (data?.ok ? data.entries : []),
    [data],
  );
  const entriesDesc = useMemo(
    () =>
      [...entriesAsc].sort((a, b) =>
        a.date === b.date ? b.id - a.id : a.date < b.date ? 1 : -1,
      ),
    [entriesAsc],
  );
  const budgetMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const b of data?.budgets ?? []) m.set(b.month, b.monthlyPoisha);
    return m;
  }, [data]);
  const legacyBudget = data?.budgetPoisha ?? 0;
  const budgetFor = (m: string): number => budgetMap.get(m) ?? legacyBudget;

  const monthOptions = useMemo(() => {
    let start = shiftMonth(currentMonth(), -35);
    for (const e of entriesAsc) {
      const m = monthOf(e.date);
      if (m < start) start = m;
    }
    for (const b of data?.budgets ?? []) if (b.month < start) start = b.month;
    if (month < start) start = month;
    const opts: { value: string; label: string }[] = [];
    let ym = currentMonth();
    while (ym >= start) {
      opts.push({ value: ym, label: monthLabel(ym) });
      ym = shiftMonth(ym, -1);
    }
    return opts;
  }, [entriesAsc, data, month]);

  function invalidateAll() {
    void queryClient.invalidateQueries({ queryKey: ["all", token] });
  }

  /* ------------------------------- Toast -------------------------------- */
  const [toast, setToast] = useState<{
    id: number;
    msg: string;
    actionLabel?: string;
    onAction?: () => void;
  } | null>(null);
  const [toastShown, setToastShown] = useState(false);
  const toastTimer = useRef<number | null>(null);
  function showToast(msg: string, actionLabel?: string, onAction?: () => void) {
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    const id = Date.now() + Math.random();
    setToast({ id, msg, actionLabel, onAction });
    requestAnimationFrame(() =>
      requestAnimationFrame(() => setToastShown(true)),
    );
    toastTimer.current = window.setTimeout(
      () => {
        setToastShown(false);
        window.setTimeout(
          () => setToast((t) => (t && t.id === id ? null : t)),
          260,
        );
      },
      actionLabel ? 6000 : 3500,
    );
  }

  /* --------------------------- GitHub backup ---------------------------- */
  const [ghSaved, setGhSaved] = useState<GhSettings>(() => loadGhSettings());
  const [ghRepo, setGhRepo] = useState(() => loadGhSettings().repo);
  const [ghTokenIn, setGhTokenIn] = useState(() => loadGhSettings().token);
  const [ghPassIn, setGhPassIn] = useState(() => loadGhSettings().passphrase);
  const [ghBusy, setGhBusy] = useState<"backup" | "restore" | null>(null);
  const [ghStatus, setGhStatus] = useState("");
  const [srcBusy, setSrcBusy] = useState(false);
  const [srcStatus, setSrcStatus] = useState("");
  const ghSavedRef = useRef(ghSaved);
  ghSavedRef.current = ghSaved;
  const backupTimer = useRef<number | null>(null);

  function persistGh(s: GhSettings) {
    localStorage.setItem(GH_SETTINGS_KEY, JSON.stringify(s));
    setGhSaved(s);
    ghSavedRef.current = s;
  }
  async function ghBackupPath(): Promise<string> {
    const hash = await sha256Hex(userEmail.trim().toLowerCase());
    return `backup/khorochpotro-${hash.slice(0, 16)}.json`;
  }
  function ghHeaders(s: GhSettings): Record<string, string> {
    return {
      Authorization: `Bearer ${s.token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    };
  }
  function ghErrorFor(status: number): string {
    if (status === 401 || status === 403)
      return "GitHub টোকেন ঠিক নেই বা এই রিপোতে লেখার অনুমতি নেই";
    if (status === 404) return "রিপোটি পাওয়া যায়নি — রিপোর নাম ঠিক আছে তো?";
    if (status === 409)
      return "GitHub-এ কনফ্লিক্ট হয়েছে — একটু পরে আবার চেষ্টা করুন";
    return `GitHub থেকে সাড়া মেলেনি (এরর ${status})`;
  }
  async function uploadGithubBackup(s: GhSettings): Promise<void> {
    const res = await api.listAllEntries({ token });
    if (!res.ok) throw new Error(res.error || "এন্ট্রি পড়া যায়নি");
    const payload = JSON.stringify({
      app: "khorochpotro-mu",
      version: 2,
      email: userEmail,
      exportedAt: new Date().toISOString(),
      budgetPoisha: res.budgetPoisha,
      budgets: res.budgets,
      entries: res.entries.map((e) => ({
        date: e.date,
        type: e.type,
        category: e.category,
        description: e.description,
        amountPoisha: e.amountPoisha,
      })),
    });
    const encrypted = await encryptBackupText(s.passphrase, payload);
    const path = await ghBackupPath();
    const url = `https://api.github.com/repos/${s.repo}/contents/${path}`;
    let sha: string | undefined;
    const head = await fetch(url, { headers: ghHeaders(s) });
    if (head.ok) {
      const j = (await head.json()) as { sha?: string };
      sha = j.sha;
    } else if (head.status !== 404) {
      throw new Error(ghErrorFor(head.status));
    }
    const put = await fetch(url, {
      method: "PUT",
      headers: ghHeaders(s),
      body: JSON.stringify({
        message: "খরচপত্র এনক্রিপ্টেড ব্যাকআপ",
        content: utf8ToB64(encrypted),
        ...(sha ? { sha } : {}),
      }),
    });
    if (!put.ok) throw new Error(ghErrorFor(put.status));
  }
  function scheduleAutoBackup() {
    if (!ghConfigured(ghSavedRef.current)) return;
    if (backupTimer.current !== null) {
      window.clearTimeout(backupTimer.current);
    }
    backupTimer.current = window.setTimeout(() => {
      backupTimer.current = null;
      const s = ghSavedRef.current;
      if (!ghConfigured(s)) return;
      void uploadGithubBackup(s)
        .then(() =>
          setGhStatus("অটো-ব্যাকআপ হয়েছে — GitHub-এ এনক্রিপ্টেড কপি হালনাগাদ"),
        )
        .catch(() =>
          setGhStatus("অটো-ব্যাকআপ হয়নি — GitHub সেটআপ আবার দেখুন"),
        );
    }, 2500);
  }
  useEffect(() => {
    return () => {
      if (backupTimer.current !== null) {
        window.clearTimeout(backupTimer.current);
      }
    };
  }, []);

  function handleChanged() {
    invalidateAll();
    scheduleAutoBackup();
  }

  function currentGhSettings(): GhSettings {
    return { repo: ghRepo.trim(), token: ghTokenIn.trim(), passphrase: ghPassIn };
  }
  function ghSettingsError(s: GhSettings): string | null {
    if (!ghConfigured(s)) return "রিপো, টোকেন আর পাসফ্রেজ — তিনটিই লাগবে";
    if (!/^[^/\s]+\/[^/\s]+$/.test(s.repo))
      return "রিপো “মালিক/রিপোর-নাম” আকারে লিখুন, যেমন shabbirhsadhon/khorochpotro";
    return null;
  }
  async function handleDownloadSource() {
    if (srcBusy) return;
    setSrcBusy(true);
    setSrcStatus("সোর্স কোডের ZIP তৈরি হচ্ছে…");
    try {
      const res = await withTimeout(api.exportSourceArchive({ token }), 60_000);
      if (!res.ok || !res.base64) {
        throw new Error(res.error || "সোর্স কোডের আর্কাইভ তৈরি করা যায়নি");
      }
      downloadBlob(
        new Blob([base64ToBytes(res.base64) as BlobPart], {
          type: "application/zip",
        }),
        res.filename || "khorochpotro-multi-user-source.zip",
      );
      setSrcStatus(
        `ডাউনলোড শুরু হয়েছে — ZIP-এ মোট ${bnInt(res.fileCount)}টি ফাইল আছে`,
      );
    } catch (e) {
      setSrcStatus(
        e instanceof RequestTimeoutError
          ? "সার্ভার সাড়া দিতে অনেক দেরি হচ্ছে — নেট সংযোগটা চেক করে আবার চেষ্টা করুন"
          : e instanceof Error
            ? e.message
            : "ডাউনলোড করা যায়নি",
      );
    } finally {
      setSrcBusy(false);
    }
  }
  async function handleBackupNow() {
    const s = currentGhSettings();
    const err = ghSettingsError(s);
    if (err) {
      setGhStatus(err);
      return;
    }
    persistGh(s);
    setGhBusy("backup");
    setGhStatus("এনক্রিপ্ট করে GitHub-এ পাঠানো হচ্ছে…");
    try {
      await uploadGithubBackup(s);
      setGhStatus(
        "ব্যাকআপ হয়েছে — সব এন্ট্রি আর বাজেট এনক্রিপ্টেড হয়ে GitHub-এ সেভ আছে",
      );
    } catch (e) {
      setGhStatus(e instanceof Error ? e.message : "ব্যাকআপ করা যায়নি");
    } finally {
      setGhBusy(null);
    }
  }
  async function handleRestore() {
    const s = currentGhSettings();
    if (!ghConfigured(s)) {
      setGhStatus("আগে রিপো, টোকেন আর পাসফ্রেজ দিন");
      return;
    }
    persistGh(s);
    setGhBusy("restore");
    setGhStatus("GitHub থেকে ব্যাকআপ নামিয়ে ডিক্রিপ্ট করা হচ্ছে…");
    try {
      const path = await ghBackupPath();
      const url = `https://api.github.com/repos/${s.repo}/contents/${path}`;
      const res = await fetch(url, { headers: ghHeaders(s) });
      if (!res.ok) throw new Error(ghErrorFor(res.status));
      const j = (await res.json()) as { content?: string };
      if (!j.content) throw new Error("ব্যাকআপ ফাইলে কোনো ডেটা নেই");
      const envelopeText = new TextDecoder().decode(b64ToBytes(j.content));
      let plain: string;
      try {
        plain = await decryptBackupText(s.passphrase, envelopeText);
      } catch {
        throw new Error("ডিক্রিপ্ট করা যায়নি — পাসফ্রেজ মিলছে না, নয়তো ফাইলটি নষ্ট");
      }
      const parsed = JSON.parse(plain) as {
        budgetPoisha?: unknown;
        budgets?: { month?: unknown; monthlyPoisha?: unknown }[];
        entries?: {
          date?: unknown;
          type?: unknown;
          category?: unknown;
          description?: unknown;
          amountPoisha?: unknown;
        }[];
      };
      const monthBudgets: { month: string; monthlyPoisha: number }[] = [];
      for (const b of parsed.budgets ?? []) {
        if (
          typeof b.month === "string" &&
          /^\d{4}-\d{2}$/.test(b.month) &&
          typeof b.monthlyPoisha === "number" &&
          Number.isInteger(b.monthlyPoisha) &&
          b.monthlyPoisha > 0
        ) {
          monthBudgets.push({
            month: b.month,
            monthlyPoisha: b.monthlyPoisha,
          });
        }
      }
      const legacyBudgetVal =
        typeof parsed.budgetPoisha === "number" &&
        Number.isInteger(parsed.budgetPoisha) &&
        parsed.budgetPoisha >= 0
          ? parsed.budgetPoisha
          : null;
      const clean: ImportedEntry[] = [];
      for (const e of parsed.entries ?? []) {
        if (
          typeof e.date === "string" &&
          /^\d{4}-\d{2}-\d{2}$/.test(e.date) &&
          (e.type === "expense" || e.type === "income") &&
          typeof e.category === "string" &&
          typeof e.amountPoisha === "number" &&
          Number.isInteger(e.amountPoisha) &&
          e.amountPoisha > 0
        ) {
          clean.push({
            date: e.date,
            type: e.type,
            category: e.category,
            description: typeof e.description === "string" ? e.description : "",
            amountPoisha: e.amountPoisha,
          });
        }
      }
      if (clean.length === 0 && monthBudgets.length === 0 && legacyBudgetVal === null) {
        setGhStatus("ব্যাকআপে কোনো বৈধ এন্ট্রি পাওয়া যায়নি");
        return;
      }
      let imported = 0;
      if (clean.length > 0) {
        const imp = await api.importEntries({ token, entries: clean });
        if (!imp.ok) {
          setGhStatus(imp.error || "ব্যাকআপ থেকে আনা যায়নি");
          return;
        }
        imported = imp.imported;
      }
      let budgetsRestored = 0;
      for (const b of monthBudgets) {
        const r = await api.setBudget({
          token,
          month: b.month,
          monthlyPoisha: b.monthlyPoisha,
        });
        if (r.ok) budgetsRestored++;
      }
      let legacyRestored = false;
      if (legacyBudgetVal !== null && legacyBudgetVal > 0) {
        const r = await api.setBudget({
          token,
          monthlyPoisha: legacyBudgetVal,
        });
        legacyRestored = r.ok;
      }
      const parts: string[] = [];
      if (imported > 0) parts.push(`${bnInt(imported)}টি এন্ট্রি`);
      if (budgetsRestored > 0)
        parts.push(`${bnInt(budgetsRestored)}টি মাসের বাজেট`);
      if (legacyRestored && budgetsRestored === 0) parts.push("মাসিক বাজেট");
      setGhStatus(
        parts.length > 0
          ? `${parts.join(" আর ")} ব্যাকআপ থেকে আনা হয়েছে`
          : "ব্যাকআপে কিছুই পাওয়া যায়নি",
      );
      handleChanged();
    } catch (e) {
      setGhStatus(e instanceof Error ? e.message : "ব্যাকআপ থেকে আনা যায়নি");
    } finally {
      setGhBusy(null);
    }
  }

  /* ------------------------------ Entry form ----------------------------- */
  const [fType, setFType] = useState<EntryType>("expense");
  const [fAmount, setFAmount] = useState("");
  const [fCategory, setFCategory] = useState<string>(EXPENSE_CATS[0] ?? "খাবার");
  const [fDesc, setFDesc] = useState("");
  const [fDate, setFDate] = useState(todayKey());
  const [editingId, setEditingId] = useState<number | null>(null);
  const [amountInvalid, setAmountInvalid] = useState(false);
  const [formBusy, setFormBusy] = useState(false);
  const amountRef = useRef<HTMLInputElement>(null);
  const formPanelRef = useRef<HTMLElement>(null);

  const formCats = fType === "expense" ? EXPENSE_CATS : INCOME_CATS;
  const formCatOptions = formCats.includes(fCategory)
    ? formCats
    : [...formCats, fCategory];

  function setFormType(t: EntryType, keepCategory = false) {
    setFType(t);
    const cats = t === "expense" ? EXPENSE_CATS : INCOME_CATS;
    setFCategory((cur) =>
      keepCategory && cats.includes(cur) ? cur : (cats[0] ?? "অন্যান্য"),
    );
  }
  function cancelEdit() {
    setEditingId(null);
    setFAmount("");
    setFDesc("");
    setFDate(todayKey());
    setAmountInvalid(false);
    setFormType("expense");
  }
  function startEdit(e: Entry) {
    setEditingId(e.id);
    setFType(e.type);
    setFCategory(e.category);
    const taka = Math.floor(e.amountPoisha / 100);
    const p = e.amountPoisha % 100;
    setFAmount(p ? `${taka}.${pad2(p)}` : String(taka));
    setFDesc(e.description);
    setFDate(e.date);
    setAmountInvalid(false);
    formPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    window.setTimeout(() => amountRef.current?.focus(), 350);
  }
  async function submitForm(ev: FormEvent) {
    ev.preventDefault();
    const poisha = parseAmountToPoisha(fAmount);
    if (poisha == null) {
      setAmountInvalid(true);
      amountRef.current?.focus();
      return;
    }
    const date = validDateStr(fDate) ? fDate : todayKey();
    const payload = {
      type: fType,
      category: fCategory || "অন্যান্য",
      description: fDesc.trim() || fCategory || "অন্যান্য",
      date,
      amountPoisha: poisha,
    };
    setFormBusy(true);
    try {
      if (editingId != null) {
        const res = await api.updateEntry({ token, id: editingId, ...payload });
        if (!res.ok) {
          showToast(res.error || "সেভ করা যায়নি");
          return;
        }
        const keepType = payload.type;
        const keepCat = payload.category;
        cancelEdit();
        setFormType(keepType);
        setFCategory(keepCat);
        handleChanged();
        showToast("এন্ট্রি হালনাগাদ হয়েছে");
      } else {
        const res = await api.addEntry({ token, ...payload });
        if (!res.ok) {
          showToast(res.error || "সেভ করা যায়নি");
          return;
        }
        const keepType = payload.type;
        const keepCat = payload.category;
        setFAmount("");
        setFDesc("");
        setFDate(todayKey());
        setFormType(keepType);
        setFCategory(keepCat);
        handleChanged();
        showToast(
          `${payload.type === "income" ? "জমা" : "খরচ"} যোগ হয়েছে: ${fmtMoney(payload.amountPoisha)} (${payload.category})`,
        );
      }
    } catch {
      showToast("সার্ভারে পৌঁছানো যাচ্ছে না, আবার চেষ্টা করুন");
    } finally {
      setFormBusy(false);
    }
  }

  /* --------------------------- Delete + undo ----------------------------- */
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const confirmTimer = useRef<number | null>(null);
  async function restoreEntry(e: {
    date: string;
    type: EntryType;
    category: string;
    description: string;
    amountPoisha: number;
  }) {
    try {
      const res = await api.addEntry({ token, ...e });
      if (res.ok) handleChanged();
    } catch {
      // Undo is best-effort; the toast already closed.
    }
  }
  async function handleDeleteClick(e: Entry) {
    if (confirmDeleteId !== e.id) {
      setConfirmDeleteId(e.id);
      if (confirmTimer.current !== null) {
        window.clearTimeout(confirmTimer.current);
      }
      confirmTimer.current = window.setTimeout(
        () => setConfirmDeleteId(null),
        3000,
      );
      return;
    }
    setConfirmDeleteId(null);
    try {
      const res = await api.deleteEntry({ token, id: e.id });
      if (!res.ok) {
        showToast(res.error || "মোছা যায়নি");
        return;
      }
      handleChanged();
      showToast("এন্ট্রি মুছে ফেলা হয়েছে", "ফিরিয়ে আনুন", () => {
        void restoreEntry({
          date: e.date,
          type: e.type,
          category: e.category,
          description: e.description,
          amountPoisha: e.amountPoisha,
        });
      });
    } catch {
      showToast("মোছা যায়নি, আবার চেষ্টা করুন");
    }
  }

  /* ------------------------------- Filters ------------------------------- */
  const [search, setSearch] = useState("");
  const [period, setPeriod] = useState<"all" | PeriodKind>("all");
  const [typeFilter, setTypeFilter] = useState<"all" | EntryType>("all");
  const [catFilter, setCatFilter] = useState("all");

  const filtered = useMemo(() => {
    const wr = weekRange();
    const q = search.trim().toLowerCase();
    return entriesDesc.filter((e) => {
      if (typeFilter !== "all" && e.type !== typeFilter) return false;
      if (catFilter !== "all" && e.category !== catFilter) return false;
      if (period === "today" && e.date !== todayKey()) return false;
      if (period === "week" && !(e.date >= wr.start && e.date <= wr.end))
        return false;
      if (period === "month" && monthOf(e.date) !== month) return false;
      if (q) {
        const hay = `${e.description} ${e.category}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [entriesDesc, search, period, typeFilter, catFilter, month]);

  const dayGroups = useMemo(() => {
    const groups: { date: string; items: Entry[]; inc: number; exp: number }[] =
      [];
    for (const e of filtered) {
      const last = groups[groups.length - 1];
      if (last && last.date === e.date) {
        last.items.push(e);
        if (e.type === "income") last.inc += e.amountPoisha;
        else last.exp += e.amountPoisha;
      } else {
        groups.push({
          date: e.date,
          items: [e],
          inc: e.type === "income" ? e.amountPoisha : 0,
          exp: e.type === "expense" ? e.amountPoisha : 0,
        });
      }
    }
    return groups;
  }, [filtered]);

  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function fit() {
      const box = listRef.current;
      if (!box) return;
      box.scrollTop = 0;
      const items = box.querySelectorAll(".entry");
      if (items.length > 3) {
        const third = items[2] as HTMLElement;
        const h =
          third.getBoundingClientRect().bottom -
          box.getBoundingClientRect().top +
          9;
        box.style.maxHeight = `${h}px`;
      } else {
        box.style.maxHeight = "";
      }
    }
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [dayGroups]);

  /* ------------------------------- Budget -------------------------------- */
  const [budgetInput, setBudgetInput] = useState("");
  const [budgetBusy, setBudgetBusy] = useState(false);
  useEffect(() => {
    const b = budgetMap.get(month) ?? legacyBudget;
    setBudgetInput(b > 0 ? budgetInputText(b) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, budgetMap, legacyBudget]);
  async function handleBudgetSave() {
    const raw = budgetInput;
    setBudgetBusy(true);
    try {
      if (!normalizeDigits(raw).trim()) {
        // Clear: remove this month's own row; if the shown value came
        // from the legacy every-month budget, clear that instead.
        if (budgetMap.has(month)) {
          await api.setBudget({ token, month, monthlyPoisha: 0 });
        } else if (legacyBudget > 0) {
          await api.setBudget({ token, monthlyPoisha: 0 });
        }
        handleChanged();
        showToast("এই মাসের বাজেট মুছে ফেলা হয়েছে");
        return;
      }
      const poisha = parseAmountToPoisha(raw);
      if (poisha == null) {
        showToast("বাজেটের ঘরে সঠিক টাকার পরিমাণ লিখুন");
        return;
      }
      const res = await api.setBudget({ token, month, monthlyPoisha: poisha });
      if (!res.ok) {
        showToast(res.error || "বাজেট ঠিক করা যায়নি");
        return;
      }
      handleChanged();
      showToast(`${monthLabel(month)}-এর বাজেট ঠিক হয়েছে: ${fmtMoney(poisha)}`);
    } catch {
      showToast("বাজেট ঠিক করা যায়নি, আবার চেষ্টা করুন");
    } finally {
      setBudgetBusy(false);
    }
  }

  /* --------------------------- CSV import/export -------------------------- */
  const importRef = useRef<HTMLInputElement>(null);
  const [importBusy, setImportBusy] = useState(false);
  function handleExport() {
    if (entriesAsc.length === 0) {
      showToast("নামানোর মতো কোনো এন্ট্রি নেই");
      return;
    }
    const lines = ["তারিখ,ধরন,ক্যাটাগরি,বিবরণ,টাকার পরিমাণ"];
    for (const e of entriesAsc) {
      lines.push(
        [
          e.date,
          e.type === "income" ? "জমা" : "খরচ",
          csvEscape(e.category),
          csvEscape(e.description),
          (e.amountPoisha / 100).toFixed(2),
        ].join(","),
      );
    }
    downloadTextFile("khorochpotro-all-entries.csv", lines.join("\n"));
    showToast("হিসাব নামানো হয়েছে (সিএসভি)");
  }
  async function handleImportFile(file: File) {
    setImportBusy(true);
    try {
      const text = await file.text();
      const entries = parseKhorochpotroCsv(text);
      if (entries.length === 0) {
        showToast("ফাইলে কোনো বৈধ এন্ট্রি পাওয়া যায়নি");
        return;
      }
      const res = await api.importEntries({ token, entries });
      if (!res.ok) {
        showToast(res.error || "আনা যায়নি");
        return;
      }
      handleChanged();
      showToast(`${bnInt(res.imported)}টি এন্ট্রি আনা হয়েছে`);
    } catch {
      showToast("ফাইলটি আনা যায়নি");
    } finally {
      setImportBusy(false);
    }
  }

  /* --------------------------- Period preview ----------------------------- */
  const [previewKind, setPreviewKind] = useState<PeriodKind | null>(null);
  const [previewShown, setPreviewShown] = useState(false);
  const [pieSel, setPieSel] = useState<PieSel | null>(null);
  const [piePinned, setPiePinned] = useState(false);
  const pieDragging = useRef(false);
  const closeTimer = useRef<number | null>(null);

  function openPreview(kind: PeriodKind) {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    setPieSel(null);
    setPiePinned(false);
    setPreviewKind(kind);
    document.body.classList.add("modal-open");
    requestAnimationFrame(() =>
      requestAnimationFrame(() => setPreviewShown(true)),
    );
  }
  function closePreview() {
    setPreviewShown(false);
    closeTimer.current = window.setTimeout(() => {
      setPreviewKind(null);
      document.body.classList.remove("modal-open");
    }, 360);
  }
  useEffect(() => {
    if (!previewKind) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") closePreview();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKind]);

  function periodEntries(kind: PeriodKind): Entry[] {
    if (kind === "today") {
      const t = todayKey();
      return entriesAsc.filter((e) => e.date === t);
    }
    if (kind === "week") {
      const wr = weekRange();
      return entriesAsc.filter((e) => e.date >= wr.start && e.date <= wr.end);
    }
    return entriesAsc.filter((e) => monthOf(e.date) === month);
  }

  /* -------------------------------- Voice -------------------------------- */
  const [listening, setListening] = useState(false);
  const [liveText, setLiveText] = useState("");
  const [voiceBox, setVoiceBox] = useState<VoiceBox>(null);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [veAmount, setVeAmount] = useState("");
  const [veErr, setVeErr] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const voicePanelRef = useRef<HTMLElement>(null);
  const voiceBoxRef = useRef<HTMLDivElement>(null);
  const [micPerm, setMicPerm] = useState<
    "unknown" | "granted" | "denied" | "prompt"
  >("unknown");
  const micSecure =
    typeof window !== "undefined" ? window.isSecureContext : true;

  useEffect(() => {
    if (!micSecure || !navigator.permissions?.query) return;
    navigator.permissions
      .query({ name: "microphone" as PermissionName })
      .then((st) => {
        setMicPerm(st.state as "granted" | "denied" | "prompt");
        st.onchange = () =>
          setMicPerm(st.state as "granted" | "denied" | "prompt");
      })
      .catch(() => {});
  }, [micSecure]);
  useEffect(() => {
    return () => {
      recognitionRef.current?.abort();
    };
  }, []);
  useEffect(() => {
    if (voiceBox?.kind === "preview" || voiceBox?.kind === "warn") {
      voiceBoxRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }
  }, [voiceBox]);

  function handleVoiceResult(text: string) {
    const r = parseVoiceText(text);
    if (r.poisha == null) {
      if (editingId == null) {
        setFormType(r.type);
        const cats = r.type === "expense" ? EXPENSE_CATS : INCOME_CATS;
        if (cats.includes(r.category)) setFCategory(r.category);
        setFDesc(r.desc);
        setFDate(r.date);
        setVoiceBox({ kind: "warn", raw: r.raw, filledForm: true });
        window.setTimeout(() => amountRef.current?.focus(), 100);
      } else {
        setVoiceBox({ kind: "warn", raw: r.raw, filledForm: false });
      }
      return;
    }
    setVoiceBox({
      kind: "preview",
      draft: {
        raw: r.raw,
        poisha: r.poisha,
        type: r.type,
        category: r.category,
        desc: r.desc,
        date: r.date,
      },
    });
  }

  function startVoice() {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      setVoiceBox({
        kind: "error",
        message:
          "এই ব্রাউজারে ভয়েস এন্ট্রি সাপোর্ট নেই — লিখে এন্ট্রি যোগ করুন",
      });
      return;
    }
    setVoiceBox(null);
    setLiveText("");
    const rec = new Ctor();
    rec.lang = "bn-BD";
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onresult = (e) => {
      let interim = "";
      let final = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (!res) continue;
        const transcript = res[0]?.transcript ?? "";
        if (res.isFinal) final += transcript;
        else interim += transcript;
      }
      setLiveText(final + interim);
      if (final.trim()) {
        setListening(false);
        handleVoiceResult(final.trim());
      }
    };
    rec.onerror = (e) => {
      setListening(false);
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        setMicPerm("denied");
        setVoiceBox({
          kind: "error",
          message:
            "মাইক্রোফোনের অনুমতি লাগবে — ব্রাউজারের সেটিংসে মাইক চালু করে আবার চেষ্টা করুন",
        });
      } else if (e.error === "no-speech") {
        setVoiceBox({ kind: "error", message: "কিছু শোনা যায়নি — আবার বলুন" });
      } else if (e.error !== "aborted") {
        setVoiceBox({
          kind: "error",
          message: "শুনতে সমস্যা হয়েছে — আবার চেষ্টা করুন",
        });
      }
    };
    rec.onend = () => setListening(false);
    recognitionRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch {
      setListening(false);
      setVoiceBox({
        kind: "error",
        message: "মাইক চালু করা যায়নি — আবার চেষ্টা করুন",
      });
    }
  }
  function toggleVoice() {
    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
    } else {
      startVoice();
    }
  }
  async function enableMicOnce() {
    if (!navigator.mediaDevices?.getUserMedia) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      stream.getTracks().forEach((t) => t.stop());
      setMicPerm("granted");
      showToast("মাইকের অনুমতি চালু হয়েছে — এখন থেকে আর চাইবে না");
    } catch {
      setMicPerm("denied");
    }
  }

  async function confirmVoiceAdd(draft: VoiceDraft) {
    setVoiceBusy(true);
    try {
      const res = await api.addEntry({
        token,
        date: draft.date,
        type: draft.type,
        category: draft.category,
        description: draft.desc,
        amountPoisha: draft.poisha,
      });
      if (!res.ok) {
        setVoiceBox({
          kind: "error",
          message: res.error || "সেভ করা যায়নি — আবার চেষ্টা করুন",
        });
        return;
      }
      const newId = res.id;
      setVoiceBox({ kind: "done", draft });
      handleChanged();
      showToast(
        `${draft.type === "income" ? "জমা" : "খরচ"} যোগ হয়েছে: ${fmtMoney(draft.poisha)}`,
        "বাতিল করুন",
        () => {
          void (async () => {
            try {
              await api.deleteEntry({ token, id: newId });
              handleChanged();
            } catch {
              // best-effort undo
            }
          })();
        },
      );
    } catch {
      setVoiceBox({
        kind: "error",
        message: "সার্ভারে পৌঁছানো যাচ্ছে না, আবার চেষ্টা করুন",
      });
    } finally {
      setVoiceBusy(false);
    }
  }

  const [exUse, setExUse] = useState<Record<string, number>>(loadExUse);
  const sortedExamples = useMemo(
    () =>
      EXAMPLES.map((ex, i) => ({ ex, i, n: exUse[ex] ?? 0 })).sort(
        (a, b) => b.n - a.n || a.i - b.i,
      ),
    [exUse],
  );
  function handleExample(ex: string) {
    const next = { ...exUse, [ex]: (exUse[ex] ?? 0) + 1 };
    setExUse(next);
    try {
      localStorage.setItem(EX_USE_KEY, JSON.stringify(next));
    } catch {
      // counts are a nicety only
    }
    handleVoiceResult(ex);
  }

  /* ------------------------------- Logout -------------------------------- */
  const [logoutConfirm, setLogoutConfirm] = useState(false);

  /* ------------------------- Backup field actions ------------------------ */
  function saveGhToken() {
    persistGh({
      repo: ghRepo.trim(),
      token: ghTokenIn.trim(),
      passphrase: ghSaved.passphrase,
    });
    setGhStatus("টোকেন সংরক্ষণ করা হয়েছে");
    scheduleAutoBackup();
  }
  function clearGhToken() {
    setGhTokenIn("");
    persistGh({ ...ghSaved, token: "" });
    setGhStatus("টোকেন মোছা হয়েছে");
  }
  function saveGhPass() {
    persistGh({
      repo: ghRepo.trim(),
      token: ghSaved.token,
      passphrase: ghPassIn,
    });
    setGhStatus("পাসফ্রেজ সংরক্ষণ করা হয়েছে");
    scheduleAutoBackup();
  }
  function clearGhPass() {
    setGhPassIn("");
    persistGh({ ...ghSaved, passphrase: "" });
    setGhStatus("পাসফ্রেজ মোছা হয়েছে");
  }

  /* --------------------------- Summary numbers --------------------------- */
  const totalIncAll = sumEntries(entriesAsc, "income");
  const totalExpAll = sumEntries(entriesAsc, "expense");
  const todayList = entriesAsc.filter((e) => e.date === todayKey());
  const wr = weekRange();
  const weekList = entriesAsc.filter(
    (e) => e.date >= wr.start && e.date <= wr.end,
  );
  const monthList = entriesAsc.filter((e) => monthOf(e.date) === month);
  const mExp = sumEntries(monthList, "expense");
  const mInc = sumEntries(monthList, "income");
  const elapsed = elapsedDaysInMonth(month);
  const avgDaily = elapsed > 0 ? Math.round(mExp / elapsed) : 0;
  const monthBudget = budgetFor(month);
  const budgetPct =
    monthBudget > 0 ? Math.min((mExp / monthBudget) * 100, 100) : 0;

  /* ------------------------- Period preview data -------------------------- */
  const previewList = previewKind ? periodEntries(previewKind) : [];
  const previewInc = sumEntries(previewList, "income");
  const previewExp = sumEntries(previewList, "expense");
  const previewSorted = [...previewList].sort((a, b) =>
    a.date === b.date ? b.id - a.id : a.date < b.date ? 1 : -1,
  );
  const pieSegs: PieSeg[] = [];
  let pieCenterDef = { lbl: "", val: "" };
  let showDonut = false;
  if (previewKind === "month") {
    const totalAll = previewInc + previewExp;
    if (totalAll > 0) {
      showDonut = true;
      pieCenterDef = { lbl: "ব্যালান্স", val: fmtMoney(previewInc - previewExp) };
      let offset = 0;
      const slices: { val: number; color: string; label: string; type: EntryType }[] = [
        { val: previewInc, color: "var(--income)", label: "জমা", type: "income" },
        { val: previewExp, color: "var(--expense)", label: "খরচ", type: "expense" },
      ];
      for (const s of slices) {
        if (s.val <= 0) continue;
        const frac = s.val / totalAll;
        pieSegs.push({
          type: s.type,
          cat: null,
          label: s.label,
          val: s.val,
          start: offset,
          end: offset + frac,
          color: s.color,
        });
        offset += frac;
      }
    }
  } else if (previewKind) {
    const byCat = new Map<string, number>();
    for (const e of previewList) {
      if (e.type === "expense") {
        byCat.set(e.category, (byCat.get(e.category) ?? 0) + e.amountPoisha);
      }
    }
    const rows = [...byCat.entries()]
      .map(([cat, val]) => ({ cat, val }))
      .sort((a, b) => b.val - a.val);
    if (previewExp > 0 && rows.length > 0) {
      showDonut = true;
      pieCenterDef = { lbl: "মোট খরচ", val: fmtMoney(previewExp) };
      let offset = 0;
      for (const r of rows) {
        const frac = r.val / previewExp;
        pieSegs.push({
          type: "expense",
          cat: r.cat,
          label: r.cat,
          val: r.val,
          start: offset,
          end: offset + frac,
          color: catColor(r.cat),
        });
        offset += frac;
      }
    }
  }
  function segMatches(seg: PieSeg): boolean {
    if (!pieSel) return false;
    if (pieSel.type && seg.type !== pieSel.type) return false;
    if (pieSel.cat && seg.cat && seg.cat !== pieSel.cat) return false;
    return true;
  }
  function elMatches(type: EntryType | null, cat: string | null): boolean {
    if (!pieSel) return false;
    if (pieSel.type && type && type !== pieSel.type) return false;
    if (pieSel.cat && cat && cat !== pieSel.cat) return false;
    return !!(
      (pieSel.type && type === pieSel.type) ||
      (pieSel.cat && cat === pieSel.cat)
    );
  }
  function sameSel(a: PieSel | null, b: PieSel): boolean {
    return !!a && a.type === b.type && a.cat === b.cat;
  }
  function togglePieSel(sel: PieSel) {
    if (piePinned && sameSel(pieSel, sel)) {
      setPieSel(null);
      setPiePinned(false);
    } else {
      setPieSel(sel);
      setPiePinned(true);
    }
  }
  const selectedSeg =
    pieSegs.find(
      (s) => segMatches(s) && (!pieSel?.cat || s.cat === pieSel.cat),
    ) ?? pieSegs.find((s) => segMatches(s));
  const centerLbl = selectedSeg ? selectedSeg.label : pieCenterDef.lbl;
  const centerVal = selectedSeg
    ? fmtMoney(selectedSeg.val)
    : pieCenterDef.val;
  const PIE_C = 2 * Math.PI * 70;
  function pieSegAtPoint(
    clientX: number,
    clientY: number,
    svg: SVGSVGElement,
  ): PieSeg | null {
    if (!pieSegs.length) return null;
    const r = svg.getBoundingClientRect();
    if (!r.width) return null;
    const dx = clientX - (r.left + r.width / 2);
    const dy = clientY - (r.top + r.height / 2);
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < r.width * 0.27 || dist > r.width * 0.52) return null;
    const frac =
      ((((Math.atan2(dy, dx) * 180) / Math.PI + 90) % 360) + 360) % 360 / 360;
    for (const s of pieSegs) {
      if (frac >= s.start && frac < s.end) return s;
    }
    return pieSegs[pieSegs.length - 1] ?? null;
  }
  function legendRow(
    key: string,
    sel: PieSel,
    color: string,
    name: string,
    val: number,
    total: number,
  ) {
    const pct = total > 0 ? (val / total) * 100 : 0;
    const m = elMatches(sel.type, sel.cat);
    return (
      <div
        key={key}
        className={`legend-row${pieSel ? (m ? " hl" : " dim") : ""}`}
        data-hl-type={sel.type ?? undefined}
        data-hl-cat={sel.cat ?? undefined}
        role="button"
        tabIndex={0}
        onClick={() => togglePieSel(sel)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            togglePieSel(sel);
          }
        }}
      >
        <span className="sw" style={{ background: color }} />
        <span className="l-name">
          {name} <span className="l-pct">({fmtPct(pct)}%)</span>
        </span>
        <span className="l-val">{fmtMoney(val)}</span>
        <span className="legend-bar">
          <div style={{ width: `${pct}%`, background: color }} />
        </span>
      </div>
    );
  }
  function categoryRowsJsx(list: Entry[], type: EntryType) {
    const total = sumEntries(list, type);
    if (total <= 0) return null;
    const byCat = new Map<string, number>();
    for (const e of list) {
      if (e.type === type) {
        byCat.set(e.category, (byCat.get(e.category) ?? 0) + e.amountPoisha);
      }
    }
    const rows = [...byCat.entries()]
      .map(([cat, val]) => ({ cat, val }))
      .sort((a, b) => b.val - a.val);
    const color = type === "income" ? "var(--income)" : "var(--expense)";
    return (
      <>
        <div className="modal-sec">
          {type === "income" ? "ক্যাটাগরি অনুযায়ী জমা" : "ক্যাটাগরি অনুযায়ী খরচ"}
        </div>
        {rows.map((r) =>
          legendRow(`cat-${type}-${r.cat}`, { type, cat: r.cat }, color, r.cat, r.val, total),
        )}
      </>
    );
  }

  /* ------------------------------ Voice box ------------------------------- */
  function setVoiceDraftType(draft: VoiceDraft, t: EntryType): VoiceDraft {
    const cats = t === "income" ? INCOME_CATS : EXPENSE_CATS;
    return {
      ...draft,
      type: t,
      category: cats.includes(draft.category) ? draft.category : "অন্যান্য",
    };
  }
  function voicePreviewCats(draft: VoiceDraft): string[] {
    const cats = draft.type === "income" ? INCOME_CATS : EXPENSE_CATS;
    return cats.includes(draft.category) ? cats : [...cats, draft.category];
  }
  function enterVoiceEdit(draft: VoiceDraft) {
    setVeAmount(
      draft.poisha % 100 === 0
        ? String(draft.poisha / 100)
        : (draft.poisha / 100).toFixed(2),
    );
    setVeErr(false);
    setVoiceBox({ kind: "edit", draft });
  }
  function applyVoiceEdit(draft: VoiceDraft) {
    const poisha = parseAmountToPoisha(veAmount);
    if (poisha == null) {
      setVeErr(true);
      return;
    }
    setVoiceBox({ kind: "preview", draft: { ...draft, poisha } });
  }

  function renderVoiceBox() {
    if (!voiceBox) return null;
    if (voiceBox.kind === "error") {
      return (
        <div className="voice-detected show warn" role="alert">
          {voiceBox.message}
        </div>
      );
    }
    if (voiceBox.kind === "warn") {
      return (
        <div className="voice-detected show warn" ref={voiceBoxRef}>
          আপনি বলেছেন: “{voiceBox.raw}”
          <br />
          {voiceBox.filledForm
            ? "টাকার পরিমাণটা বুঝতে পারিনি। আবার বলুন, অথবা নিচের ঘরে হাতে লিখুন — বিবরণটা বসিয়ে দিয়েছি।"
            : "টাকার পরিমাণটা বুঝতে পারিনি। আবার বলুন — (একটা এন্ট্রি সম্পাদনা চলছে, তাই ফর্মে হাত দিইনি।)"}
        </div>
      );
    }
    if (voiceBox.kind === "done") {
      const d = voiceBox.draft;
      return (
        <div className="voice-detected show ok">
          যোগ হয়েছে —{" "}
          <strong>
            {d.type === "income" ? "জমা" : "খরচ"}: {fmtMoney(d.poisha)}
          </strong>{" "}
          · ক্যাটাগরি: <strong>{d.category}</strong>
          <br />
          <span>“{d.raw}”</span>
        </div>
      );
    }
    const draft = voiceBox.draft;
    if (voiceBox.kind === "preview") {
      return (
        <div className="voice-detected voice-preview show ok" ref={voiceBoxRef}>
          <span className="v-lbl">আপনি বলেছেন</span>
          <div className="vp-heard">“{draft.raw}”</div>
          <div className="vp-grid">
            <div>
              টাকার পরিমাণ: <strong>{fmtMoney(draft.poisha)}</strong>
            </div>
            <div>
              তারিখ: <strong>{dayLabel(draft.date)}</strong>
            </div>
            <div>
              বিবরণ: <strong>{draft.desc}</strong>
            </div>
          </div>
          <div className="vp-type-row">
            <span className="vp-cat-lbl">ধরন:</span>
            <div className="vp-type-choices" role="group" aria-label="এন্ট্রির ধরন">
              <button
                type="button"
                data-type="expense"
                aria-pressed={draft.type === "expense"}
                onClick={() =>
                  setVoiceBox({
                    kind: "preview",
                    draft: setVoiceDraftType(draft, "expense"),
                  })
                }
              >
                খরচ
              </button>
              <button
                type="button"
                data-type="income"
                aria-pressed={draft.type === "income"}
                onClick={() =>
                  setVoiceBox({
                    kind: "preview",
                    draft: setVoiceDraftType(draft, "income"),
                  })
                }
              >
                জমা / আয়
              </button>
            </div>
          </div>
          <div className="vp-cat-row">
            <span className="vp-cat-lbl">ক্যাটাগরি:</span>
            <Dropdown
              ariaLabel="ক্যাটাগরি বেছে নিন"
              value={draft.category}
              options={voicePreviewCats(draft).map((c) => ({
                value: c,
                label: c,
              }))}
              onChange={(v) =>
                setVoiceBox({
                  kind: "preview",
                  draft: { ...draft, category: v },
                })
              }
            />
          </div>
          <p className="vp-note">
            ধরন আর ক্যাটাগরি এখান থেকেই বদলাতে পারবেন; অন্য কিছু ভুল থাকলে
            “ঠিক করুন” চাপুন।
          </p>
          <div className="vp-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={voiceBusy}
              onClick={() => void confirmVoiceAdd(draft)}
            >
              অ্যাড করুন
            </button>
            <button
              type="button"
              className="btn btn-tonal btn-sm"
              onClick={() => enterVoiceEdit(draft)}
            >
              ঠিক করুন
            </button>
            <button
              type="button"
              className="btn btn-outline btn-sm"
              onClick={() => {
                setVoiceBox(null);
                startVoice();
              }}
            >
              আবার বলুন
            </button>
          </div>
        </div>
      );
    }
    // edit mode
    return (
      <div className="voice-detected voice-preview show ok">
        <span className="v-lbl">ঠিক করুন — যা ভুল শোনা হয়েছে বদলে দিন</span>
        <div className="vp-heard">“{draft.raw}”</div>
        <div className="vp-edit">
          <div>
            <label>ধরন</label>
            <div className="vp-seg" role="group" aria-label="এন্ট্রির ধরন">
              <button
                type="button"
                data-vtype="expense"
                aria-pressed={draft.type === "expense"}
                onClick={() =>
                  setVoiceBox({
                    kind: "edit",
                    draft: setVoiceDraftType(draft, "expense"),
                  })
                }
              >
                খরচ
              </button>
              <button
                type="button"
                data-vtype="income"
                aria-pressed={draft.type === "income"}
                onClick={() =>
                  setVoiceBox({
                    kind: "edit",
                    draft: setVoiceDraftType(draft, "income"),
                  })
                }
              >
                জমা / আয়
              </button>
            </div>
          </div>
          <div className="vp-row">
            <div>
              <label htmlFor="ve-amount">টাকার পরিমাণ</label>
              <input
                id="ve-amount"
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={veAmount}
                onChange={(e) => {
                  setVeAmount(e.target.value);
                  setVeErr(false);
                }}
              />
            </div>
            <div>
              <label htmlFor="ve-cat">ক্যাটাগরি</label>
              <Dropdown
                id="ve-cat"
                ariaLabel="ক্যাটাগরি"
                value={draft.category}
                options={voicePreviewCats(draft).map((c) => ({
                  value: c,
                  label: c,
                }))}
                onChange={(v) =>
                  setVoiceBox({
                    kind: "edit",
                    draft: { ...draft, category: v },
                  })
                }
              />
            </div>
          </div>
          <div>
            <label htmlFor="ve-desc">বিবরণ</label>
            <input
              id="ve-desc"
              type="text"
              autoComplete="off"
              maxLength={120}
              value={draft.desc}
              onChange={(e) =>
                setVoiceBox({
                  kind: "edit",
                  draft: { ...draft, desc: e.target.value },
                })
              }
            />
          </div>
          <div>
            <label htmlFor="ve-date">তারিখ</label>
            <input
              id="ve-date"
              type="date"
              value={draft.date}
              onChange={(e) =>
                setVoiceBox({
                  kind: "edit",
                  draft: { ...draft, date: e.target.value },
                })
              }
            />
          </div>
          <p className={`vp-err${veErr ? " show" : ""}`}>
            সঠিক টাকার পরিমাণ লিখুন (শূন্যের বেশি হতে হবে)।
          </p>
        </div>
        <div className="vp-actions">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => applyVoiceEdit(draft)}
          >
            প্রিভিউতে ফিরুন
          </button>
          <button
            type="button"
            className="btn btn-outline btn-sm"
            onClick={() => setVoiceBox({ kind: "preview", draft })}
          >
            বাতিল
          </button>
        </div>
      </div>
    );
  }

  if (allQuery.isPending) {
    return (
      <div className="wrap">
        <p style={{ textAlign: "center", color: "var(--ink-2)", paddingTop: 60 }}>
          লোড হচ্ছে…
        </p>
      </div>
    );
  }

  const previewTitle =
    previewKind === "today"
      ? "আজকের খরচ"
      : previewKind === "week"
        ? "এই সপ্তাহের খরচ"
        : `${monthLabel(month)} — জমা ও খরচ`;
  const previewSub =
    previewKind === "month"
      ? `জমা ${fmtMoney(previewInc)} · খরচ ${fmtMoney(previewExp)} · মোট ${bnInt(previewList.length)}টি এন্ট্রি`
      : `জমা ${fmtMoney(previewInc)} · মোট ${bnInt(previewList.length)}টি এন্ট্রি`;

  return (
    <div className="wrap pt-safe">
      <header className="top">
        <div>
          <h1>খরচপত্র</h1>
          <p className="today-line">{todayLine()}</p>
        </div>
        <div className="month-tools">
          <button
            className="btn btn-primary"
            type="button"
            onClick={() => {
              generateMonthlyPdf(entriesAsc, month, budgetFor(month));
              showToast(
                `পিডিএফ প্রতিবেদন নামানো হয়েছে — ${monthLabel(month)}`,
              );
            }}
          >
            <Icon d={ICON_DOWNLOAD} size={19} />
            মাসিক প্রতিবেদন (পিডিএফ)
          </button>
        </div>
      </header>

      {/* Month stepper — dark bar with round chevron buttons, as the
          user asked; tapping the month name still opens the month list
          so jumping straight to any month keeps working. */}
      <div className="month-stepper">
        <button
          type="button"
          className="step-btn"
          aria-label="আগের মাস"
          disabled={month <= (monthOptions[monthOptions.length - 1]?.value ?? month)}
          onClick={() => setMonth(shiftMonth(month, -1))}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m15 5-7 7 7 7" />
          </svg>
        </button>
        <Dropdown
          id="monthInput"
          ariaLabel="মাস বাছাই করুন"
          value={month}
          options={monthOptions}
          onChange={setMonth}
          wrapClassName="month-dd"
        />
        <button
          type="button"
          className="step-btn"
          aria-label="পরের মাস"
          disabled={month >= (monthOptions[0]?.value ?? month)}
          onClick={() => setMonth(shiftMonth(month, 1))}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="m9 5 7 7-7 7" />
          </svg>
        </button>
      </div>

      {/* Summary */}
      <section className="summary" aria-label="সারসংক্ষেপ">
        <div className="balance-card">
          <div>
            <div className="lbl">মোট ব্যালান্স (সব সময়ের)</div>
            <div className="big">{fmtMoney(totalIncAll - totalExpAll)}</div>
            <div className="sub">{bnInt(entriesAsc.length)}টি এন্ট্রি</div>
          </div>
          <div className="balance-side">
            <div className="balance-chip">
              <div className="c-lbl">মোট জমা</div>
              <div className="c-val">{fmtMoney(totalIncAll)}</div>
            </div>
            <div className="balance-chip">
              <div className="c-lbl">মোট খরচ</div>
              <div className="c-val">{fmtMoney(totalExpAll)}</div>
            </div>
          </div>
        </div>
        <button
          className="card stat"
          type="button"
          aria-haspopup="dialog"
          onClick={() => openPreview("today")}
        >
          <span className="s-lbl">
            <span className="dot" style={{ background: "var(--expense)" }} />
            আজকের খরচ
          </span>
          <span className="s-val" style={{ display: "block" }}>
            {fmtMoney(sumEntries(todayList, "expense"))}
          </span>
          <span className="s-sub" style={{ display: "block" }}>
            আজকের জমা {fmtMoney(sumEntries(todayList, "income"))}
          </span>
          <span className="s-more">ক্যাটাগরি অনুযায়ী দেখুন ›</span>
        </button>
        <button
          className="card stat"
          type="button"
          aria-haspopup="dialog"
          onClick={() => openPreview("week")}
        >
          <span className="s-lbl">
            <span className="dot" style={{ background: "var(--cat-2)" }} />
            এই সপ্তাহের খরচ
          </span>
          <span className="s-val" style={{ display: "block" }}>
            {fmtMoney(sumEntries(weekList, "expense"))}
          </span>
          <span className="s-sub" style={{ display: "block" }}>
            এই সপ্তাহের জমা {fmtMoney(sumEntries(weekList, "income"))}
          </span>
          <span className="s-more">ক্যাটাগরি অনুযায়ী দেখুন ›</span>
        </button>
        <button
          className="card stat"
          type="button"
          aria-haspopup="dialog"
          onClick={() => openPreview("month")}
        >
          <span className="s-lbl">
            <span className="dot" style={{ background: "var(--amber)" }} />
            {monthLabel(month)} — খরচ
          </span>
          <span className="s-val" style={{ display: "block" }}>
            {fmtMoney(mExp)}
          </span>
          <span className="s-sub" style={{ display: "block" }}>
            মাসের জমা {fmtMoney(mInc)}
          </span>
          <span className="s-more">ক্যাটাগরি অনুযায়ী দেখুন ›</span>
        </button>
        <div className="card stat">
          <div className="s-lbl">
            <span className="dot" style={{ background: "var(--cat-6)" }} />
            গড় দৈনিক খরচ
          </div>
          <div className="s-val">{fmtMoney(avgDaily)}</div>
          <div className="s-sub">
            {monthLabel(month)} · {bnInt(elapsed)} দিন ধরে
          </div>
        </div>
      </section>

      <div className="grid">
        {/* Left column */}
        <div className="stack">
          {/* Voice */}
          <section
            className="card panel voice-panel"
            aria-label="কণ্ঠ দিয়ে এন্ট্রি"
            ref={voicePanelRef}
          >
            <h2>
              <MicIcon size={21} />
              বলেই হিসাব যোগ করুন
            </h2>
            <p className="hint">বাংলায় বলুন — প্রিভিউ দেখে অ্যাড করুন।</p>
            <button
              className={`mic-btn${listening ? " listening" : ""}`}
              type="button"
              aria-label="কণ্ঠ দিয়ে এন্ট্রি শুরু করুন"
              onClick={toggleVoice}
            >
              <MicIcon size={42} />
            </button>
            <div className="voice-status">
              {listening
                ? "শুনছি… বলুন"
                : !micSecure
                  ? "ফাইল থেকে মাইক চলবে না — নিচে দেখুন"
                  : "শুরু করতে মাইক বোতামে চাপ দিন"}
            </div>
            {!micSecure && (
              <div className="voice-notice" role="note">
                <strong>ফাইল থেকে মাইক চলবে না</strong> — অ্যাপটা অনলাইন লিংক
                থেকে খুলুন, সেখানে একবার অনুমতি দিলেই চলবে। হাতে লেখা এখানেও
                চলবে।
              </div>
            )}
            {micSecure && micPerm === "denied" && (
              <div className="voice-notice" role="note">
                <strong>মাইকের অনুমতি বন্ধ আছে।</strong> ব্রাউজারের তালা/সেটিংস
                চিহ্ন → মাইক্রোফোন → “অনুমতি দিন” → পাতা আবার খুলুন।
              </div>
            )}
            {micSecure && micPerm === "prompt" && (
              <button
                id="micEnableBtn"
                className="btn btn-tonal"
                type="button"
                onClick={() => void enableMicOnce()}
              >
                মাইক একবার চালু করে নিন
              </button>
            )}
            <div className={`voice-live${listening ? " show" : ""}`}>
              <span className="v-lbl">আপনি বলছেন</span>
              <span>{liveText}</span>
            </div>
            {renderVoiceBox()}
            <div className="examples">
              <div className="ex-title">উদাহরণ</div>
              <div className="example-list">
                {sortedExamples.map(({ ex }) => (
                  <button key={ex} type="button" onClick={() => handleExample(ex)}>
                    “{ex}”
                  </button>
                ))}
              </div>
            </div>
          </section>

          {/* Manual form */}
          <section
            className="card panel"
            aria-label="হাতে এন্ট্রি"
            ref={formPanelRef}
          >
            <h2>
              <Icon d={ICON_EDIT} />
              <span>
                {editingId != null ? "এন্ট্রি সম্পাদনা করুন" : "হাতে এন্ট্রি যোগ করুন"}
              </span>
            </h2>
            <form onSubmit={submitForm} noValidate>
              <div
                className={`seg${fType === "income" ? " income" : ""}`}
                role="group"
                aria-label="এন্ট্রির ধরন"
              >
                <span className="seg-thumb" aria-hidden="true" />
                <button
                  type="button"
                  data-type="expense"
                  aria-pressed={fType === "expense"}
                  onClick={() => setFormType("expense", true)}
                >
                  খরচ
                </button>
                <button
                  type="button"
                  data-type="income"
                  aria-pressed={fType === "income"}
                  onClick={() => setFormType("income", true)}
                >
                  জমা / আয়
                </button>
              </div>
              <div className={`field${amountInvalid ? " invalid" : ""}`}>
                <label htmlFor="amountInput">টাকার পরিমাণ</label>
                <div className="amount-wrap">
                  <span className="cur">৳</span>
                  <input
                    ref={amountRef}
                    id="amountInput"
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="যেমন: ২৫০ বা 250"
                    value={fAmount}
                    onChange={(e) => {
                      setFAmount(e.target.value);
                      setAmountInvalid(false);
                    }}
                  />
                </div>
                <div className="err">
                  সঠিক টাকার পরিমাণ লিখুন (শূন্যের বেশি হতে হবে)।
                </div>
              </div>
              <div className="field-row">
                <div className="field">
                  <label htmlFor="categorySelect">ক্যাটাগরি</label>
                  <Dropdown
                    id="categorySelect"
                    ariaLabel="ক্যাটাগরি"
                    value={fCategory}
                    options={formCatOptions.map((c) => ({
                      value: c,
                      label: c,
                    }))}
                    onChange={setFCategory}
                  />
                </div>
                <div className="field">
                  <label htmlFor="dateInput">তারিখ</label>
                  <input
                    id="dateInput"
                    type="date"
                    max={todayKey()}
                    value={fDate}
                    onChange={(e) => setFDate(e.target.value)}
                  />
                </div>
              </div>
              <div className="field">
                <label htmlFor="descInput">বিবরণ</label>
                <input
                  id="descInput"
                  type="text"
                  autoComplete="off"
                  placeholder="যেমন: দুপুরের খাবার"
                  maxLength={120}
                  value={fDesc}
                  onChange={(e) => setFDesc(e.target.value)}
                />
              </div>
              <div className="form-actions">
                <button
                  className="btn btn-primary"
                  type="submit"
                  disabled={formBusy}
                >
                  {editingId != null ? "সংরক্ষণ করুন" : "যোগ করুন"}
                </button>
                {editingId != null && (
                  <button
                    className="btn btn-danger-ghost"
                    type="button"
                    onClick={cancelEdit}
                  >
                    সম্পাদনা বাতিল
                  </button>
                )}
              </div>
            </form>
          </section>

          {/* Budget */}
          <section className="card panel" aria-label="মাসিক বাজেট">
            <h2>
              <Icon
                d={
                  <>
                    <circle cx="12" cy="12" r="9" />
                    <circle cx="12" cy="12" r="5" />
                    <circle cx="12" cy="12" r="1" />
                  </>
                }
              />
              মাসিক বাজেট
            </h2>
            <p className="hint">{monthLabel(month)}</p>
            <div className="budget-row">
              <input
                type="text"
                inputMode="decimal"
                placeholder="যেমন: ২০০০০"
                autoComplete="off"
                aria-label="মাসিক বাজেট (টাকা)"
                value={budgetInput}
                onChange={(e) => setBudgetInput(e.target.value)}
              />
              <button
                className="btn btn-tonal"
                type="button"
                disabled={budgetBusy}
                onClick={() => void handleBudgetSave()}
              >
                ঠিক করুন
              </button>
            </div>
            {monthBudget > 0 ? (
              <div>
                <div className="progress">
                  <div
                    className={mExp > monthBudget ? "over" : ""}
                    style={{ width: `${budgetPct}%` }}
                  />
                </div>
                <div className="budget-meta">
                  <span>
                    খরচ হয়েছে <strong>{fmtMoney(mExp)}</strong> /{" "}
                    <strong>{fmtMoney(monthBudget)}</strong>
                  </span>
                  {mExp > monthBudget ? (
                    <span className="over-text">
                      বাজেট ছাড়িয়ে গেছে {fmtMoney(mExp - monthBudget)}
                    </span>
                  ) : (
                    <span>
                      বাকি আছে <strong>{fmtMoney(monthBudget - mExp)}</strong>{" "}
                      ({fmtPct(((monthBudget - mExp) / monthBudget) * 100)}% বাকি)
                    </span>
                  )}
                </div>
              </div>
            ) : (
              <p className="hint" style={{ margin: "12px 0 0" }}>
                বাজেট ঠিক করা হয়নি।
              </p>
            )}
          </section>
        </div>

        {/* Right column */}
        <div className="stack">
          <section className="card panel" aria-label="হিসাবের ইতিহাস">
            <h2>
              <Icon
                d={
                  <>
                    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
                    <path d="M3 3v5h5" />
                    <path d="M12 7v5l4 2" />
                  </>
                }
              />
              হিসাবের ইতিহাস
            </h2>
            <div className="history-tools">
              <div className="search-wrap">
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <circle cx="11" cy="11" r="7" />
                  <line x1="21" y1="21" x2="16.5" y2="16.5" />
                </svg>
                <input
                  type="search"
                  placeholder="বিবরণ বা ক্যাটাগরি খুঁজুন…"
                  aria-label="বিবরণ বা ক্যাটাগরি খুঁজুন"
                  autoComplete="off"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <div className="chips" role="group" aria-label="সময় অনুযায়ী ছাঁকনি">
                {(
                  [
                    ["all", "সব সময়"],
                    ["today", "আজ"],
                    ["week", "এই সপ্তাহ"],
                    ["month", "নির্বাচিত মাস"],
                  ] as const
                ).map(([v, l]) => (
                  <button
                    key={v}
                    className="chip"
                    type="button"
                    aria-pressed={period === v}
                    onClick={() => setPeriod(v)}
                  >
                    {l}
                  </button>
                ))}
              </div>
              <div className="filter-row">
                <Dropdown
                  ariaLabel="ধরন অনুযায়ী ছাঁকনি"
                  value={typeFilter}
                  options={[
                    { value: "all", label: "সব ধরন" },
                    { value: "expense", label: "শুধু খরচ" },
                    { value: "income", label: "শুধু জমা" },
                  ]}
                  onChange={(v) => setTypeFilter(v as "all" | EntryType)}
                />
                <Dropdown
                  ariaLabel="ক্যাটাগরি অনুযায়ী ছাঁকনি"
                  value={catFilter}
                  options={[
                    { value: "all", label: "সব ক্যাটাগরি" },
                    ...ALL_CATS.map((c) => ({ value: c, label: c })),
                  ]}
                  onChange={setCatFilter}
                />
              </div>
            </div>
            <div className="entry-list-scroll" ref={listRef}>
              {filtered.length === 0 ? (
                <div className="empty-note">
                  {entriesAsc.length === 0 ? (
                    <>
                      এখনো কোনো এন্ট্রি নেই।
                      <br />
                      উপরে বলুন অথবা হাতে লিখে প্রথম হিসাবটা যোগ করুন।
                    </>
                  ) : (
                    "এই ছাঁকনিতে কোনো এন্ট্রি মেলেনি।"
                  )}
                </div>
              ) : (
                dayGroups.map((g) => (
                  <div className="day-group" key={g.date}>
                    <div className="day-head">
                      <span className="d-name">{dayLabel(g.date)}</span>
                      <span className="d-total">
                        {[
                          g.inc > 0 ? `জমা ${fmtMoney(g.inc)}` : "",
                          g.exp > 0 ? `খরচ ${fmtMoney(g.exp)}` : "",
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </div>
                    {g.items.map((e) => (
                      <div className={`entry ${e.type}`} key={e.id}>
                        <span className="e-ico">
                          <Icon d={e.type === "income" ? ICON_UP : ICON_DOWN} />
                        </span>
                        <div className="e-main">
                          <div className="e-desc">{e.description}</div>
                          <div className="e-meta">
                            {e.category} · {dayLabel(e.date)}
                          </div>
                        </div>
                        <span className="e-amt">
                          {fmtSigned(e.amountPoisha, e.type)}
                        </span>
                        <span className="e-actions">
                          <button
                            className="icon-btn"
                            type="button"
                            aria-label="সম্পাদনা করুন"
                            onClick={() => startEdit(e)}
                          >
                            <Icon d={ICON_EDIT} size={18} />
                          </button>
                          {confirmDeleteId === e.id ? (
                            <button
                              className="icon-btn confirm"
                              type="button"
                              aria-label="মুছে ফেলা নিশ্চিত করুন"
                              onClick={() => void handleDeleteClick(e)}
                            >
                              নিশ্চিত?
                            </button>
                          ) : (
                            <button
                              className="icon-btn danger"
                              type="button"
                              aria-label="মুছে ফেলুন"
                              onClick={() => void handleDeleteClick(e)}
                            >
                              <Icon d={ICON_TRASH} size={18} />
                            </button>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                ))
              )}
            </div>
            {filtered.length > 0 && (
              <div className="list-footer">
                <span>
                  দেখানো হচ্ছে <strong>{bnInt(filtered.length)}</strong>টি
                  এন্ট্রি
                </span>
                <span>
                  জমা <strong>{fmtMoney(sumEntries(filtered, "income"))}</strong>{" "}
                  · খরচ{" "}
                  <strong>{fmtMoney(sumEntries(filtered, "expense"))}</strong>
                </span>
              </div>
            )}
            <div className="data-tools">
              <button
                className="btn btn-outline btn-sm"
                type="button"
                onClick={handleExport}
              >
                <Icon d={ICON_DOWNLOAD} size={19} />
                হিসাব নামান (সিএসভি)
              </button>
              <button
                className="btn btn-outline btn-sm"
                type="button"
                disabled={importBusy}
                onClick={() => importRef.current?.click()}
              >
                <Icon d={ICON_UPLOAD} size={19} />
                সিএসভি থেকে আনুন
              </button>
              <input
                ref={importRef}
                type="file"
                accept=".csv,text/csv"
                aria-label="আমদানির সিএসভি ফাইল বেছে নিন"
                style={{ display: "none" }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleImportFile(file);
                  e.target.value = "";
                }}
              />
            </div>
          </section>
        </div>
      </div>

      {/* GitHub backup */}
      <section className="card panel backup-panel" aria-label="গিটহাব ব্যাকআপ">
        <div className="backup-head">
          <h2>
            <Icon
              d={
                <>
                  <path d="M4 14.9A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.24" />
                  <path d="M12 12v9" />
                  <path d="m16 16-4-4-4 4" />
                </>
              }
            />
            গিটহাব ব্যাকআপ
          </h2>
          <p className="sync-line">
            {ghStatus ||
              (ghConfigured(ghSaved)
                ? "অটো-ব্যাকআপ চালু আছে — বদল হলেই এনক্রিপ্টেড কপি হালনাগাদ হয়"
                : "")}
          </p>
        </div>
        <div className="backup-grid">
          <div className="field">
            <label htmlFor="ghRepoInput">
              গিটহাব রিপো{" "}
              <span className="field-status">
                {ghSaved.repo ? "সংরক্ষিত আছে" : ""}
              </span>
            </label>
            <input
              id="ghRepoInput"
              type="text"
              dir="ltr"
              autoComplete="off"
              placeholder="shabbirhsadhon/khorochpotro"
              value={ghRepo}
              onChange={(e) => setGhRepo(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="ghTokenInput">
              গিটহাব টোকেন{" "}
              <span className="field-status">
                {ghSaved.token ? "সংরক্ষিত আছে" : ""}
              </span>
            </label>
            <input
              id="ghTokenInput"
              type="password"
              autoComplete="off"
              placeholder="টোকেন বসান"
              value={ghTokenIn}
              onChange={(e) => setGhTokenIn(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="ghPassInput">
              পাসফ্রেজ{" "}
              <span className="field-status">
                {ghSaved.passphrase ? "সংরক্ষিত আছে" : ""}
              </span>
            </label>
            <input
              id="ghPassInput"
              type="password"
              autoComplete="new-password"
              placeholder="পাসফ্রেজ বসান"
              value={ghPassIn}
              onChange={(e) => setGhPassIn(e.target.value)}
            />
          </div>
        </div>
        <div className="backup-actions">
          <button
            className="btn btn-tonal btn-sm"
            type="button"
            onClick={saveGhToken}
          >
            টোকেন সংরক্ষণ করুন
          </button>
          {ghSaved.token && (
            <button
              className="btn btn-danger-ghost btn-sm"
              type="button"
              onClick={clearGhToken}
            >
              টোকেন মুছুন
            </button>
          )}
          <button
            className="btn btn-tonal btn-sm"
            type="button"
            onClick={saveGhPass}
          >
            পাসফ্রেজ সংরক্ষণ করুন
          </button>
          {ghSaved.passphrase && (
            <button
              className="btn btn-danger-ghost btn-sm"
              type="button"
              onClick={clearGhPass}
            >
              পাসফ্রেজ মুছুন
            </button>
          )}
          <span className="hint warn-line">
            পাসফ্রেজ ভুলে গেলে ব্যাকআপ ফেরত পাওয়া যাবে না।
          </span>
        </div>
        <div className="backup-actions">
          <button
            className="btn btn-primary btn-sm"
            type="button"
            disabled={ghBusy !== null}
            onClick={() => void handleBackupNow()}
          >
            {ghBusy === "backup" ? "ব্যাকআপ হচ্ছে…" : "এখনই ব্যাকআপ করুন"}
          </button>
          <button
            className="btn btn-outline btn-sm"
            type="button"
            disabled={ghBusy !== null}
            onClick={() => void handleRestore()}
          >
            {ghBusy === "restore" ? "আনা হচ্ছে…" : "ব্যাকআপ থেকে আনুন"}
          </button>
          <span className="hint">
            ব্যাকআপ থেকে আনলে এন্ট্রি বর্তমান হিসাবের সঙ্গে যোগ হয় — একই
            ব্যাকআপ দুইবার আনলে এন্ট্রি ডাবল হতে পারে। ব্যাকআপের বাজেটও ফেরত
            আসে।
          </span>
        </div>
        {ghStatus && (
          <p className="hint" role="status" style={{ margin: "8px 0 0" }}>
            {ghStatus}
          </p>
        )}
        <details className="help-details">
          <summary>টোকেন কীভাবে বানাবেন?</summary>
          <div className="help-body">
            <p>
              গিটহাব → Settings → Developer settings → Personal access tokens →
              Fine-grained → Repository access-এ শুধু আপনার ব্যাকআপ রিপোটা,
              Permissions-এ শুধু <strong>Contents: Read and write</strong> দিন।
              রিপোজিটরিটা Private রাখুন।
            </p>
            <p>
              টোকেন ও পাসফ্রেজ শুধু এই ডিভাইসেই থাকে। ব্যাকআপ গিটহাবে ওঠার আগে
              পাসফ্রেজ দিয়ে এনক্রিপ্ট হয় — সব ডিভাইসে একই পাসফ্রেজ বসান।
            </p>
          </div>
        </details>
      </section>

      {/* Project source code download */}
      <section className="card panel backup-panel" aria-label="প্রজেক্টের সোর্স কোড">
        <div className="backup-head">
          <h2>
            <Icon
              d={
                <>
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <path d="m7 10 5 5 5-5" />
                  <path d="M12 15V3" />
                </>
              }
            />
            প্রজেক্টের সোর্স কোড
          </h2>
          <p className="sync-line">{srcStatus}</p>
        </div>
        <p className="hint" style={{ margin: 0 }}>
          পুরো প্রজেক্টের সোর্স কোড একটা ZIP ফাইলে নামিয়ে নিন — আনজিপ করে
          GitHub রিপোতে পুশ করলেই হবে। আপনার হিসাবের ডেটাবেজ ZIP-এ যায় না,
          শুধু কোড যায়।
        </p>
        <div className="backup-actions">
          <button
            className="btn btn-primary btn-sm"
            type="button"
            disabled={srcBusy}
            onClick={() => void handleDownloadSource()}
          >
            {srcBusy ? "তৈরি হচ্ছে…" : "সোর্স কোডের ZIP ডাউনলোড করুন"}
          </button>
        </div>
      </section>

      {/* Account + logout at the bottom of the main page */}
      <section className="card account-panel" aria-label="অ্যাকাউন্ট">
        {logoutConfirm ? (
          <div className="logout-confirm">
            <p className="lc-title">সত্যিই লগআউট করবেন?</p>
            <p className="lc-sub">
              লগআউট করলে এই ডিভাইস থেকে লগইন সেভ মুছে যাবে — আবার ঢুকতে ইমেইল
              আর পাসওয়ার্ড লাগবে। আপনার হিসাব সার্ভারে থেকেই যাবে।
            </p>
            <div className="lc-actions">
              <button
                className="btn btn-outline"
                type="button"
                style={{ justifyContent: "center" }}
                onClick={() => setLogoutConfirm(false)}
              >
                থাক, লগইন থাকি
              </button>
              <button
                className="btn btn-danger-solid"
                type="button"
                onClick={onLogout}
              >
                হ্যাঁ, লগআউট
              </button>
            </div>
          </div>
        ) : (
          <button
            className="logout-btn"
            type="button"
            onClick={() => setLogoutConfirm(true)}
          >
            লগআউট
          </button>
        )}
        <p className="acc-email">
          {userName ? `${userName} · ` : ""}
          <span dir="ltr">{userEmail}</span> দিয়ে লগইন করা আছে — এই ডিভাইসে
          লগইন সেভ আছে, লগআউট না করা পর্যন্ত থাকবে
        </p>
      </section>

      <footer className="page">
        তৈরি করেছেন শাব্বির হোসেন সাধন ·{" "}
        <a
          href="https://github.com/shabbirhsadhon"
          target="_blank"
          rel="noopener noreferrer"
        >
          গিটহাব প্রোফাইল
        </a>
      </footer>

      <button
        className={`fab${listening ? " listening" : ""}`}
        type="button"
        aria-label="কণ্ঠ দিয়ে এন্ট্রি যোগ করুন"
        onClick={() => {
          voicePanelRef.current?.scrollIntoView({
            behavior: "smooth",
            block: "center",
          });
          if (!listening) startVoice();
        }}
      >
        <MicIcon size={30} />
      </button>

      {/* Period preview modal */}
      {previewKind && (
        <div
          className={`modal-overlay${previewShown ? " open" : ""}`}
          onClick={(e) => {
            if (e.target === e.currentTarget) closePreview();
          }}
        >
          <div
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="periodModalTitle"
          >
            <div className="modal-head">
              <div>
                <h3 id="periodModalTitle">{previewTitle}</h3>
                <p className="modal-sub">{previewSub}</p>
              </div>
              <button
                className="icon-btn modal-close"
                type="button"
                aria-label="বন্ধ করুন"
                onClick={closePreview}
              >
                <Icon
                  size={18}
                  d={
                    <>
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </>
                  }
                />
              </button>
            </div>
            <div className="modal-total">
              <span>মোট খরচ</span>
              <strong
                style={{
                  color:
                    previewExp > previewInc
                      ? "var(--expense)"
                      : "var(--income)",
                }}
              >
                {fmtMoney(previewExp)}
              </strong>
            </div>
            {showDonut ? (
              <div className="modal-chart">
                <div className="donut-box">
                  <svg
                    viewBox="-8 -8 184 184"
                    role="img"
                    aria-label={
                      previewKind === "month"
                        ? "জমা ও খরচের পাই চার্ট — সবুজ অংশ জমা, লাল অংশ খরচ"
                        : "ক্যাটাগরি অনুযায়ী খরচের ছোট চার্ট"
                    }
                    onPointerDown={(e) => {
                      pieDragging.current = true;
                      try {
                        e.currentTarget.setPointerCapture(e.pointerId);
                      } catch {
                        // capture is a nicety only
                      }
                      const seg = pieSegAtPoint(
                        e.clientX,
                        e.clientY,
                        e.currentTarget,
                      );
                      if (!seg) {
                        setPieSel(null);
                        setPiePinned(false);
                        return;
                      }
                      togglePieSel({ type: seg.type, cat: seg.cat });
                    }}
                    onPointerMove={(e) => {
                      if (e.pointerType !== "mouse" && !pieDragging.current)
                        return;
                      const seg = pieSegAtPoint(
                        e.clientX,
                        e.clientY,
                        e.currentTarget,
                      );
                      if (seg) {
                        const sel: PieSel = { type: seg.type, cat: seg.cat };
                        if (!sameSel(pieSel, sel)) {
                          setPieSel(sel);
                          if (pieDragging.current) setPiePinned(true);
                        }
                      } else if (!piePinned) {
                        setPieSel(null);
                      }
                    }}
                    onPointerUp={() => {
                      pieDragging.current = false;
                    }}
                    onPointerCancel={() => {
                      pieDragging.current = false;
                    }}
                    onPointerLeave={() => {
                      if (!piePinned) setPieSel(null);
                    }}
                  >
                    {previewKind === "month" && (
                      <circle
                        cx="84"
                        cy="84"
                        r="70"
                        fill="none"
                        stroke="#7d8f85"
                        strokeOpacity="0.25"
                        strokeWidth="26"
                      />
                    )}
                    {pieSegs.map((seg, i) => {
                      const frac = seg.end - seg.start;
                      const len =
                        frac >= 1
                          ? PIE_C
                          : Math.max(frac * PIE_C - 2.5, 0.5);
                      const on = segMatches(seg);
                      return (
                        <circle
                          key={i}
                          className={`pie-slice${pieSel ? (on ? " hl" : " dim") : ""}`}
                          cx="84"
                          cy="84"
                          r="70"
                          fill="none"
                          style={{ stroke: seg.color }}
                          strokeWidth="26"
                          strokeDasharray={`${len.toFixed(2)} ${PIE_C.toFixed(2)}`}
                          strokeDashoffset={(-seg.start * PIE_C).toFixed(2)}
                        >
                          <title>
                            {seg.label}: {fmtMoney(seg.val)}
                          </title>
                        </circle>
                      );
                    })}
                  </svg>
                  <div className="donut-center">
                    <span className="dc-lbl">{centerLbl}</span>
                    <span className="dc-val">{centerVal}</span>
                  </div>
                </div>
                <div className="legend">
                  {previewKind === "month"
                    ? [
                        legendRow(
                          "pie-inc",
                          { type: "income", cat: null },
                          "var(--income)",
                          "জমা",
                          previewInc,
                          previewInc + previewExp,
                        ),
                        legendRow(
                          "pie-exp",
                          { type: "expense", cat: null },
                          "var(--expense)",
                          "খরচ",
                          previewExp,
                          previewInc + previewExp,
                        ),
                      ]
                    : pieSegs.map((seg) =>
                        legendRow(
                          `pie-${seg.cat ?? ""}`,
                          { type: "expense", cat: seg.cat },
                          seg.color,
                          seg.label,
                          seg.val,
                          previewExp,
                        ),
                      )}
                </div>
              </div>
            ) : (
              <div className="empty-note">
                {previewKind === "month"
                  ? "এই মাসে এখনো কোনো জমা বা খরচ নেই।"
                  : "এই সময়ে এখনো কোনো খরচ নেই।"}
              </div>
            )}
            <div>
              {previewKind === "month" && showDonut && (
                <>
                  {categoryRowsJsx(previewList, "income")}
                  {categoryRowsJsx(previewList, "expense")}
                </>
              )}
              {previewSorted.length > 0 && (
                <>
                  <div className="modal-sec">এন্ট্রিগুলো</div>
                  {previewSorted.map((e) => {
                    const m = elMatches(e.type, e.category);
                    return (
                      <div
                        key={e.id}
                        className={`modal-entry${pieSel ? (m ? "" : " dim") : ""}`}
                        role="button"
                        tabIndex={0}
                        onClick={() =>
                          togglePieSel({ type: e.type, cat: e.category })
                        }
                        onKeyDown={(ev) => {
                          if (ev.key === "Enter" || ev.key === " ") {
                            ev.preventDefault();
                            togglePieSel({ type: e.type, cat: e.category });
                          }
                        }}
                      >
                        <span className="m-desc">
                          {e.description}
                          <span className="m-meta">
                            {e.category} · {dayLabel(e.date)}
                          </span>
                        </span>
                        <span className={`m-amt ${e.type}`}>
                          {fmtSigned(e.amountPoisha, e.type)}
                        </span>
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div id="toast" role="status" className={toastShown ? "show" : ""}>
          <span>{toast.msg}</span>
          {toast.actionLabel && toast.onAction && (
            <button
              type="button"
              onClick={() => {
                toast.onAction?.();
                setToastShown(false);
                setToast(null);
              }}
            >
              {toast.actionLabel}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
