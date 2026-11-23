-- 接口层把数组写成 jsonb。确认和退回改为接收 jsonb，避免 uuid[] 对不上。

DROP FUNCTION IF EXISTS public.sdf_confirm_requirements(uuid, uuid[]);
DROP FUNCTION IF EXISTS public.sdf_return_requirements(uuid, uuid[]);

CREATE OR REPLACE FUNCTION public.sdf_confirm_requirements(_app uuid, _ids jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE n integer;
BEGIN
  IF NOT (public.is_admin() OR public.has_app_role(_app, ARRAY['lead','ba'])) THEN RAISE EXCEPTION 'SDF_FORBIDDEN'; END IF;
  UPDATE public.requirements
  SET status = 'approved', confirmed_by = auth.uid(), confirmed_at = now(), updated_at = now()
  WHERE app_id = _app AND id IN (SELECT value::uuid FROM jsonb_array_elements_text(_ids)) AND status <> 'deprecated';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.sdf_confirm_requirements(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sdf_confirm_requirements(uuid, jsonb) TO authenticated, service_role;

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
    INSERT INTO public.schema_migrations(filename) VALUES ('0030_sdf_16_confirm_json.sql') ON CONFLICT DO NOTHING;
  END IF;
END $$;
