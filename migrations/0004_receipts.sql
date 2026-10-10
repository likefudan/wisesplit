-- A photo of an expense's receipt, at most one per expense. The image itself is in the R2 bucket
-- (binding RECEIPTS) under `object_key`; this row is what makes it part of the expense. Objects
-- without a row (an upload that failed halfway, a deleted group) are removed by the daily clean-up
-- (src/worker/receipts.ts).
CREATE TABLE receipts (
  expense_id TEXT PRIMARY KEY REFERENCES expenses (id) ON DELETE CASCADE,
  -- Random, new for each photo; the pages put it in the photo's address so a replaced one reloads.
  id TEXT NOT NULL UNIQUE,
  -- receipts/<group id>/<expense id>/<id>.jpg
  object_key TEXT NOT NULL UNIQUE,
  size INTEGER NOT NULL,
  uploaded_by TEXT NOT NULL REFERENCES users (id),
  uploaded_at TEXT NOT NULL
);
