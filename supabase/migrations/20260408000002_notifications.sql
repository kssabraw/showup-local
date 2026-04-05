CREATE TABLE notifications (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_by     UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  related_pr_id  UUID        REFERENCES press_releases(id) ON DELETE SET NULL,
  title          TEXT        NOT NULL,
  body           TEXT        NOT NULL DEFAULT '',
  read           BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- Users can read and mark-read their own notifications
CREATE POLICY "notif_select"
  ON notifications FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "notif_update"
  ON notifications FOR UPDATE
  USING (auth.uid() = user_id);

-- Admins can do everything
CREATE POLICY "notif_admin_all"
  ON notifications FOR ALL
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));
