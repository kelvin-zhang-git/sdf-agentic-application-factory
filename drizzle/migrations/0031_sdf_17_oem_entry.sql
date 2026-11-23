-- 阶段 2 和阶段 3：账号到期、甲方编号、功能层级、变更影响。

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE public.app_members ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE public.requirements ADD COLUMN IF NOT EXISTS external_ref text;
ALTER TABLE public.source_segments ADD COLUMN IF NOT EXISTS clause_ref text;

CREATE OR REPLACE FUNCTION public.has_app_role(_app_id uuid, _roles text[])
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.app_members
    WHERE app_id = _app_id AND user_id = auth.uid()
      AND (expires_at IS NULL OR expires_at > now())
      AND (_roles IS NULL OR role::text = ANY(_roles))
  )
$$;

CREATE OR REPLACE FUNCTION public.next_code(_app_id uuid, _kind text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v integer; width integer := 4;
BEGIN
  IF _kind NOT IN ('R','SRC','REQ','AC','F','Q','T','TC','FB','CR','DEC','IT','FEAT') THEN RAISE EXCEPTION 'invalid code kind'; END IF;
  IF _kind = 'IT' THEN width := 2; END IF;
  INSERT INTO public.app_counters(app_id, kind, next_val) VALUES (_app_id, _kind, 2)
  ON CONFLICT (app_id, kind) DO UPDATE SET next_val = public.app_counters.next_val + 1
  RETURNING next_val - 1 INTO v;
  RETURN _kind || '-' || lpad(v::text, width, '0');
END $$;

CREATE OR REPLACE FUNCTION public.write_source_segments(_source uuid, _raw text, _segments jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE src public.sources; n integer;
BEGIN
  SELECT * INTO src FROM public.sources WHERE id = _source FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SDF_NOT_FOUND'; END IF;
  n := jsonb_array_length(_segments);
  IF n = 0 OR n > 2000 THEN RAISE EXCEPTION 'SDF_VALIDATION: segment count'; END IF;
  DELETE FROM public.source_segments WHERE source_id = _source;
  INSERT INTO public.source_segments(source_id, app_id, seq, speaker, text, clause_ref)
  SELECT _source, src.app_id, e.ordinality::integer, NULLIF(e.value->>'speaker',''), e.value->>'text', NULLIF(e.value->>'clause','')
  FROM jsonb_array_elements(_segments) WITH ORDINALITY e;
  UPDATE public.sources SET raw_text = _raw, parse_status = 'parsed', parse_error = NULL WHERE id = _source;
  RETURN n;
END $$;

CREATE TABLE IF NOT EXISTS public.features (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
  iteration_id uuid REFERENCES public.iterations(id) ON DELETE SET NULL,
  code text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','spec_confirmed','handed_off','merged','accepted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, code),
  UNIQUE (app_id, name)
);
CREATE TABLE IF NOT EXISTS public.feature_requirements (
  feature_id uuid NOT NULL REFERENCES public.features(id) ON DELETE CASCADE,
  requirement_id uuid NOT NULL REFERENCES public.requirements(id) ON DELETE CASCADE,
  app_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
  PRIMARY KEY (feature_id, requirement_id)
);
GRANT SELECT ON public.features, public.feature_requirements TO authenticated;
GRANT ALL ON public.features, public.feature_requirements TO service_role;
ALTER TABLE public.features ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feature_requirements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS features_select ON public.features;
CREATE POLICY features_select ON public.features FOR SELECT TO authenticated USING (public.has_app_role(app_id, NULL) OR public.is_admin());
DROP POLICY IF EXISTS feature_requirements_select ON public.feature_requirements;
CREATE POLICY feature_requirements_select ON public.feature_requirements FOR SELECT TO authenticated USING (public.has_app_role(app_id, NULL) OR public.is_admin());

CREATE OR REPLACE FUNCTION public.sdf_set_account_expiry(_user uuid, _at timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'SDF_FORBIDDEN'; END IF;
  UPDATE public.profiles SET expires_at = _at, updated_at = now() WHERE id = _user;
  IF NOT FOUND THEN RAISE EXCEPTION 'SDF_NOT_FOUND'; END IF;
  UPDATE auth.users SET disabled = (_at IS NOT NULL AND _at <= now()) WHERE id = _user;
END $$;
REVOKE ALL ON FUNCTION public.sdf_set_account_expiry(uuid, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sdf_set_account_expiry(uuid, timestamptz) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.sdf_set_member_expiry(_member uuid, _at timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE app uuid;
BEGIN
  SELECT app_id INTO app FROM public.app_members WHERE id = _member;
  IF app IS NULL THEN RAISE EXCEPTION 'SDF_NOT_FOUND'; END IF;
  IF NOT (public.is_admin() OR public.has_app_role(app, ARRAY['lead'])) THEN RAISE EXCEPTION 'SDF_FORBIDDEN'; END IF;
  UPDATE public.app_members SET expires_at = _at WHERE id = _member;
END $$;
REVOKE ALL ON FUNCTION public.sdf_set_member_expiry(uuid, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sdf_set_member_expiry(uuid, timestamptz) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.sdf_fill_external_refs(_app uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE n integer;
BEGIN
  IF NOT (public.is_admin() OR public.has_app_role(_app, ARRAY['lead','ba'])) THEN RAISE EXCEPTION 'SDF_FORBIDDEN'; END IF;
  UPDATE public.requirements r
  SET external_ref = s.clause_ref, updated_at = now()
  FROM public.source_segments s
  WHERE r.app_id = _app
    AND r.external_ref IS NULL
    AND (r.citations->0->>'segment_id') ~ '^[0-9a-fA-F-]{36}$'
    AND s.id = (r.citations->0->>'segment_id')::uuid
    AND s.clause_ref IS NOT NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.sdf_fill_external_refs(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sdf_fill_external_refs(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.sdf_create_feature(_app uuid, _name text, _iteration uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE row public.features;
BEGIN
  IF NOT (public.is_admin() OR public.has_app_role(_app, ARRAY['lead','ba'])) THEN RAISE EXCEPTION 'SDF_FORBIDDEN'; END IF;
  IF char_length(btrim(_name)) < 2 THEN RAISE EXCEPTION 'SDF_VALIDATION: name'; END IF;
  SELECT * INTO row FROM public.features WHERE app_id = _app AND name = btrim(_name);
  IF row.id IS NOT NULL THEN RETURN jsonb_build_object('id', row.id, 'code', row.code, 'created', false); END IF;
  INSERT INTO public.features(app_id, iteration_id, code, name)
  VALUES (_app, _iteration, public.next_code(_app, 'FEAT'), btrim(_name))
  RETURNING * INTO row;
  RETURN jsonb_build_object('id', row.id, 'code', row.code, 'created', true);
END $$;
REVOKE ALL ON FUNCTION public.sdf_create_feature(uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sdf_create_feature(uuid, text, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.sdf_assign_feature(_app uuid, _feature uuid, _ids jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE n integer;
BEGIN
  IF NOT (public.is_admin() OR public.has_app_role(_app, ARRAY['lead','ba'])) THEN RAISE EXCEPTION 'SDF_FORBIDDEN'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.features WHERE id = _feature AND app_id = _app) THEN RAISE EXCEPTION 'SDF_NOT_FOUND'; END IF;
  INSERT INTO public.feature_requirements(feature_id, requirement_id, app_id)
  SELECT _feature, value::uuid, _app
  FROM jsonb_array_elements_text(_ids)
  WHERE EXISTS (SELECT 1 FROM public.requirements r WHERE r.id = value::uuid AND r.app_id = _app)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION public.sdf_assign_feature(uuid, uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sdf_assign_feature(uuid, uuid, jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.sdf_set_feature_status(_app uuid, _feature uuid, _status text, _iteration uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF _status NOT IN ('draft','spec_confirmed','handed_off','merged','accepted') THEN RAISE EXCEPTION 'SDF_VALIDATION: status'; END IF;
  IF NOT (public.is_admin() OR public.has_app_role(_app, ARRAY['lead','ba','qa'])) THEN RAISE EXCEPTION 'SDF_FORBIDDEN'; END IF;
  UPDATE public.features
  SET status = _status, iteration_id = COALESCE(_iteration, iteration_id)
  WHERE id = _feature AND app_id = _app;
  IF NOT FOUND THEN RAISE EXCEPTION 'SDF_NOT_FOUND'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.sdf_set_feature_status(uuid, uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sdf_set_feature_status(uuid, uuid, text, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.sdf_requirement_impact(_app uuid, _code text, _iteration uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE ac_n integer; tc_n integer; task_n integer; mr_n integer; summary text; cr text;
BEGIN
  IF NOT (public.is_admin() OR public.has_app_role(_app, ARRAY['lead','ba'])) THEN RAISE EXCEPTION 'SDF_FORBIDDEN'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.requirements WHERE app_id = _app AND code = _code) THEN RAISE EXCEPTION 'SDF_NOT_FOUND'; END IF;
  INSERT INTO public.trace_links(app_id, from_kind, from_code, to_kind, to_code)
  SELECT _app, 'requirement', _code, 'acceptance', a.code
  FROM public.acceptance_criteria a
  JOIN public.requirements r ON r.id = a.requirement_id
  WHERE r.app_id = _app AND r.code = _code
  ON CONFLICT DO NOTHING;
  INSERT INTO public.trace_links(app_id, from_kind, from_code, to_kind, to_code)
  SELECT _app, 'requirement', _code, 'test', t.code
  FROM public.test_cases t
  JOIN public.requirements r ON r.id = t.requirement_id
  WHERE r.app_id = _app AND r.code = _code
  ON CONFLICT DO NOTHING;
  INSERT INTO public.trace_links(app_id, from_kind, from_code, to_kind, to_code)
  SELECT _app, 'requirement', _code, 'task', t.code
  FROM public.tasks t
  WHERE t.app_id = _app AND _code = ANY(t.requirement_codes)
  ON CONFLICT DO NOTHING;
  INSERT INTO public.trace_links(app_id, from_kind, from_code, to_kind, to_code)
  SELECT _app, 'requirement', _code, 'merge_request', m.number::text
  FROM public.merge_requests m
  JOIN public.tasks t ON t.id = m.task_id
  WHERE m.app_id = _app AND m.number IS NOT NULL AND _code = ANY(t.requirement_codes)
  ON CONFLICT DO NOTHING;
  SELECT count(*) INTO ac_n FROM public.trace_links WHERE app_id = _app AND from_code = _code AND to_kind = 'acceptance';
  SELECT count(*) INTO tc_n FROM public.trace_links WHERE app_id = _app AND from_code = _code AND to_kind = 'test';
  SELECT count(*) INTO task_n FROM public.trace_links WHERE app_id = _app AND from_code = _code AND to_kind = 'task';
  SELECT count(*) INTO mr_n FROM public.trace_links WHERE app_id = _app AND from_code = _code AND to_kind = 'merge_request';
  summary := format('需求 %s 影响到验收标准 %s 条、测试用例 %s 条、任务 %s 条、合并请求 %s 个。请业务方确认后再改规格。', _code, ac_n, tc_n, task_n, mr_n);
  cr := public.next_code(_app, 'CR');
  INSERT INTO public.change_requests(app_id, code, title, status, business_summary, requirement_codes, iteration_id, created_by)
  VALUES (_app, cr, '需求 ' || _code || ' 的影响分析', 'pending_confirm', summary, ARRAY[_code], _iteration, auth.uid());
  RETURN jsonb_build_object('change_request', cr, 'summary', summary, 'acceptance', ac_n, 'tests', tc_n, 'tasks', task_n, 'merge_requests', mr_n);
END $$;
REVOKE ALL ON FUNCTION public.sdf_requirement_impact(uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sdf_requirement_impact(uuid, text, uuid) TO authenticated, service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'schema_migrations') THEN
    INSERT INTO public.schema_migrations(filename) VALUES ('0031_sdf_17_oem_entry.sql') ON CONFLICT DO NOTHING;
  END IF;
END $$;
