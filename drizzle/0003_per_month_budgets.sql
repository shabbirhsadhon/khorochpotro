CREATE TABLE budget_months (
  user_id INTEGER NOT NULL REFERENCES users(id),
  month TEXT NOT NULL,
  monthly_poisha INTEGER NOT NULL,
  PRIMARY KEY (user_id, month)
);
