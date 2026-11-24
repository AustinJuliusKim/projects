-- 0016_credit_redeem: spending store credit gets its own permission and a
-- cashier limit (docs/AUTH_PLAN.md, open question "credit/redeem is pos.sell").
--
-- Why it looks like this:
--   * Redeem was guarded by pos.sell, so anyone who could sell could spend
--     any customer's credit down, with no limit and no approval. It is now
--     credit.redeem, which approval_policy can refine like credit.adjust.
--   * Nobody loses access: every role that holds pos.sell today (system
--     roles and stores' custom roles) is granted credit.redeem.
--   * Default for cashiers: redeem directly up to $50.00 (mode allow,
--     limit_cents 5000); above that, a manager's PIN approval bound to the
--     request. A store's own approval_policy row overrides it.
--   * permission, role_permission and approval_policy FORCE row-level
--     security and have no write policies (seed tables). The migrating role
--     owns them, so it lifts FORCE for this transaction's seed rows and puts
--     it back; nothing commits without FORCE.

ALTER TABLE permission NO FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permission NO FORCE ROW LEVEL SECURITY;
ALTER TABLE approval_policy NO FORCE ROW LEVEL SECURITY;

INSERT INTO permission (key, description) VALUES
    ('credit.redeem', 'Spend a customer''s store credit');

INSERT INTO role_permission (role_id, perm)
SELECT rp.role_id, 'credit.redeem' FROM role_permission rp WHERE rp.perm = 'pos.sell';

INSERT INTO approval_policy (tenant_id, role_id, perm, mode, limit_cents)
SELECT NULL, r.id, 'credit.redeem', 'allow', 5000 FROM role r
WHERE r.tenant_id IS NULL AND r.key = 'cashier';

ALTER TABLE permission FORCE ROW LEVEL SECURITY;
ALTER TABLE role_permission FORCE ROW LEVEL SECURITY;
ALTER TABLE approval_policy FORCE ROW LEVEL SECURITY;
