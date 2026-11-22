-- Routes after the primary pair are probed with a tiny request after a quota
-- failure, before another invoice image is sent to them.
CREATE TABLE IF NOT EXISTS gemini_route_probe (
  user_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  route_index INTEGER NOT NULL CHECK (route_index >= 2),
  route_count INTEGER NOT NULL CHECK (route_count > 0),
  reason VARCHAR(100) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, route_index)
);
