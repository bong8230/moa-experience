CREATE TABLE IF NOT EXISTS moa_store (
  scope text NOT NULL,
  owner text NOT NULL DEFAULT '',
  key text NOT NULL,
  value jsonb NOT NULL,
  expires bigint,
  PRIMARY KEY (scope, owner, key)
);
CREATE INDEX IF NOT EXISTS moa_store_expires ON moa_store (expires) WHERE expires IS NOT NULL;
