-- 阶段 2：连接器、交接、合并请求、测试报告和交付检查。
-- 0017 已用于“主动让出不计入中断”，本阶段使用 0018。

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public' AND rel.relname = 'secrets' AND con.contype = 'c' AND pg_get_constraintdef(con.oid) ILIKE '%kind%'
  LOOP
    EXECUTE format('ALTER TABLE public.secrets DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;
ALTER TABLE public.secrets ADD CONSTRAINT secrets_kind_check
  CHECK (kind IN ('llm_provider', 'connector_token', 'webhook_secret'));

CREATE TABLE public.connectors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  capability text NOT NULL CHECK (capability IN ('code_repo', 'work_item', 'notify')),
  vendor text NOT NULL CHECK (vendor IN ('gitea', 'github', 'gitlab', 'jira', 'ado', 'wecom', 'dingtalk', 'feishu', 'webhook')),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_id uuid REFERENCES public.secrets(id) ON DELETE RESTRICT,
  webhook_secret_id uuid REFERENCES public.secrets(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'untested' CHECK (status IN ('untested', 'success', 'error')),
  last_checked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.app_connectors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
  connector_id uuid NOT NULL REFERENCES public.connectors(id) ON DELETE CASCADE,
  capability text NOT NULL CHECK (capability IN ('code_repo', 'work_item', 'notify')),
  binding jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (app_id, capability)
);
CREATE TABLE public.connector_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id text,
  connector_id uuid REFERENCES public.connectors(id) ON DELETE SET NULL,
  app_id uuid REFERENCES public.apps(id) ON DELETE CASCADE,
  run_id uuid,
  step_run_id uuid,
  action text NOT NULL,
  status text NOT NULL,
  http_status integer,
  duration_ms integer,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES public.workflow_runs(id) ON DELETE CASCADE,
  task_id uuid REFERENCES public.tasks(id) ON DELETE SET NULL,
  channel text NOT NULL CHECK (channel IN ('repo_files', 'work_item')),
  version integer NOT NULL DEFAULT 1,
  branch_name text,
  external_ref text,
  external_url text,
  status text NOT NULL DEFAULT 'sent',
  sent_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, task_id)
);
CREATE TABLE public.merge_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
  task_id uuid REFERENCES public.tasks(id) ON DELETE SET NULL,
  connector_id uuid NOT NULL REFERENCES public.connectors(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  number integer,
  url text,
  title text NOT NULL DEFAULT '',
  branch text NOT NULL DEFAULT '',
  state text NOT NULL CHECK (state IN ('open', 'merged', 'closed')),
  author text NOT NULL DEFAULT '',
  changed_files text[] NOT NULL DEFAULT '{}',
  out_of_scope_files text[] NOT NULL DEFAULT '{}',
  matched_by text CHECK (matched_by IN ('body_trailer', 'title_prefix', 'branch_name', 'manual')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connector_id, external_id)
);
CREATE TABLE public.ingest_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
  name text NOT NULL,
  token_prefix text NOT NULL,
  token_hash text NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
  run_id uuid,
  kind text NOT NULL CHECK (kind IN ('junit', 'sarif')),
  raw_bytes integer NOT NULL CHECK (raw_bytes >= 0 AND raw_bytes <= 15728640),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.test_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL REFERENCES public.reports(id) ON DELETE CASCADE,
  app_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
  name text NOT NULL,
  ac_code text,
  status text NOT NULL CHECK (status IN ('passed', 'failed', 'skipped'))
);
CREATE TABLE public.scan_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL REFERENCES public.reports(id) ON DELETE CASCADE,
  app_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
  rule_id text NOT NULL DEFAULT '',
  level text NOT NULL DEFAULT '',
  message text NOT NULL DEFAULT '',
  path text NOT NULL DEFAULT ''
);
CREATE TABLE public.gate_templates (
  key text PRIMARY KEY,
  name text NOT NULL,
  rules jsonb NOT NULL
);
CREATE TABLE public.gate_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
  run_id uuid,
  template_key text NOT NULL,
  item_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('PASSED', 'FAILED', 'NOT_EXECUTED')),
  numerator integer,
  denominator integer,
  evidence text NOT NULL DEFAULT '',
  waiver_reason text,
  waived_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.connectors, public.app_connectors, public.handoffs, public.merge_requests, public.reports, public.test_results, public.scan_findings, public.gate_templates, public.gate_results TO authenticated;
GRANT ALL ON public.connectors, public.app_connectors, public.connector_calls, public.handoffs, public.merge_requests, public.ingest_tokens, public.reports, public.test_results, public.scan_findings, public.gate_templates, public.gate_results TO service_role;
ALTER TABLE public.connectors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_connectors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.connector_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.merge_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ingest_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.test_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scan_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gate_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gate_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY connectors_admin ON public.connectors FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY app_connectors_select ON public.app_connectors FOR SELECT TO authenticated USING (public.has_app_role(app_id, NULL) OR public.is_admin());
CREATE POLICY handoffs_select ON public.handoffs FOR SELECT TO authenticated USING (public.has_app_role(app_id, NULL) OR public.is_admin());
CREATE POLICY merge_requests_select ON public.merge_requests FOR SELECT TO authenticated USING (public.has_app_role(app_id, NULL) OR public.is_admin());
CREATE POLICY reports_select ON public.reports FOR SELECT TO authenticated USING (public.has_app_role(app_id, NULL) OR public.is_admin());
CREATE POLICY test_results_select ON public.test_results FOR SELECT TO authenticated USING (public.has_app_role(app_id, NULL) OR public.is_admin());
CREATE POLICY scan_findings_select ON public.scan_findings FOR SELECT TO authenticated USING (public.has_app_role(app_id, NULL) OR public.is_admin());
CREATE POLICY gate_templates_read ON public.gate_templates FOR SELECT TO authenticated USING (true);
CREATE POLICY gate_results_select ON public.gate_results FOR SELECT TO authenticated USING (public.has_app_role(app_id, NULL) OR public.is_admin());

INSERT INTO public.gate_templates(key, name, rules) VALUES
  ('standard', '标准交付条件', '{"coverage_min":0.8,"pass_rate":1,"sarif_high_max":0,"out_of_scope_max":0}'::jsonb),
  ('simple', '简化交付条件', '{"coverage_min":0.5,"pass_rate":1,"sarif_high_max":0,"out_of_scope_max":0}'::jsonb);

-- 外部事件到达后，把正在等待的步骤收口，并刷新运行状态。
CREATE OR REPLACE FUNCTION public.resolve_wait(_run uuid, _event text, _payload jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE n integer;
BEGIN
  UPDATE public.step_runs
  SET status = 'succeeded', summary = left('事件已到达：' || COALESCE(_event, ''), 2000),
      finished_at = now(), lease_token = NULL, lease_expires_at = NULL
  WHERE run_id = _run AND is_current AND status = 'waiting_event';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n > 0 THEN PERFORM public.sdf_refresh_run(_run); END IF;
  RETURN n > 0;
END $$;
REVOKE ALL ON FUNCTION public.resolve_wait(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_wait(uuid, text, jsonb) TO service_role;

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
  -- 交接步骤提交代码后停在等待事件，不把“还没收回合并请求”当成步骤失败。
  st := CASE
    WHEN _result ? 'wait_event' THEN 'waiting_event'
    WHEN COALESCE(s.checkpoint ? 'role', false) THEN 'waiting_human'
    ELSE 'succeeded' END;
  UPDATE public.step_runs SET status = st, summary = left(_summary, 2000), output_artifacts = outs, lease_token = NULL, lease_expires_at = NULL,
    progress_text = NULL, finished_at = CASE WHEN st = 'succeeded' THEN now() ELSE NULL END,
    tokens = tokens + COALESCE((_result->>'tokens')::integer,0), model_calls = model_calls + COALESCE((_result->>'calls')::integer,0) WHERE id = _step;
  PERFORM public.sdf_event(_step, CASE WHEN st = 'waiting_human' THEN 'human' ELSE 'status' END,
    CASE WHEN st = 'waiting_human' THEN '等待确认：' || COALESCE(s.checkpoint->>'role','lead')
         WHEN st = 'waiting_event' THEN '等待外部事件：' || COALESCE(_result->>'wait_event','')
         ELSE '执行完成' END);
  PERFORM public.sdf_refresh_run(s.run_id);
  RETURN st;
END $$;

ALTER TABLE public.workflows DISABLE TRIGGER t_immutable;
UPDATE public.workflows SET startable = false WHERE key = 'new_app_small' AND version = '1.0.0';
ALTER TABLE public.workflows ENABLE TRIGGER t_immutable;
