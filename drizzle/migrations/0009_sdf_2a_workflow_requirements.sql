ALTER TABLE public.llm_providers ADD COLUMN IF NOT EXISTS provider_type text NOT NULL DEFAULT 'openai_compatible';
ALTER TABLE public.llm_providers ADD CONSTRAINT llm_providers_type_chk CHECK (provider_type = 'openai_compatible');

CREATE TABLE public.app_counters(app_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE, kind text NOT NULL, next_val integer NOT NULL DEFAULT 1, PRIMARY KEY(app_id, kind));
GRANT ALL ON public.app_counters TO service_role;
ALTER TABLE public.app_counters ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.workflows(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key text NOT NULL, version text NOT NULL CHECK (version ~ '^\d+\.\d+\.\d+$'),
 name text NOT NULL, description text NOT NULL DEFAULT '', yaml text NOT NULL, definition jsonb NOT NULL,
 is_builtin boolean NOT NULL DEFAULT false, startable boolean NOT NULL DEFAULT false, copied_from uuid REFERENCES public.workflows(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(key, version));
GRANT SELECT ON public.workflows TO authenticated; GRANT ALL ON public.workflows TO service_role;
ALTER TABLE public.workflows ENABLE ROW LEVEL SECURITY;
CREATE POLICY workflows_select ON public.workflows FOR SELECT TO authenticated USING (true);

CREATE TABLE public.workflow_runs(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text NOT NULL, app_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
 workflow_id uuid NOT NULL REFERENCES public.workflows(id) ON DELETE RESTRICT, workflow_snapshot jsonb NOT NULL,
 weight text NOT NULL CHECK (weight IN ('light','standard','full')), inputs jsonb NOT NULL DEFAULT '{}'::jsonb,
 status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','waiting_human','waiting_event','waiting_model','failed','completed','cancelled')),
 current_step_key text, started_by uuid NOT NULL, trace_id text NOT NULL, lock_version integer NOT NULL DEFAULT 0,
 started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, UNIQUE(app_id, code));
GRANT SELECT ON public.workflow_runs TO authenticated; GRANT ALL ON public.workflow_runs TO service_role;
ALTER TABLE public.workflow_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY runs_select ON public.workflow_runs FOR SELECT TO authenticated USING (public.has_app_role(app_id, NULL) OR public.is_admin());

CREATE TABLE public.step_runs(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL REFERENCES public.workflow_runs(id) ON DELETE CASCADE,
 app_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
 step_key text NOT NULL, stage text NOT NULL, block_key text NOT NULL, seq integer NOT NULL, attempt integer NOT NULL DEFAULT 1 CHECK (attempt >= 1),
 is_current boolean NOT NULL DEFAULT true,
 status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','waiting_human','waiting_event','waiting_model','succeeded','rejected','failed','skipped','superseded','cancelled')),
 wait_reason text CHECK (wait_reason IN ('model_not_configured','model_unavailable','rate_limited')),
 checkpoint jsonb, decision text CHECK (decision IN ('approve','reject')), decided_by uuid, decision_comment text, reject_goto text,
 cursor jsonb, cursor_seq integer NOT NULL DEFAULT 0, lease_token uuid, lease_expires_at timestamptz, heartbeat_at timestamptz,
 retry_count integer NOT NULL DEFAULT 0, next_retry_at timestamptz, progress_text text, summary text, error jsonb,
 model_calls integer NOT NULL DEFAULT 0, tokens integer NOT NULL DEFAULT 0,
 input_artifacts jsonb NOT NULL DEFAULT '[]'::jsonb, output_artifacts jsonb NOT NULL DEFAULT '[]'::jsonb, skip_reason text,
 created_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz,
 UNIQUE(run_id, step_key, attempt),
 CONSTRAINT step_wait_reason_chk CHECK ((status = 'waiting_model') = (wait_reason IS NOT NULL)));
CREATE UNIQUE INDEX step_runs_current_uq ON public.step_runs(run_id, step_key) WHERE is_current;
CREATE UNIQUE INDEX step_runs_one_running_uq ON public.step_runs(run_id) WHERE status = 'running';
CREATE INDEX step_runs_sweep_idx ON public.step_runs(status, next_retry_at);
GRANT SELECT ON public.step_runs TO authenticated; GRANT ALL ON public.step_runs TO service_role;
ALTER TABLE public.step_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY step_runs_select ON public.step_runs FOR SELECT TO authenticated USING (public.has_app_role(app_id, NULL) OR public.is_admin());

CREATE TABLE public.step_chunk_results(
 step_run_id uuid NOT NULL REFERENCES public.step_runs(id) ON DELETE CASCADE, attempt integer NOT NULL, cursor_seq integer NOT NULL CHECK (cursor_seq >= 0),
 payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(step_run_id, attempt, cursor_seq));
GRANT ALL ON public.step_chunk_results TO service_role;
ALTER TABLE public.step_chunk_results ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.step_events(
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, step_run_id uuid NOT NULL REFERENCES public.step_runs(id) ON DELETE CASCADE,
 app_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE, ts timestamptz NOT NULL DEFAULT now(),
 kind text NOT NULL CHECK (kind IN ('status','progress','llm','connector','artifact','human','error')), message text NOT NULL, data jsonb NOT NULL DEFAULT '{}'::jsonb);
CREATE INDEX step_events_step_idx ON public.step_events(step_run_id, ts);
GRANT SELECT ON public.step_events TO authenticated; GRANT ALL ON public.step_events TO service_role;
ALTER TABLE public.step_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY step_events_select ON public.step_events FOR SELECT TO authenticated USING (public.has_app_role(app_id, NULL) OR public.is_admin());

CREATE TABLE public.artifacts(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), app_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
 type text NOT NULL, key text NOT NULL, version integer NOT NULL CHECK (version >= 1), title text NOT NULL,
 content text NOT NULL DEFAULT '', content_json jsonb, status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','rejected','superseded')),
 is_latest boolean NOT NULL DEFAULT true, step_run_id uuid REFERENCES public.step_runs(id) ON DELETE SET NULL,
 source text NOT NULL DEFAULT 'agent' CHECK (source IN ('agent','human','import','seed')), agent_role text, model text,
 confidence numeric CHECK (confidence >= 0 AND confidence <= 1), citations jsonb NOT NULL DEFAULT '[]'::jsonb,
 possibly_stale boolean NOT NULL DEFAULT false, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(app_id, type, key, version));
CREATE UNIQUE INDEX artifacts_latest_uq ON public.artifacts(app_id, type, key) WHERE is_latest;
GRANT SELECT ON public.artifacts TO authenticated; GRANT ALL ON public.artifacts TO service_role;
ALTER TABLE public.artifacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY artifacts_select ON public.artifacts FOR SELECT TO authenticated USING (public.has_app_role(app_id, NULL) OR public.is_admin());

CREATE TABLE public.sources(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text NOT NULL, app_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK (kind IN ('minutes','interview','document','chat','import')), title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
 meeting_date date, participants text[] NOT NULL DEFAULT '{}', file_path text, mime text, size_bytes integer CHECK (size_bytes IS NULL OR size_bytes <= 10485760),
 raw_text text, parse_status text NOT NULL DEFAULT 'uploaded' CHECK (parse_status IN ('uploaded','parsing','parsed','failed')), parse_error text,
 created_by uuid NOT NULL DEFAULT auth.uid(), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(app_id, code),
 CONSTRAINT sources_path_chk CHECK (file_path IS NULL OR file_path LIKE app_id::text || '/' || id::text || '/%'));
GRANT SELECT, INSERT, UPDATE, DELETE ON public.sources TO authenticated; GRANT ALL ON public.sources TO service_role;
ALTER TABLE public.sources ENABLE ROW LEVEL SECURITY;
CREATE POLICY sources_select ON public.sources FOR SELECT TO authenticated USING (public.has_app_role(app_id, NULL) OR public.is_admin());
CREATE POLICY sources_insert ON public.sources FOR INSERT TO authenticated WITH CHECK (created_by = auth.uid() AND (public.has_app_role(app_id, ARRAY['lead','ba']) OR public.is_admin()));
CREATE POLICY sources_update ON public.sources FOR UPDATE TO authenticated USING (public.has_app_role(app_id, ARRAY['lead','ba']) OR public.is_admin()) WITH CHECK (public.has_app_role(app_id, ARRAY['lead','ba']) OR public.is_admin());
CREATE POLICY sources_delete ON public.sources FOR DELETE TO authenticated USING (public.has_app_role(app_id, ARRAY['lead','ba']) OR public.is_admin());

CREATE TABLE public.source_segments(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), source_id uuid NOT NULL REFERENCES public.sources(id) ON DELETE CASCADE,
 app_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE, seq integer NOT NULL CHECK (seq >= 1), speaker text, text text NOT NULL,
 tags jsonb NOT NULL DEFAULT '{}'::jsonb, UNIQUE(source_id, seq));
GRANT SELECT ON public.source_segments TO authenticated; GRANT ALL ON public.source_segments TO service_role;
ALTER TABLE public.source_segments ENABLE ROW LEVEL SECURITY;
CREATE POLICY segments_select ON public.source_segments FOR SELECT TO authenticated USING (public.has_app_role(app_id, NULL) OR public.is_admin());

CREATE TABLE public.requirements(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text NOT NULL, app_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
 title text NOT NULL, story text NOT NULL DEFAULT '', type text NOT NULL DEFAULT 'functional' CHECK (type IN ('functional','non_functional')),
 priority text NOT NULL DEFAULT 'should' CHECK (priority IN ('must','should','could','wont')),
 status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','deprecated')), current_version integer NOT NULL DEFAULT 1,
 confidence numeric CHECK (confidence >= 0 AND confidence <= 1), citations jsonb NOT NULL CHECK (jsonb_typeof(citations) = 'array' AND jsonb_array_length(citations) > 0),
 possibly_stale boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(app_id, code));
GRANT SELECT ON public.requirements TO authenticated; GRANT ALL ON public.requirements TO service_role;
ALTER TABLE public.requirements ENABLE ROW LEVEL SECURITY;
CREATE POLICY requirements_select ON public.requirements FOR SELECT TO authenticated USING (public.has_app_role(app_id, NULL) OR public.is_admin());

CREATE TABLE public.acceptance_criteria(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text NOT NULL, requirement_id uuid NOT NULL REFERENCES public.requirements(id) ON DELETE CASCADE,
 app_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE, format text NOT NULL CHECK (format IN ('ears','gwt')), text text NOT NULL,
 requirement_version integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(app_id, code));
GRANT SELECT ON public.acceptance_criteria TO authenticated; GRANT ALL ON public.acceptance_criteria TO service_role;
ALTER TABLE public.acceptance_criteria ENABLE ROW LEVEL SECURITY;
CREATE POLICY ac_select ON public.acceptance_criteria FOR SELECT TO authenticated USING (public.has_app_role(app_id, NULL) OR public.is_admin());

CREATE TABLE public.requirement_versions(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), requirement_id uuid NOT NULL REFERENCES public.requirements(id) ON DELETE CASCADE,
 app_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE, version integer NOT NULL CHECK (version >= 1), snapshot jsonb NOT NULL,
 change_reason text NOT NULL DEFAULT '', step_run_id uuid REFERENCES public.step_runs(id) ON DELETE SET NULL, changed_by uuid,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(requirement_id, version));
GRANT SELECT ON public.requirement_versions TO authenticated; GRANT ALL ON public.requirement_versions TO service_role;
ALTER TABLE public.requirement_versions ENABLE ROW LEVEL SECURITY;
CREATE POLICY rv_select ON public.requirement_versions FOR SELECT TO authenticated USING (public.has_app_role(app_id, NULL) OR public.is_admin());

CREATE TABLE public.analysis_findings(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text NOT NULL, app_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
 run_id uuid REFERENCES public.workflow_runs(id) ON DELETE SET NULL, step_run_id uuid REFERENCES public.step_runs(id) ON DELETE SET NULL,
 severity text NOT NULL CHECK (severity IN ('blocker','major','minor')), category text NOT NULL, target_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
 description text NOT NULL, suggestion text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','accepted_risk','stale')),
 rule_or_agent text NOT NULL CHECK (rule_or_agent IN ('rule','agent')), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(app_id, code));
GRANT SELECT, UPDATE ON public.analysis_findings TO authenticated; GRANT ALL ON public.analysis_findings TO service_role;
ALTER TABLE public.analysis_findings ENABLE ROW LEVEL SECURITY;
CREATE POLICY af_select ON public.analysis_findings FOR SELECT TO authenticated USING (public.has_app_role(app_id, NULL) OR public.is_admin());
CREATE POLICY af_update ON public.analysis_findings FOR UPDATE TO authenticated USING (public.has_app_role(app_id, ARRAY['lead','ba']) OR public.is_admin()) WITH CHECK (public.has_app_role(app_id, ARRAY['lead','ba']) OR public.is_admin());

CREATE TABLE public.clarification_questions(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text NOT NULL, app_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
 step_run_id uuid REFERENCES public.step_runs(id) ON DELETE SET NULL, stakeholder text NOT NULL, contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
 question text NOT NULL, answer text CHECK (answer IS NULL OR length(answer) <= 5000),
 status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','applied','stale')),
 target_refs jsonb NOT NULL CHECK (jsonb_typeof(target_refs) = 'array' AND jsonb_array_length(target_refs) > 0),
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(app_id, code));
GRANT SELECT, UPDATE ON public.clarification_questions TO authenticated; GRANT ALL ON public.clarification_questions TO service_role;
ALTER TABLE public.clarification_questions ENABLE ROW LEVEL SECURITY;
CREATE POLICY cq_select ON public.clarification_questions FOR SELECT TO authenticated USING (public.has_app_role(app_id, NULL) OR public.is_admin());
CREATE POLICY cq_update ON public.clarification_questions FOR UPDATE TO authenticated USING (public.has_app_role(app_id, ARRAY['lead','ba']) OR public.is_admin()) WITH CHECK (public.has_app_role(app_id, ARRAY['lead','ba']) OR public.is_admin());

-- restrict which columns users may update
REVOKE UPDATE ON public.analysis_findings FROM authenticated; GRANT UPDATE (status) ON public.analysis_findings TO authenticated;
REVOKE UPDATE ON public.clarification_questions FROM authenticated; GRANT UPDATE (answer, status) ON public.clarification_questions TO authenticated;
REVOKE UPDATE ON public.sources FROM authenticated; GRANT UPDATE (title, kind, meeting_date, participants) ON public.sources TO authenticated;

-- code generator
CREATE OR REPLACE FUNCTION public.next_code(_app_id uuid, _kind text) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v integer;
BEGIN
  IF _kind NOT IN ('R','SRC','REQ','AC','F','Q') THEN RAISE EXCEPTION 'invalid code kind'; END IF;
  INSERT INTO public.app_counters(app_id, kind, next_val) VALUES (_app_id, _kind, 2)
  ON CONFLICT (app_id, kind) DO UPDATE SET next_val = public.app_counters.next_val + 1
  RETURNING next_val - 1 INTO v;
  RETURN _kind || '-' || lpad(v::text, 4, '0');
END $$;
REVOKE EXECUTE ON FUNCTION public.next_code(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.next_code(uuid, text) TO service_role;

-- integrity: same-app references
CREATE OR REPLACE FUNCTION public.sdf_check_same_app() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE ref text; bad integer;
BEGIN
  IF TG_TABLE_NAME = 'source_segments' THEN
    IF NOT EXISTS (SELECT 1 FROM public.sources s WHERE s.id = NEW.source_id AND s.app_id = NEW.app_id) THEN RAISE EXCEPTION 'SDF_REF_CROSS_APP: source'; END IF;
  ELSIF TG_TABLE_NAME = 'acceptance_criteria' OR TG_TABLE_NAME = 'requirement_versions' THEN
    IF NOT EXISTS (SELECT 1 FROM public.requirements r WHERE r.id = NEW.requirement_id AND r.app_id = NEW.app_id) THEN RAISE EXCEPTION 'SDF_REF_CROSS_APP: requirement'; END IF;
  ELSIF TG_TABLE_NAME = 'step_runs' THEN
    IF NOT EXISTS (SELECT 1 FROM public.workflow_runs w WHERE w.id = NEW.run_id AND w.app_id = NEW.app_id) THEN RAISE EXCEPTION 'SDF_REF_CROSS_APP: run'; END IF;
  ELSIF TG_TABLE_NAME = 'step_events' THEN
    IF NOT EXISTS (SELECT 1 FROM public.step_runs w WHERE w.id = NEW.step_run_id AND w.app_id = NEW.app_id) THEN RAISE EXCEPTION 'SDF_REF_CROSS_APP: step'; END IF;
  ELSIF TG_TABLE_NAME = 'requirements' THEN
    SELECT count(*) INTO bad FROM jsonb_array_elements(NEW.citations) c
      WHERE NOT EXISTS (SELECT 1 FROM public.source_segments g WHERE g.id::text = c->>'segment_id' AND g.app_id = NEW.app_id);
    IF bad > 0 THEN RAISE EXCEPTION 'SDF_REF_CROSS_APP: citation'; END IF;
  ELSIF TG_TABLE_NAME IN ('analysis_findings','clarification_questions') THEN
    IF TG_TABLE_NAME = 'clarification_questions' AND NEW.contact_id IS NOT NULL AND NOT EXISTS
      (SELECT 1 FROM public.app_contacts ac WHERE ac.contact_id = NEW.contact_id AND ac.app_id = NEW.app_id) THEN RAISE EXCEPTION 'SDF_REF_CROSS_APP: contact'; END IF;
    SELECT count(*) INTO bad FROM jsonb_array_elements(NEW.target_refs) t WHERE NOT (
      (t->>'type' = 'requirement' AND EXISTS (SELECT 1 FROM public.requirements r WHERE r.id::text = t->>'id' AND r.app_id = NEW.app_id)) OR
      (t->>'type' = 'finding' AND EXISTS (SELECT 1 FROM public.analysis_findings f WHERE f.id::text = t->>'id' AND f.app_id = NEW.app_id)));
    IF bad > 0 THEN RAISE EXCEPTION 'SDF_REF_CROSS_APP: target_ref'; END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION public.sdf_check_same_app() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER t_same_app BEFORE INSERT OR UPDATE ON public.source_segments FOR EACH ROW EXECUTE FUNCTION public.sdf_check_same_app();
CREATE TRIGGER t_same_app BEFORE INSERT OR UPDATE ON public.acceptance_criteria FOR EACH ROW EXECUTE FUNCTION public.sdf_check_same_app();
CREATE TRIGGER t_same_app BEFORE INSERT OR UPDATE ON public.requirement_versions FOR EACH ROW EXECUTE FUNCTION public.sdf_check_same_app();
CREATE TRIGGER t_same_app BEFORE INSERT OR UPDATE ON public.step_runs FOR EACH ROW EXECUTE FUNCTION public.sdf_check_same_app();
CREATE TRIGGER t_same_app BEFORE INSERT ON public.step_events FOR EACH ROW EXECUTE FUNCTION public.sdf_check_same_app();
CREATE TRIGGER t_same_app BEFORE INSERT OR UPDATE OF citations ON public.requirements FOR EACH ROW EXECUTE FUNCTION public.sdf_check_same_app();
CREATE TRIGGER t_same_app BEFORE INSERT OR UPDATE OF target_refs ON public.analysis_findings FOR EACH ROW EXECUTE FUNCTION public.sdf_check_same_app();
CREATE TRIGGER t_same_app BEFORE INSERT OR UPDATE OF target_refs, contact_id ON public.clarification_questions FOR EACH ROW EXECUTE FUNCTION public.sdf_check_same_app();

-- append-only versions and builtin workflows
CREATE OR REPLACE FUNCTION public.sdf_forbid_change() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_TABLE_NAME = 'workflows' AND NOT OLD.is_builtin THEN RETURN COALESCE(NEW, OLD); END IF;
  RAISE EXCEPTION 'SDF_IMMUTABLE: % rows cannot be changed', TG_TABLE_NAME;
END $$;
CREATE TRIGGER t_immutable BEFORE UPDATE OR DELETE ON public.requirement_versions FOR EACH ROW EXECUTE FUNCTION public.sdf_forbid_change();
CREATE TRIGGER t_immutable BEFORE UPDATE OR DELETE ON public.workflows FOR EACH ROW EXECUTE FUNCTION public.sdf_forbid_change();

-- storage policies for private bucket "sources": path {app_id}/{source_id}/{file}
CREATE POLICY sdf_sources_read ON storage.objects FOR SELECT TO authenticated USING (
  bucket_id = 'sources' AND (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
  AND (public.has_app_role(((storage.foldername(name))[1])::uuid, NULL) OR public.is_admin()));
CREATE POLICY sdf_sources_insert ON storage.objects FOR INSERT TO authenticated WITH CHECK (
  bucket_id = 'sources' AND (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
  AND (public.has_app_role(((storage.foldername(name))[1])::uuid, ARRAY['lead','ba']) OR public.is_admin()));
CREATE POLICY sdf_sources_delete ON storage.objects FOR DELETE TO authenticated USING (
  bucket_id = 'sources' AND (storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$'
  AND (public.has_app_role(((storage.foldername(name))[1])::uuid, ARRAY['lead','ba']) OR public.is_admin()));