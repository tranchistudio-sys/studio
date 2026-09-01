-- Schema-only prerequisite for the runtime-managed wedding card module.
-- The canonical route creates this table lazily; tenant migration 0003 extends it.
-- No business or Amazing-specific rows are inserted here.
CREATE TABLE IF NOT EXISTS wedding_cards (
  id serial PRIMARY KEY
);
