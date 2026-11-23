-- P1：应用级自定义脱敏词表、需求变更向下游制品传播过期标记、明细化需求影响分析。

ALTER TABLE public.apps
  ADD COLUMN IF NOT EXISTS redact_terms text[] NOT NULL DEFAULT '{}';

CREATE OR REPLACE FUNCTION public.edit_requirement(_req uuid, _actor uuid, _patch jsonb, _reason text, _trace text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  r public.requirements;
  q jsonb;
  v integer;
BEGIN
  SELECT * INTO r FROM public.requirements WHERE id = _req FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'SDF_NOT_FOUND'; END IF;
  IF COALESCE(trim(_reason),'') = '' THEN RAISE EXCEPTION 'SDF_VALIDATION: change reason'; END IF;
  q := jsonb_build_object('title', r.title) || (COALESCE(_patch,'{}'::jsonb) - 'title' - 'citations');
  PERFORM public.sdf_upsert_requirement(r.app_id, q, NULL, _actor, left(_reason, 500));
  IF _patch ? 'status' THEN UPDATE public.requirements SET status = _patch->>'status' WHERE id = _req; END IF;
  SELECT current_version INTO v FROM public.requirements WHERE id = _req;

  -- 将上游分析与全部下游设计、原型、测试与规格文档标记为可能已过期
  UPDATE public.artifacts
  SET possibly_stale = true
  WHERE app_id = r.app_id
    AND is_latest
    AND (
      type IN (
        'requirements','analysis','clarifications',
        'data_model','openapi','design_doc','prototype_html',
        'test_design','document_srs','document_design'
      )
      OR (
        type = 'context_pack'
        AND key IN (
          SELECT t.code FROM public.tasks t
          WHERE t.app_id = r.app_id AND r.code = ANY(t.requirement_codes)
        )
      )
    );

  PERFORM public.sdf_audit(_actor, r.app_id, 'requirement.edited', 'requirement', _req::text, _trace, jsonb_build_object('version', v, 'reason', left(_reason,500)));
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION public.sdf_requirement_impact(_app uuid, _code text, _iteration uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  ac_codes text[];
  tc_codes text[];
  task_codes text[];
  mr_nums text[];
  downstream_n integer;
  ac_n integer;
  tc_n integer;
  task_n integer;
  mr_n integer;
  detail text := '';
  summary text;
  cr text;
BEGIN
  IF NOT (public.is_admin() OR public.has_app_role(_app, ARRAY['lead','ba'])) THEN RAISE EXCEPTION 'SDF_FORBIDDEN'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.requirements WHERE app_id = _app AND code = _code) THEN RAISE EXCEPTION 'SDF_NOT_FOUND'; END IF;

  INSERT INTO public.trace_links(app_id, from_kind, from_code, to_kind, to_code)
  SELECT _app, 'requirement', _code, 'acceptance', a.code
  FROM public.acceptance_criteria a
  JOIN public.requirements r ON r.id = a.requirement_id AND a.requirement_version = r.current_version
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
  WHERE m.app_id = _app AND m.number IS NOT NULL AND m.state IN ('open', 'merged') AND _code = ANY(t.requirement_codes)
  ON CONFLICT DO NOTHING;

  SELECT COALESCE(array_agg(DISTINCT to_code ORDER BY to_code), '{}') INTO ac_codes
  FROM public.trace_links WHERE app_id = _app AND from_code = _code AND to_kind = 'acceptance';
  SELECT COALESCE(array_agg(DISTINCT to_code ORDER BY to_code), '{}') INTO tc_codes
  FROM public.trace_links WHERE app_id = _app AND from_code = _code AND to_kind = 'test';
  SELECT COALESCE(array_agg(DISTINCT to_code ORDER BY to_code), '{}') INTO task_codes
  FROM public.trace_links WHERE app_id = _app AND from_code = _code AND to_kind = 'task';
  SELECT COALESCE(array_agg(DISTINCT to_code ORDER BY to_code), '{}') INTO mr_nums
  FROM public.trace_links WHERE app_id = _app AND from_code = _code AND to_kind = 'merge_request';

  SELECT count(*)::int INTO downstream_n
  FROM public.artifacts
  WHERE app_id = _app AND is_latest
    AND type IN ('data_model','openapi','design_doc','prototype_html','test_design','document_srs','document_design');

  ac_n := COALESCE(array_length(ac_codes, 1), 0);
  tc_n := COALESCE(array_length(tc_codes, 1), 0);
  task_n := COALESCE(array_length(task_codes, 1), 0);
  mr_n := COALESCE(array_length(mr_nums, 1), 0);

  IF ac_n > 0 THEN detail := detail || ' 验收标准：' || array_to_string(ac_codes[1:12], '、') || CASE WHEN ac_n > 12 THEN ' 等。' ELSE '。' END; END IF;
  IF task_n > 0 THEN detail := detail || ' 关联任务：' || array_to_string(task_codes[1:10], '、') || CASE WHEN task_n > 10 THEN ' 等。' ELSE '。' END; END IF;
  IF mr_n > 0 THEN detail := detail || ' 合并请求：#' || array_to_string(mr_nums[1:10], '、#') || '。'; END IF;

  summary := format(
    '需求 %s 影响到验收标准 %s 条、测试用例 %s 条、任务 %s 条、合并请求 %s 个、下游设计/文档制品 %s 份。%s请业务方确认后再改规格。',
    _code, ac_n, tc_n, task_n, mr_n, downstream_n, detail
  );

  cr := public.next_code(_app, 'CR');
  INSERT INTO public.change_requests(app_id, code, title, status, business_summary, requirement_codes, iteration_id, created_by)
  VALUES (_app, cr, '需求 ' || _code || ' 的影响分析', 'pending_confirm', summary, ARRAY[_code], _iteration, auth.uid());

  RETURN jsonb_build_object(
    'change_request', cr,
    'summary', summary,
    'acceptance', ac_n,
    'tests', tc_n,
    'tasks', task_n,
    'merge_requests', mr_n,
    'downstream_artifacts', downstream_n,
    'acceptance_codes', to_jsonb(ac_codes),
    'test_case_codes', to_jsonb(tc_codes),
    'task_codes', to_jsonb(task_codes),
    'merge_request_numbers', to_jsonb(mr_nums)
  );
END $$;
REVOKE ALL ON FUNCTION public.sdf_requirement_impact(uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sdf_requirement_impact(uuid, text, uuid) TO authenticated, service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'schema_migrations') THEN
    INSERT INTO public.schema_migrations(filename) VALUES ('0034_sdf_20_p1_redact_and_impact.sql') ON CONFLICT DO NOTHING;
  END IF;
END $$;
