-- 报告可关联到合并请求，支持多 MR 并行聚合与整库 CI 报告优先。

ALTER TABLE public.reports
  ADD COLUMN IF NOT EXISTS merge_request_id uuid REFERENCES public.merge_requests(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS reports_app_kind_mr_idx
  ON public.reports (app_id, kind, merge_request_id, created_at DESC);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'schema_migrations') THEN
    INSERT INTO public.schema_migrations(filename) VALUES ('0033_sdf_19_report_mr_scope.sql') ON CONFLICT DO NOTHING;
  END IF;
END $$;
