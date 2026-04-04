-- ── press_releases ────────────────────────────────────────────────────────────
CREATE TABLE press_releases (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  business_id        UUID        NOT NULL REFERENCES business_profiles(id) ON DELETE CASCADE,
  generated_page_id  UUID        REFERENCES generated_pages(id) ON DELETE SET NULL,
  keyword            TEXT        NOT NULL,
  location           TEXT        NOT NULL,
  page_title         TEXT        NOT NULL DEFAULT '',
  page_url           TEXT,
  status             TEXT        NOT NULL DEFAULT 'pending_user_approval'
                                 CHECK (status IN (
                                   'pending_user_approval',
                                   'submitted',
                                   'syndicated',
                                   'report_uploaded'
                                 )),
  content_html       TEXT,
  user_feedback      TEXT,
  generation_count   INTEGER     NOT NULL DEFAULT 1,
  submitted_at       TIMESTAMPTZ,
  syndicated_at      TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── press_release_reports ─────────────────────────────────────────────────────
CREATE TABLE press_release_reports (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  press_release_id    UUID        NOT NULL REFERENCES press_releases(id) ON DELETE CASCADE,
  pdf_url             TEXT        NOT NULL,
  pdf_filename        TEXT        NOT NULL DEFAULT '',
  uploaded_by         UUID        REFERENCES auth.users(id),
  uploaded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Storage bucket ────────────────────────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public)
VALUES ('press-release-reports', 'press-release-reports', false)
ON CONFLICT DO NOTHING;

-- ── RLS ───────────────────────────────────────────────────────────────────────
ALTER TABLE press_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE press_release_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "pr_select"
  ON press_releases FOR SELECT
  USING (
    auth.uid() = user_id
    OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

CREATE POLICY "pr_insert"
  ON press_releases FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "pr_update"
  ON press_releases FOR UPDATE
  USING (
    auth.uid() = user_id
    OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

CREATE POLICY "pr_delete"
  ON press_releases FOR DELETE
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

CREATE POLICY "prr_select"
  ON press_release_reports FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM press_releases
      WHERE press_releases.id = press_release_id
      AND press_releases.user_id = auth.uid()
    )
    OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

CREATE POLICY "prr_insert"
  ON press_release_reports FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

CREATE POLICY "prr_update"
  ON press_release_reports FOR UPDATE
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

CREATE POLICY "prr_delete"
  ON press_release_reports FOR DELETE
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- Storage: admins upload, authenticated users can read (URL security via DB RLS)
CREATE POLICY "storage_pr_admin_upload"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'press-release-reports'
    AND EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

CREATE POLICY "storage_pr_read"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'press-release-reports'
    AND auth.role() = 'authenticated'
  );

CREATE POLICY "storage_pr_admin_delete"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'press-release-reports'
    AND EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );
