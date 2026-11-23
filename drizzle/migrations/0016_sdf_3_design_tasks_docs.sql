-- 阶段 1：测试用例、任务、原型留言、追溯。跳过步骤写入运行，合并结果时落库。

CREATE TABLE public.test_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
  code text NOT NULL,
  requirement_id uuid NOT NULL REFERENCES public.requirements(id) ON DELETE CASCADE,
  ac_code text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('normal', 'exception', 'boundary')),
  title text NOT NULL,
  preconditions text NOT NULL DEFAULT '',
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  expected text NOT NULL,
  created_by_step uuid REFERENCES public.step_runs(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, code)
);

CREATE TABLE public.tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
  code text NOT NULL,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'review', 'blocked', 'done')),
  assignee_kind text NOT NULL DEFAULT 'human' CHECK (assignee_kind IN ('human', 'agent')),
  requirement_codes text[] NOT NULL DEFAULT '{}',
  ac_codes text[] NOT NULL DEFAULT '{}',
  allowed_paths text[] NOT NULL DEFAULT '{}',
  forbidden_paths text[] NOT NULL DEFAULT '{}',
  context_artifact_id uuid REFERENCES public.artifacts(id),
  created_by_step uuid REFERENCES public.step_runs(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, code)
);

CREATE TABLE public.prototype_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
  anchor text NOT NULL,
  body text NOT NULL,
  author_profile_id uuid REFERENCES public.profiles(id),
  resolved boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.trace_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
  from_kind text NOT NULL,
  from_code text NOT NULL,
  to_kind text NOT NULL,
  to_code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, from_kind, from_code, to_kind, to_code)
);

GRANT SELECT ON public.test_cases, public.tasks, public.prototype_comments, public.trace_links TO authenticated;
GRANT ALL ON public.test_cases, public.tasks, public.prototype_comments, public.trace_links TO service_role;
ALTER TABLE public.test_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prototype_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trace_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY test_cases_select ON public.test_cases FOR SELECT TO authenticated USING (public.has_app_role(app_id, NULL) OR public.is_admin());
CREATE POLICY tasks_select ON public.tasks FOR SELECT TO authenticated USING (public.has_app_role(app_id, NULL) OR public.is_admin());
CREATE POLICY prototype_comments_select ON public.prototype_comments FOR SELECT TO authenticated USING (public.has_app_role(app_id, NULL) OR public.is_admin());
CREATE POLICY trace_links_select ON public.trace_links FOR SELECT TO authenticated USING (public.has_app_role(app_id, NULL) OR public.is_admin());

CREATE OR REPLACE FUNCTION public.next_code(_app_id uuid, _kind text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v integer;
BEGIN
  IF _kind NOT IN ('R','SRC','REQ','AC','F','Q','T','TC') THEN RAISE EXCEPTION 'invalid code kind'; END IF;
  INSERT INTO public.app_counters(app_id, kind, next_val) VALUES (_app_id, _kind, 2)
  ON CONFLICT (app_id, kind) DO UPDATE SET next_val = public.app_counters.next_val + 1
  RETURNING next_val - 1 INTO v;
  RETURN _kind || '-' || lpad(v::text, 4, '0');
END $$;

CREATE OR REPLACE FUNCTION public.start_run(_app uuid, _workflow uuid, _weight text, _inputs jsonb, _actor uuid, _trace text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE w public.workflows; rid uuid; s jsonb; i integer; cp jsonb; planned_skip boolean;
BEGIN
  SELECT * INTO w FROM public.workflows WHERE id = _workflow;
  IF NOT FOUND OR NOT w.startable THEN RAISE EXCEPTION 'SDF_VALIDATION: workflow not startable'; END IF;
  IF _weight NOT IN ('light','standard','full') THEN RAISE EXCEPTION 'SDF_VALIDATION: weight'; END IF;
  INSERT INTO public.workflow_runs(code, app_id, workflow_id, workflow_snapshot, weight, inputs, started_by, trace_id)
  VALUES (public.next_code(_app, 'R'), _app, _workflow, w.definition, _weight, COALESCE(_inputs,'{}'::jsonb), _actor, _trace) RETURNING id INTO rid;
  FOR s, i IN SELECT e.value, e.ordinality FROM jsonb_array_elements(w.definition->'steps') WITH ORDINALITY e LOOP
    cp := s->'checkpoints'->_weight;
    planned_skip := COALESCE((s->>'skip')::boolean, false) OR NOT (s->'weights' ? _weight);
    INSERT INTO public.step_runs(run_id, app_id, step_key, stage, block_key, seq, status, checkpoint, skip_reason, finished_at)
    VALUES (rid, _app, s->>'key', s->>'stage', s->>'block', i::integer,
      CASE WHEN planned_skip THEN 'skipped' ELSE 'pending' END,
      CASE WHEN cp IS NULL OR cp = 'null'::jsonb THEN NULL ELSE cp END,
      CASE WHEN COALESCE((s->>'skip')::boolean, false) THEN '本阶段规划跳过' WHEN NOT (s->'weights' ? _weight) THEN '当前档位不执行' ELSE NULL END,
      CASE WHEN planned_skip THEN now() ELSE NULL END);
  END LOOP;
  PERFORM public.sdf_refresh_run(rid);
  PERFORM public.sdf_audit(_actor, _app, 'run.started', 'workflow_run', rid::text, _trace, jsonb_build_object('workflow', w.key, 'version', w.version, 'weight', _weight));
  RETURN rid;
END $$;

CREATE OR REPLACE FUNCTION public.merge_step_results(_step uuid, _lease uuid, _result jsonb, _summary text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE s public.step_runs; x jsonb; outs jsonb := '[]'::jsonb; aid uuid; st text; rid uuid; tcode text; ctx text; tccode text;
BEGIN
  s := public.sdf_lock_leased(_step, _lease);
  IF s.block_key = 'B01' THEN
    FOR x IN SELECT value FROM jsonb_array_elements(COALESCE(_result->'tags','[]'::jsonb)) LOOP
      UPDATE public.source_segments SET tags = x->'tags', speaker = COALESCE(NULLIF(x->>'speaker',''), speaker) WHERE id = (x->>'segment_id')::uuid AND app_id = s.app_id;
    END LOOP;
  ELSIF s.block_key = 'B02' THEN
    FOR x IN SELECT value FROM jsonb_array_elements(COALESCE(_result->'requirements','[]'::jsonb)) LOOP
      PERFORM public.sdf_upsert_requirement(s.app_id, x, _step, NULL, '需求整理生成');
    END LOOP;
  ELSIF s.block_key = 'B03' THEN
    UPDATE public.analysis_findings SET status = 'stale' WHERE app_id = s.app_id AND status = 'open';
    FOR x IN SELECT value FROM jsonb_array_elements(COALESCE(_result->'findings','[]'::jsonb)) LOOP
      INSERT INTO public.analysis_findings(code, app_id, run_id, step_run_id, severity, category, target_refs, description, suggestion, rule_or_agent)
      VALUES (public.next_code(s.app_id,'F'), s.app_id, s.run_id, _step, x->>'severity', x->>'category', COALESCE(x->'target_refs','[]'::jsonb), x->>'description', COALESCE(x->>'suggestion',''), x->>'rule_or_agent');
    END LOOP;
  ELSIF s.block_key = 'B04' THEN
    UPDATE public.clarification_questions SET status = 'stale' WHERE app_id = s.app_id AND status = 'open';
    FOR x IN SELECT value FROM jsonb_array_elements(COALESCE(_result->'questions','[]'::jsonb)) LOOP
      INSERT INTO public.clarification_questions(code, app_id, step_run_id, stakeholder, contact_id, question, target_refs)
      VALUES (public.next_code(s.app_id,'Q'), s.app_id, _step, x->>'stakeholder', NULLIF(x->>'contact_id','')::uuid, x->>'question', x->'target_refs');
    END LOOP;
  END IF;
  IF _result ? 'test_cases' THEN
    FOR x IN SELECT value FROM jsonb_array_elements(_result->'test_cases') LOOP
      SELECT r.id INTO rid FROM public.requirements r WHERE r.app_id = s.app_id AND r.code = x->>'requirement_code';
      IF rid IS NULL THEN RAISE EXCEPTION 'SDF_VALIDATION: unknown requirement %', x->>'requirement_code'; END IF;
      IF NOT EXISTS (SELECT 1 FROM public.acceptance_criteria a WHERE a.app_id = s.app_id AND a.requirement_id = rid AND a.code = x->>'ac_code') THEN
        RAISE EXCEPTION 'SDF_VALIDATION: unknown acceptance criterion %', x->>'ac_code';
      END IF;
      INSERT INTO public.test_cases(app_id, code, requirement_id, ac_code, kind, title, preconditions, steps, expected, created_by_step)
      VALUES (s.app_id, public.next_code(s.app_id, 'TC'), rid, x->>'ac_code', x->>'kind', x->>'title', COALESCE(x->>'preconditions',''), COALESCE(x->'steps','[]'::jsonb), x->>'expected', _step)
      RETURNING code INTO tccode;
      INSERT INTO public.trace_links(app_id, from_kind, from_code, to_kind, to_code)
      VALUES (s.app_id, 'ac', x->>'ac_code', 'test_case', tccode)
      ON CONFLICT DO NOTHING;
    END LOOP;
  END IF;
  IF _result ? 'tasks' THEN
    FOR x IN SELECT value FROM jsonb_array_elements(_result->'tasks') LOOP
      tcode := public.next_code(s.app_id, 'T');
      ctx := replace(COALESCE(x->>'context_markdown',''), '{{CODE}}', tcode);
      IF position(('SDF-Task: ' || tcode) IN ctx) = 0 THEN RAISE EXCEPTION 'SDF_VALIDATION: context pack missing trailer'; END IF;
      aid := public.sdf_write_artifact(s.app_id, jsonb_build_object('type','context_pack','key', tcode, 'title', tcode || ' 上下文包', 'content', ctx, 'agent_role','lead'), _step, NULL, 'agent');
      INSERT INTO public.tasks(app_id, code, title, description, requirement_codes, ac_codes, allowed_paths, forbidden_paths, context_artifact_id, created_by_step)
      VALUES (s.app_id, tcode, x->>'title', COALESCE(x->>'description',''),
        ARRAY(SELECT jsonb_array_elements_text(COALESCE(x->'requirement_codes','[]'::jsonb))),
        ARRAY(SELECT jsonb_array_elements_text(COALESCE(x->'ac_codes','[]'::jsonb))),
        ARRAY(SELECT jsonb_array_elements_text(COALESCE(x->'allowed_paths','[]'::jsonb))),
        ARRAY(SELECT jsonb_array_elements_text(COALESCE(x->'forbidden_paths','[]'::jsonb))),
        aid, _step);
      outs := outs || jsonb_build_array(aid::text);
    END LOOP;
  END IF;
  IF _result ? 'artifact' THEN
    aid := public.sdf_write_artifact(s.app_id, _result->'artifact', _step, NULL, 'agent');
    outs := outs || jsonb_build_array(aid::text);
    PERFORM public.sdf_event(_step, 'artifact', '生成制品：' || COALESCE(_result->'artifact'->>'title',''), jsonb_build_object('artifact_id', aid));
  END IF;
  IF _result ? 'artifacts' THEN
    FOR x IN SELECT value FROM jsonb_array_elements(_result->'artifacts') LOOP
      aid := public.sdf_write_artifact(s.app_id, x, _step, NULL, 'agent');
      outs := outs || jsonb_build_array(aid::text);
      PERFORM public.sdf_event(_step, 'artifact', '生成制品：' || COALESCE(x->>'title',''), jsonb_build_object('artifact_id', aid));
    END LOOP;
  END IF;
  st := CASE WHEN COALESCE(s.checkpoint ? 'role', false) THEN 'waiting_human' ELSE 'succeeded' END;
  UPDATE public.step_runs SET status = st, summary = left(_summary, 2000), output_artifacts = outs, lease_token = NULL, lease_expires_at = NULL,
    progress_text = NULL, finished_at = CASE WHEN st = 'succeeded' THEN now() ELSE NULL END,
    tokens = tokens + COALESCE((_result->>'tokens')::integer,0), model_calls = model_calls + COALESCE((_result->>'calls')::integer,0) WHERE id = _step;
  PERFORM public.sdf_event(_step, CASE WHEN st='waiting_human' THEN 'human' ELSE 'status' END, CASE WHEN st = 'waiting_human' THEN '等待确认：' || COALESCE(s.checkpoint->>'role','lead') ELSE '执行完成' END);
  PERFORM public.sdf_refresh_run(s.run_id);
  RETURN st;
END $$;

CREATE OR REPLACE FUNCTION public.edit_artifact(_app uuid, _actor uuid, _a jsonb, _trace text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE aid uuid;
BEGIN
  IF _a->>'type' NOT IN ('constitution', 'data_model', 'prototype_html') THEN RAISE EXCEPTION 'SDF_VALIDATION: artifact type not editable'; END IF;
  aid := public.sdf_write_artifact(_app, _a, NULL, _actor, 'human');
  PERFORM public.sdf_audit(_actor, _app, 'artifact.edited', 'artifact', aid::text, _trace, jsonb_build_object('type', _a->>'type', 'key', _a->>'key'));
  RETURN aid;
END $$;

CREATE OR REPLACE FUNCTION public.update_task_status(_task uuid, _actor uuid, _status text, _trace text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE t public.tasks;
BEGIN
  SELECT * INTO t FROM public.tasks WHERE id = _task;
  IF NOT FOUND THEN RAISE EXCEPTION 'SDF_NOT_FOUND'; END IF;
  IF NOT (public.has_app_role(t.app_id, ARRAY['dev','qa','lead']) OR public.is_admin()) THEN RAISE EXCEPTION 'SDF_FORBIDDEN'; END IF;
  IF _status NOT IN ('todo','doing','review','blocked','done') THEN RAISE EXCEPTION 'SDF_VALIDATION: status'; END IF;
  UPDATE public.tasks SET status = _status, updated_at = now() WHERE id = _task;
  PERFORM public.sdf_audit(_actor, t.app_id, 'task.status', 'task', t.code, _trace, jsonb_build_object('status', _status));
END $$;

CREATE OR REPLACE FUNCTION public.add_prototype_comment(_app uuid, _actor uuid, _anchor text, _body text, _trace text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE cid uuid;
BEGIN
  IF NOT (public.has_app_role(_app, NULL) OR public.is_admin()) THEN RAISE EXCEPTION 'SDF_FORBIDDEN'; END IF;
  IF length(trim(_anchor)) = 0 OR length(trim(_body)) < 2 THEN RAISE EXCEPTION 'SDF_VALIDATION: comment'; END IF;
  INSERT INTO public.prototype_comments(app_id, anchor, body, author_profile_id)
  VALUES (_app, left(trim(_anchor), 120), left(trim(_body), 2000), _actor) RETURNING id INTO cid;
  PERFORM public.sdf_audit(_actor, _app, 'prototype.comment', 'prototype_comment', cid::text, _trace, jsonb_build_object('anchor', _anchor));
  RETURN cid;
END $$;

REVOKE EXECUTE ON FUNCTION public.update_task_status(uuid, uuid, text, text) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.add_prototype_comment(uuid, uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_task_status(uuid, uuid, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.add_prototype_comment(uuid, uuid, text, text, text) TO authenticated, service_role;

ALTER TABLE public.workflows DISABLE TRIGGER t_immutable;
UPDATE public.workflows SET startable = false WHERE key = 'requirement_only' AND version = '1.0.0';
ALTER TABLE public.workflows ENABLE TRIGGER t_immutable;
