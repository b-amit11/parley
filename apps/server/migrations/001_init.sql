CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username      text NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9_]{3,32}$'),
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Random session tokens; only their SHA-256 hash is stored.
CREATE TABLE sessions (
  token_hash bytea PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE workspaces (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  created_by uuid NOT NULL REFERENCES users,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  role         text NOT NULL CHECK (role IN ('owner', 'member')),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX workspace_members_user_idx ON workspace_members (user_id);

-- last_seq is the per-channel sequence. Incrementing it takes the row lock that serializes
-- sends within one channel.
CREATE TABLE channels (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('public', 'private', 'dm')),
  name         text CHECK (name ~ '^[a-z0-9][a-z0-9_-]{0,79}$'),
  dm_key       text, -- the two user ids, sorted, so each pair has exactly one DM channel
  last_seq     bigint NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name),
  UNIQUE (workspace_id, dm_key),
  CHECK ((kind = 'dm') = (dm_key IS NOT NULL)),
  CHECK ((kind = 'dm') = (name IS NULL))
);

CREATE TABLE channel_members (
  channel_id uuid NOT NULL REFERENCES channels ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  joined_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX channel_members_user_idx ON channel_members (user_id);

CREATE TABLE messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id    uuid NOT NULL REFERENCES channels ON DELETE CASCADE,
  seq           bigint NOT NULL,
  sender_id     uuid NOT NULL REFERENCES users,
  client_msg_id uuid NOT NULL,
  body          text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id, seq),          -- total order per channel; also the history/sync index
  UNIQUE (sender_id, client_msg_id)  -- makes retried sends idempotent
);

CREATE TABLE read_cursors (
  user_id       uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  channel_id    uuid NOT NULL REFERENCES channels ON DELETE CASCADE,
  last_read_seq bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, channel_id)
);
