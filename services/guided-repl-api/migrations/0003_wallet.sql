-- Append-only wallet ledger: balance = SUM, never mutable. The only escape
-- hatch is the transaction-local app.gdpr_delete setting used by account
-- deletion (GDPR purge) — set via set_config('app.gdpr_delete','on',true).

CREATE TABLE wallet_ledger (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id),
  type text NOT NULL CHECK (type IN ('topup', 'usage', 'unlock', 'refund')),
  amount_cents integer NOT NULL,
  ref text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX wallet_ledger_user_id_idx ON wallet_ledger (user_id);

CREATE FUNCTION wallet_ledger_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'wallet_ledger is append-only';
  END IF;
  -- DELETE: allowed only inside a GDPR account-deletion transaction.
  IF current_setting('app.gdpr_delete', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'wallet_ledger is append-only (account deletion sets app.gdpr_delete)';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER wallet_ledger_append_only
  BEFORE UPDATE OR DELETE ON wallet_ledger
  FOR EACH ROW EXECUTE FUNCTION wallet_ledger_append_only();

CREATE VIEW wallet_balances AS
  SELECT user_id, COALESCE(SUM(amount_cents), 0)::bigint AS balance_cents
  FROM wallet_ledger
  GROUP BY user_id;
