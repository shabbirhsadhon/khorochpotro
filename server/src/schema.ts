// Drizzle schema for খরচপত্র মাল্টি-ইউজার.
//
// Multi-user model: every expense row belongs to exactly one user
// (entries.user_id -> users.id) and every read/write is scoped by the
// session's user, so one user's ledger is never visible to another.
// Passwords are stored only as salted PBKDF2 hashes (see actions.ts).

import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable(
  "users",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    name: text("name").notNull().default(""),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [uniqueIndex("users_email_unique").on(t.email)],
);

export const sessions = sqliteTable("sessions", {
  token: text("token").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
});

export const entries = sqliteTable("entries", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  // Calendar day of the transaction, YYYY-MM-DD, in the user's local terms.
  date: text("date").notNull(),
  type: text("type", { enum: ["expense", "income"] }).notNull(),
  category: text("category").notNull(),
  description: text("description").notNull().default(""),
  // Amount in poisha (1 taka = 100 poisha) so money math stays integer-exact.
  amountPoisha: integer("amount_poisha").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const budgets = sqliteTable("budgets", {
  userId: integer("user_id")
    .primaryKey()
    .references(() => users.id),
  monthlyPoisha: integer("monthly_poisha").notNull(),
});

// Per-month budgets, as in the original single-user app: each calendar
// month can carry its own budget. The legacy `budgets` row (one budget
// for every month) still applies to months without their own row.
export const budgetMonths = sqliteTable("budget_months", {
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  // Calendar month, YYYY-MM.
  month: text("month").notNull(),
  monthlyPoisha: integer("monthly_poisha").notNull(),
});
