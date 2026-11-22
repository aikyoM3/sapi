-- Persist route cooldowns so repeated batch jobs do not keep sending requests
-- to a provider/model group that is already timing out.
CREATE TABLE IF NOT EXISTS gemini_route_cooldown (
  user_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  route_index INTEGER NOT NULL CHECK (route_index >= 0),
  route_count INTEGER NOT NULL CHECK (route_count > 0),
  blocked_until TIMESTAMPTZ NOT NULL,
  reason VARCHAR(100) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, route_index)
);

CREATE INDEX IF NOT EXISTS idx_gemini_route_cooldown_active
  ON gemini_route_cooldown (user_id, blocked_until);
