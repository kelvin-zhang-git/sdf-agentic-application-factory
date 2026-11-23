-- 阶段 1：合并请求认领后的隔离验收任务，以及把已确认需求退回草稿。

CREATE TABLE IF NOT EXISTS public.acceptance_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
  merge_request_id uuid REFERENCES public.merge_requests(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed')),
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS acceptance_jobs_app_idx ON public.acceptance_jobs (app_id, created_at DESC);
ALTER TABLE public.acceptance_jobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS acceptance_jobs_select ON public.acceptance_jobs;
CREATE POLICY acceptance_jobs_select ON public.acceptance_jobs FOR SELECT TO authenticated
  USING (public.has_app_role(app_id, NULL) OR public.is_admin());
GRANT SELECT ON public.acceptance_jobs TO authenticated;
GRANT ALL ON public.acceptance_jobs TO service_role;

CREATE OR REPLACE FUNCTION public.sdf_return_requirements(_app uuid, _ids jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE n integer;
BEGIN
  IF NOT (public.is_admin() OR public.has_app_role(_app, ARRAY['lead','ba'])) THEN RAISE EXCEPTION 'SDF_FORBIDDEN'; END IF;
  UPDATE public.requirements
  SET status = 'draft', confirmed_by = NULL, confirmed_at = NULL, updated_at = now()
  WHERE app_id = _app AND id IN (SELECT value::uuid FROM jsonb_array_elements_text(_ids)) AND status = 'approved';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.sdf_return_requirements(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sdf_return_requirements(uuid, jsonb) TO authenticated, service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'schema_migrations') THEN
    INSERT INTO public.schema_migrations(filename) VALUES ('0029_sdf_15_isolated_acceptance.sql') ON CONFLICT DO NOTHING;
  END IF;
END $$;
