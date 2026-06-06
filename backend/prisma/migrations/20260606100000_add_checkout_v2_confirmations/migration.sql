CREATE TYPE checkout_v2_confirmation_status AS ENUM ('RESERVED', 'CONFIRMED', 'FAILED');

CREATE TABLE checkout_v2_confirmations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id varchar(120) NOT NULL,
  command_id varchar(120),
  sale_id uuid,
  status checkout_v2_confirmation_status NOT NULL DEFAULT 'RESERVED',
  payload_hash varchar(128) NOT NULL,
  error_code varchar(120),
  created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX checkout_v2_confirmations_draft_id_key
ON checkout_v2_confirmations (draft_id);

CREATE UNIQUE INDEX checkout_v2_confirmations_command_id_key
ON checkout_v2_confirmations (command_id);

CREATE INDEX checkout_v2_confirmations_status_created_idx
ON checkout_v2_confirmations (status, created_at);

CREATE INDEX checkout_v2_confirmations_sale_id_idx
ON checkout_v2_confirmations (sale_id);
