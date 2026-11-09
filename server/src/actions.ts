// Actions for খরচপত্র মাল্টি-ইউজার.
//
// Auth model: email + password. Passwords are never stored in plain
// text — each user row keeps a salted PBKDF2-SHA256 hash
// ("pbkdf2$<iterations>$<salt b64>$<hash b64>"). Login issues a random
// session token that the client keeps in localStorage and passes with
// every data action; each handler resolves the token to a user and
// scopes every query by that user_id, so accounts are fully isolated
// from each other. Sessions are effectively permanent: the TTL is
// long and every authed call slides it forward, so a session only
// ends when the user explicitly logs out (or after ~400 idle days).

import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { Privileged } from "@space/privileged";
import { and, asc, desc, eq, gte, lt } from "drizzle-orm";
import * as schema from "./schema";

const SESSION_TTL_MS = 400 * 24 * 60 * 60 * 1000;

type Db = ReturnType<Ctx["db"]>;

async function userForToken(db: Db, token: string) {
  if (!token) return null;
  const rows = await db
    .select({ user: schema.users })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
    .where(eq(schema.sessions.token, token))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const sessionRows = await db
    .select({ expiresAt: schema.sessions.expiresAt })
    .from(schema.sessions)
    .where(eq(schema.sessions.token, token))
    .limit(1);
  const expiresAt = sessionRows[0]?.expiresAt;
  if (!expiresAt || expiresAt.getTime() < Date.now()) {
    await db.delete(schema.sessions).where(eq(schema.sessions.token, token));
    return null;
  }
  // Sliding renewal: any authed activity pushes the expiry a full TTL
  // into the future, so the user stays logged in on this device until
  // they explicitly log out.
  if (expiresAt.getTime() - Date.now() < SESSION_TTL_MS / 2) {
    await db
      .update(schema.sessions)
      .set({ expiresAt: new Date(Date.now() + SESSION_TTL_MS) })
      .where(eq(schema.sessions.token, token));
  }
  return row.user;
}

async function createSession(
  ctx: Ctx,
  db: Db,
  userId: number,
): Promise<string> {
  const { token } = await ctx.executePrivileged(Privileged.newSessionToken, {});
  const now = new Date();
  await db.insert(schema.sessions).values({
    token,
    userId,
    createdAt: now,
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
  });
  return token;
}

const authResult = z.object({
  ok: z.boolean(),
  token: z.string(),
  user: z.object({ email: z.string(), name: z.string() }).nullable(),
  error: z.string(),
});

const entryShape = z.object({
  id: z.number(),
  date: z.string(),
  type: z.enum(["expense", "income"]),
  category: z.string(),
  description: z.string(),
  amountPoisha: z.number(),
});

const dateRe = /^\d{4}-\d{2}-\d{2}$/;
const monthRe = /^\d{4}-\d{2}$/;

function nextMonth(month: string): string {
  const [y = 1970, m = 1] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 1));
  const yy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${yy}-${mm}`;
}

const entryInput = {
  date: z.string().regex(dateRe),
  type: z.enum(["expense", "income"]),
  category: z.string().min(1).max(60),
  description: z.string().max(300).default(""),
  amountPoisha: z.number().int().positive().max(1_000_000_000_00),
};

export const Actions = {
  register: defineAction({
    description:
      "Creates a new user account with email and password and returns a session token.",
    request: z.object({
      email: z.string().email().max(200),
      password: z.string().min(6).max(200),
      name: z.string().max(80).default(""),
    }),
    response: authResult,
    privileged: [Privileged.hashPassword, Privileged.newSessionToken],
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const email = args.email.trim().toLowerCase();
      const existing = await db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.email, email))
        .limit(1);
      if (existing.length > 0) {
        return {
          ok: false,
          token: "",
          user: null,
          error: "এই ইমেইল দিয়ে আগেই অ্যাকাউন্ট খোলা আছে — লগইন করুন",
        };
      }
      const { stored } = await ctx.executePrivileged(Privileged.hashPassword, {
        password: args.password,
      });
      const inserted = await db
        .insert(schema.users)
        .values({
          email,
          passwordHash: stored,
          name: args.name.trim(),
        })
        .returning({ id: schema.users.id });
      const userId = inserted[0]?.id;
      if (!userId) throw new Error("register: insert returned no rows");
      const token = await createSession(ctx, db, userId);
      return {
        ok: true,
        token,
        user: { email, name: args.name.trim() },
        error: "",
      };
    },
  }),

  login: defineAction({
    description:
      "Logs an existing user in with email and password and returns a session token.",
    request: z.object({
      email: z.string().email().max(200),
      password: z.string().min(1).max(200),
    }),
    response: authResult,
    privileged: [Privileged.verifyPassword, Privileged.newSessionToken],
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const email = args.email.trim().toLowerCase();
      const rows = await db
        .select()
        .from(schema.users)
        .where(eq(schema.users.email, email))
        .limit(1);
      const user = rows[0];
      const verified = user
        ? await ctx.executePrivileged(Privileged.verifyPassword, {
            password: args.password,
            stored: user.passwordHash,
          })
        : { ok: false };
      if (!user || !verified.ok) {
        return {
          ok: false,
          token: "",
          user: null,
          error: "ইমেইল বা পাসওয়ার্ড মিলছে না",
        };
      }
      const token = await createSession(ctx, db, user.id);
      return {
        ok: true,
        token,
        user: { email: user.email, name: user.name },
        error: "",
      };
    },
  }),

  me: defineAction({
    description: "Returns the user behind a session token, or null when logged out.",
    request: z.object({ token: z.string().max(200) }),
    response: z.object({
      user: z.object({ email: z.string(), name: z.string() }).nullable(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const user = await userForToken(db, args.token);
      return {
        user: user ? { email: user.email, name: user.name } : null,
      };
    },
  }),

  logout: defineAction({
    description: "Ends the session for the given token.",
    request: z.object({ token: z.string().max(200) }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      if (args.token) {
        await db.delete(schema.sessions).where(eq(schema.sessions.token, args.token));
      }
      return { ok: true as const };
    },
  }),

  getMonth: defineAction({
    description:
      "Returns one month's entries plus income/expense/balance totals, the monthly budget, and per-category expense totals for the session user.",
    request: z.object({
      token: z.string().max(200),
      month: z.string().regex(monthRe),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.string(),
      entries: z.array(entryShape),
      totalIncomePoisha: z.number(),
      totalExpensePoisha: z.number(),
      budgetPoisha: z.number(),
      categoryTotals: z.array(
        z.object({ category: z.string(), totalPoisha: z.number() }),
      ),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const user = await userForToken(db, args.token);
      if (!user) {
        return {
          ok: false,
          error: "আবার লগইন করুন",
          entries: [],
          totalIncomePoisha: 0,
          totalExpensePoisha: 0,
          budgetPoisha: 0,
          categoryTotals: [],
        };
      }
      const rows = await db
        .select()
        .from(schema.entries)
        .where(
          and(
            eq(schema.entries.userId, user.id),
            gte(schema.entries.date, `${args.month}-01`),
            lt(schema.entries.date, `${nextMonth(args.month)}-01`),
          ),
        )
        .orderBy(desc(schema.entries.date), desc(schema.entries.id));
      let totalIncome = 0;
      let totalExpense = 0;
      const byCategory = new Map<string, number>();
      for (const row of rows) {
        if (row.type === "income") totalIncome += row.amountPoisha;
        else {
          totalExpense += row.amountPoisha;
          byCategory.set(
            row.category,
            (byCategory.get(row.category) ?? 0) + row.amountPoisha,
          );
        }
      }
      const budgetRows = await db
        .select()
        .from(schema.budgets)
        .where(eq(schema.budgets.userId, user.id))
        .limit(1);
      const monthBudgetRows = await db
        .select()
        .from(schema.budgetMonths)
        .where(
          and(
            eq(schema.budgetMonths.userId, user.id),
            eq(schema.budgetMonths.month, args.month),
          ),
        )
        .limit(1);
      return {
        ok: true,
        error: "",
        entries: rows.map((row) => ({
          id: row.id,
          date: row.date,
          type: row.type,
          category: row.category,
          description: row.description,
          amountPoisha: row.amountPoisha,
        })),
        totalIncomePoisha: totalIncome,
        totalExpensePoisha: totalExpense,
        budgetPoisha:
          monthBudgetRows[0]?.monthlyPoisha ??
          budgetRows[0]?.monthlyPoisha ??
          0,
        categoryTotals: [...byCategory.entries()]
          .map(([category, totalPoisha]) => ({ category, totalPoisha }))
          .sort((a, b) => b.totalPoisha - a.totalPoisha),
      };
    },
  }),

  addEntry: defineAction({
    description: "Adds one expense or income entry to the session user's ledger.",
    request: z.object({ token: z.string().max(200), ...entryInput }),
    response: z.object({ ok: z.boolean(), error: z.string(), id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const user = await userForToken(db, args.token);
      if (!user) return { ok: false, error: "আবার লগইন করুন", id: 0 };
      const inserted = await db
        .insert(schema.entries)
        .values({
          userId: user.id,
          date: args.date,
          type: args.type,
          category: args.category.trim(),
          description: args.description.trim(),
          amountPoisha: args.amountPoisha,
        })
        .returning({ id: schema.entries.id });
      const id = inserted[0]?.id;
      if (!id) throw new Error("addEntry: insert returned no rows");
      ctx.invalidateQueries();
      return { ok: true, error: "", id };
    },
  }),

  updateEntry: defineAction({
    description: "Edits one of the session user's entries by id.",
    request: z.object({
      token: z.string().max(200),
      id: z.number().int().positive(),
      ...entryInput,
    }),
    response: z.object({ ok: z.boolean(), error: z.string() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const user = await userForToken(db, args.token);
      if (!user) return { ok: false, error: "আবার লগইন করুন" };
      const updated = await db
        .update(schema.entries)
        .set({
          date: args.date,
          type: args.type,
          category: args.category.trim(),
          description: args.description.trim(),
          amountPoisha: args.amountPoisha,
        })
        .where(
          and(
            eq(schema.entries.id, args.id),
            eq(schema.entries.userId, user.id),
          ),
        )
        .returning({ id: schema.entries.id });
      if (updated.length === 0) {
        return { ok: false, error: "এন্ট্রিটি পাওয়া যায়নি" };
      }
      ctx.invalidateQueries();
      return { ok: true, error: "" };
    },
  }),

  deleteEntry: defineAction({
    description: "Deletes one of the session user's entries by id.",
    request: z.object({
      token: z.string().max(200),
      id: z.number().int().positive(),
    }),
    response: z.object({ ok: z.boolean(), error: z.string() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const user = await userForToken(db, args.token);
      if (!user) return { ok: false, error: "আবার লগইন করুন" };
      await db
        .delete(schema.entries)
        .where(
          and(
            eq(schema.entries.id, args.id),
            eq(schema.entries.userId, user.id),
          ),
        );
      ctx.invalidateQueries();
      return { ok: true, error: "" };
    },
  }),

  setBudget: defineAction({
    description:
      "Sets the session user's budget in poisha — for one calendar month when `month` (YYYY-MM) is given, otherwise the legacy every-month budget. A per-month amount of 0 clears that month's own budget.",
    request: z.object({
      token: z.string().max(200),
      monthlyPoisha: z.number().int().min(0).max(1_000_000_000_00),
      month: z.string().regex(monthRe).optional(),
    }),
    response: z.object({ ok: z.boolean(), error: z.string() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const user = await userForToken(db, args.token);
      if (!user) return { ok: false, error: "আবার লগইন করুন" };
      if (args.month) {
        if (args.monthlyPoisha <= 0) {
          await db
            .delete(schema.budgetMonths)
            .where(
              and(
                eq(schema.budgetMonths.userId, user.id),
                eq(schema.budgetMonths.month, args.month),
              ),
            );
        } else {
          const existing = await db
            .select()
            .from(schema.budgetMonths)
            .where(
              and(
                eq(schema.budgetMonths.userId, user.id),
                eq(schema.budgetMonths.month, args.month),
              ),
            )
            .limit(1);
          if (existing.length > 0) {
            await db
              .update(schema.budgetMonths)
              .set({ monthlyPoisha: args.monthlyPoisha })
              .where(
                and(
                  eq(schema.budgetMonths.userId, user.id),
                  eq(schema.budgetMonths.month, args.month),
                ),
              );
          } else {
            await db.insert(schema.budgetMonths).values({
              userId: user.id,
              month: args.month,
              monthlyPoisha: args.monthlyPoisha,
            });
          }
        }
      } else {
        await db
          .insert(schema.budgets)
          .values({ userId: user.id, monthlyPoisha: args.monthlyPoisha })
          .onConflictDoUpdate({
            target: schema.budgets.userId,
            set: { monthlyPoisha: args.monthlyPoisha },
          });
      }
      ctx.invalidateQueries();
      return { ok: true, error: "" };
    },
  }),

  importEntries: defineAction({
    description:
      "Imports a batch of parsed entries (from the old single-user app's CSV export) into the session user's ledger.",
    request: z.object({
      token: z.string().max(200),
      entries: z
        .array(
          z.object({
            date: z.string().regex(dateRe),
            type: z.enum(["expense", "income"]),
            category: z.string().min(1).max(60),
            description: z.string().max(300).default(""),
            amountPoisha: z.number().int().positive().max(1_000_000_000_00),
          }),
        )
        .max(5000),
    }),
    response: z.object({
      ok: z.boolean(),
      error: z.string(),
      imported: z.number(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const user = await userForToken(db, args.token);
      if (!user) return { ok: false, error: "আবার লগইন করুন", imported: 0 };
      if (args.entries.length > 0) {
        await db.insert(schema.entries).values(
          args.entries.map((e) => ({
            userId: user.id,
            date: e.date,
            type: e.type,
            category: e.category.trim(),
            description: e.description.trim(),
            amountPoisha: e.amountPoisha,
          })),
        );
      }
      ctx.invalidateQueries();
      return { ok: true, error: "", imported: args.entries.length };
    },
  }),

  exportSourceArchive: defineAction({
    description:
      "Builds a downloadable ZIP archive of the whole project source code (client, server, migrations, config) for the signed-in user, so it can be pushed to GitHub. User data (the database) is never included.",
    request: z.object({ token: z.string().max(200) }),
    response: z.object({
      ok: z.boolean(),
      error: z.string(),
      filename: z.string(),
      base64: z.string(),
      fileCount: z.number(),
    }),
    privileged: [Privileged.exportSourceArchive],
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const user = await userForToken(db, args.token);
      if (!user) {
        return {
          ok: false,
          error: "আবার লগইন করুন",
          filename: "",
          base64: "",
          fileCount: 0,
        };
      }
      const res = await ctx.executePrivileged(
        Privileged.exportSourceArchive,
        {},
      );
      if (!res.ok) {
        return {
          ok: false,
          error: "সোর্স কোডের আর্কাইভ তৈরি করা যায়নি",
          filename: "",
          base64: "",
          fileCount: 0,
        };
      }
      return {
        ok: true,
        error: "",
        filename: res.filename,
        base64: res.base64,
        fileCount: res.fileCount,
      };
    },
  }),

  listAllEntries: defineAction({
    description:
      "Returns all of the session user's entries, oldest first, plus their legacy every-month budget and every per-month budget, for the ledger view, CSV export, and the encrypted GitHub backup payload.",
    request: z.object({ token: z.string().max(200) }),
    response: z.object({
      ok: z.boolean(),
      error: z.string(),
      entries: z.array(entryShape),
      budgetPoisha: z.number(),
      budgets: z.array(
        z.object({ month: z.string(), monthlyPoisha: z.number() }),
      ),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const user = await userForToken(db, args.token);
      if (!user)
        return {
          ok: false,
          error: "আবার লগইন করুন",
          entries: [],
          budgetPoisha: 0,
          budgets: [],
        };
      const rows = await db
        .select()
        .from(schema.entries)
        .where(eq(schema.entries.userId, user.id))
        .orderBy(asc(schema.entries.date), asc(schema.entries.id));
      const budgetRows = await db
        .select()
        .from(schema.budgets)
        .where(eq(schema.budgets.userId, user.id))
        .limit(1);
      const monthBudgetRows = await db
        .select()
        .from(schema.budgetMonths)
        .where(eq(schema.budgetMonths.userId, user.id))
        .orderBy(asc(schema.budgetMonths.month));
      return {
        ok: true,
        error: "",
        budgetPoisha: budgetRows[0]?.monthlyPoisha ?? 0,
        budgets: monthBudgetRows.map((row) => ({
          month: row.month,
          monthlyPoisha: row.monthlyPoisha,
        })),
        entries: rows.map((row) => ({
          id: row.id,
          date: row.date,
          type: row.type,
          category: row.category,
          description: row.description,
          amountPoisha: row.amountPoisha,
        })),
      };
    },
  }),
} satisfies ActionsModule;
