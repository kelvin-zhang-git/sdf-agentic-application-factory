-- 阶段 1：模型调用关联步骤，制品记录审核，需求确认后生成基线。

ALTER TABLE public.llm_calls ADD COLUMN IF NOT EXISTS step_run_id uuid;
CREATE INDEX IF NOT EXISTS llm_calls_step_run_id_idx ON public.llm_calls (step_run_id);

ALTER TABLE public.artifacts ADD COLUMN IF NOT EXISTS reviewed_by uuid;
ALTER TABLE public.artifacts ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
ALTER TABLE public.artifacts ADD COLUMN IF NOT EXISTS edit_ratio numeric CHECK (edit_ratio IS NULL OR (edit_ratio >= 0 AND edit_ratio <= 1));

ALTER TABLE public.requirements ADD COLUMN IF NOT EXISTS confirmed_by uuid;
ALTER TABLE public.requirements ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;

CREATE OR REPLACE FUNCTION public.sdf_write_artifact(_app uuid, _a jsonb, _step uuid, _actor uuid, _source text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v integer; aid uuid; m text;
BEGIN
  SELECT COALESCE(max(version),0) + 1 INTO v FROM public.artifacts WHERE app_id = _app AND type = _a->>'type' AND key = _a->>'key';
  UPDATE public.artifacts SET is_latest = false WHERE app_id = _app AND type = _a->>'type' AND key = _a->>'key' AND is_latest;
  -- 步骤没有单独填写模型时，用这一步最近一次成功调用的模型。
  m := NULLIF(_a->>'model', '');
  IF m IS NULL AND _step IS NOT NULL THEN
    SELECT c.model INTO m FROM public.llm_calls c WHERE c.step_run_id = _step AND c.status = 'success' ORDER BY c.created_at DESC LIMIT 1;
  END IF;
  INSERT INTO public.artifacts(app_id, type, key, version, title, content, content_json, status, is_latest, step_run_id, source, agent_role, model, confidence, citations, created_by)
  VALUES (_app, _a->>'type', _a->>'key', v, COALESCE(_a->>'title', _a->>'type'), COALESCE(_a->>'content',''), _a->'content_json', 'draft', true, _step, _source,
    _a->>'agent_role', m, (_a->>'confidence')::numeric, COALESCE(_a->'citations','[]'::jsonb), _actor) RETURNING id INTO aid;
  RETURN aid;
END $$;

CREATE OR REPLACE FUNCTION public.sdf_review_artifact(_id uuid, _status text, _content text, _ratio numeric) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE row public.artifacts;
BEGIN
  IF _status NOT IN ('approved', 'rejected') THEN RAISE EXCEPTION 'SDF_VALIDATION: status'; END IF;
  SELECT * INTO row FROM public.artifacts WHERE id = _id AND is_latest;
  IF row.id IS NULL THEN RAISE EXCEPTION 'SDF_NOT_FOUND: artifact'; END IF;
  IF NOT (public.is_admin() OR public.has_app_role(row.app_id, ARRAY['lead','ba'])) THEN RAISE EXCEPTION 'SDF_FORBIDDEN'; END IF;
  UPDATE public.artifacts
  SET status = _status,
      content = COALESCE(_content, content),
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      edit_ratio = _ratio
  WHERE id = row.id;
  RETURN row.id;
END $$;
REVOKE ALL ON FUNCTION public.sdf_review_artifact(uuid, text, text, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sdf_review_artifact(uuid, text, text, numeric) TO authenticated, service_role;

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

CREATE OR REPLACE FUNCTION public.sdf_seal_baseline(_app uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE ver text; n integer;
BEGIN
  IF NOT (public.is_admin() OR public.has_app_role(_app, ARRAY['lead','ba'])) THEN RAISE EXCEPTION 'SDF_FORBIDDEN'; END IF;
  SELECT count(*) INTO n FROM public.requirements WHERE app_id = _app AND status = 'approved';
  IF n = 0 THEN RAISE EXCEPTION 'SDF_VALIDATION: 还没有已确认的需求'; END IF;
  ver := 'confirmed-' || to_char(now(), 'YYYYMMDDHH24MISS');
  INSERT INTO public.baselines(app_id, version, snapshot)
  SELECT _app, ver, jsonb_build_object(
    'confirmed_by', auth.uid(),
    'confirmed_count', n,
    'requirements', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', r.id, 'code', r.code, 'title', r.title, 'version', r.current_version, 'confirmed_at', r.confirmed_at) ORDER BY r.code)
      FROM public.requirements r WHERE r.app_id = _app AND r.status = 'approved'
    ), '[]'::jsonb)
  );
  RETURN ver;
END $$;
REVOKE ALL ON FUNCTION public.sdf_seal_baseline(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sdf_seal_baseline(uuid) TO authenticated, service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'schema_migrations') THEN
    INSERT INTO public.schema_migrations(filename) VALUES ('0028_sdf_14_phase1_evidence.sql') ON CONFLICT DO NOTHING;
  END IF;
END $$;
