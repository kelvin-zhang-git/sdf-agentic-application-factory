-- 阶段 3：上线后的反馈、变更、验收和业务门户。0018 已用于连接器。

CREATE OR REPLACE FUNCTION public.is_business_only(_user_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.app_members m WHERE m.user_id = _user_id)
    AND NOT EXISTS (SELECT 1 FROM public.app_members m WHERE m.user_id = _user_id AND m.role <> 'business')
    AND NOT EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = _user_id);
$$;
REVOKE ALL ON FUNCTION public.is_business_only(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_business_only(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.next_code(_app_id uuid, _kind text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v integer; width integer := 4;
BEGIN
  IF _kind NOT IN ('R','SRC','REQ','AC','F','Q','T','TC','FB','CR','DEC','IT') THEN RAISE EXCEPTION 'invalid code kind'; END IF;
  IF _kind = 'IT' THEN width := 2; END IF;
  INSERT INTO public.app_counters(app_id, kind, next_val) VALUES (_app_id, _kind, 2)
  ON CONFLICT (app_id, kind) DO UPDATE SET next_val = public.app_counters.next_val + 1
  RETURNING next_val - 1 INTO v;
  RETURN _kind || '-' || lpad(v::text, width, '0');
END $$;

CREATE TABLE public.feedback_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
  code text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','triaged','accepted','released','wontfix')),
  category text CHECK (category IN ('bug','new_feature','change','question','wontfix')),
  duplicate_code text,
  requirement_code text,
  suggested_priority text,
  triage_reason text,
  attachment_path text,
  released_in text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, code)
);
CREATE TABLE public.iterations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','released')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, code)
);
CREATE TABLE public.change_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
  code text NOT NULL,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_confirm','approved','rejected','released')),
  business_summary text NOT NULL DEFAULT '',
  requirement_codes text[] NOT NULL DEFAULT '{}',
  iteration_id uuid REFERENCES public.iterations(id) ON DELETE SET NULL,
  run_id uuid,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, code)
);
CREATE TABLE public.cr_feedback (
  change_request_id uuid NOT NULL REFERENCES public.change_requests(id) ON DELETE CASCADE,
  feedback_id uuid NOT NULL REFERENCES public.feedback_items(id) ON DELETE CASCADE,
  PRIMARY KEY (change_request_id, feedback_id)
);
CREATE TABLE public.releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
  iteration_id uuid REFERENCES public.iterations(id) ON DELETE SET NULL,
  version text NOT NULL,
  notes_business text NOT NULL DEFAULT '',
  notes_technical text NOT NULL DEFAULT '',
  published_at timestamptz NOT NULL DEFAULT now(),
  published_by uuid,
  UNIQUE (app_id, version)
);
CREATE TABLE public.uat_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
  iteration_id uuid REFERENCES public.iterations(id) ON DELETE SET NULL,
  change_request_id uuid REFERENCES public.change_requests(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.uat_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.uat_sessions(id) ON DELETE CASCADE,
  app_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
  ac_code text NOT NULL,
  title text NOT NULL,
  steps text NOT NULL DEFAULT '',
  expected text NOT NULL DEFAULT '',
  assignee_profile_id uuid,
  result text NOT NULL DEFAULT 'pending' CHECK (result IN ('pending','passed','failed')),
  fail_reason text,
  feedback_id uuid REFERENCES public.feedback_items(id) ON DELETE SET NULL
);
CREATE TABLE public.decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
  code text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  made_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, code)
);
CREATE TABLE public.comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
  target_kind text NOT NULL,
  target_id uuid NOT NULL,
  body text NOT NULL,
  author_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.baselines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid NOT NULL REFERENCES public.apps(id) ON DELETE CASCADE,
  version text NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (app_id, version)
);
CREATE TABLE public.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id uuid REFERENCES public.apps(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.hooks (
  event_key text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT true,
  description text NOT NULL
);

INSERT INTO public.hooks(event_key, enabled, description) VALUES
  ('feedback.created', true, '新反馈自动给出分类建议'),
  ('change_request.approved', true, '变更确认后提醒负责人可以启动功能增强'),
  ('report.imported', true, '测试报告上传后重新计算交付检查'),
  ('merge_request.collected', true, '合并请求收齐后结束交接等待'),
  ('uat.item_failed', true, '验收不通过时自动生成一条缺陷反馈'),
  ('release.published', true, '发布时冻结基线并通知反馈提交人');

GRANT SELECT ON public.feedback_items, public.iterations, public.change_requests, public.cr_feedback, public.releases, public.uat_sessions, public.uat_items, public.decisions, public.comments, public.baselines, public.notifications, public.hooks TO authenticated;
GRANT INSERT ON public.feedback_items, public.comments, public.decisions TO authenticated;
GRANT UPDATE ON public.uat_items, public.notifications TO authenticated;
GRANT ALL ON public.feedback_items, public.iterations, public.change_requests, public.cr_feedback, public.releases, public.uat_sessions, public.uat_items, public.decisions, public.comments, public.baselines, public.notifications, public.hooks TO service_role;

ALTER TABLE public.feedback_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.iterations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.change_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cr_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.uat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.uat_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.baselines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hooks ENABLE ROW LEVEL SECURITY;

CREATE POLICY feedback_select ON public.feedback_items FOR SELECT TO authenticated USING (public.has_app_role(app_id, NULL) OR public.is_admin());
CREATE POLICY feedback_insert ON public.feedback_items FOR INSERT TO authenticated WITH CHECK (created_by = auth.uid() AND (public.has_app_role(app_id, NULL) OR public.is_admin()));
CREATE POLICY iterations_select ON public.iterations FOR SELECT TO authenticated USING (public.has_app_role(app_id, NULL) OR public.is_admin());
CREATE POLICY change_requests_select ON public.change_requests FOR SELECT TO authenticated USING (public.has_app_role(app_id, NULL) OR public.is_admin());
CREATE POLICY cr_feedback_select ON public.cr_feedback FOR SELECT TO authenticated USING (
  EXISTS (SELECT 1 FROM public.change_requests c WHERE c.id = change_request_id AND (public.has_app_role(c.app_id, NULL) OR public.is_admin())));
CREATE POLICY releases_select ON public.releases FOR SELECT TO authenticated USING (public.has_app_role(app_id, NULL) OR public.is_admin());
CREATE POLICY uat_sessions_select ON public.uat_sessions FOR SELECT TO authenticated USING (public.has_app_role(app_id, NULL) OR public.is_admin());
CREATE POLICY uat_items_select ON public.uat_items FOR SELECT TO authenticated USING (
  public.is_admin()
  OR (public.has_app_role(app_id, NULL) AND NOT public.is_business_only(auth.uid()))
  OR assignee_profile_id = auth.uid());
CREATE POLICY uat_items_update ON public.uat_items FOR UPDATE TO authenticated
  USING (assignee_profile_id = auth.uid() OR public.has_app_role(app_id, ARRAY['lead','qa']) OR public.is_admin())
  WITH CHECK (assignee_profile_id = auth.uid() OR public.has_app_role(app_id, ARRAY['lead','qa']) OR public.is_admin());
CREATE POLICY decisions_select ON public.decisions FOR SELECT TO authenticated USING (public.has_app_role(app_id, NULL) OR public.is_admin());
CREATE POLICY decisions_insert ON public.decisions FOR INSERT TO authenticated WITH CHECK (made_by = auth.uid() AND (public.has_app_role(app_id, NULL) OR public.is_admin()));
CREATE POLICY comments_select ON public.comments FOR SELECT TO authenticated USING (public.has_app_role(app_id, NULL) OR public.is_admin());
CREATE POLICY comments_insert ON public.comments FOR INSERT TO authenticated WITH CHECK (author_id = auth.uid() AND (public.has_app_role(app_id, NULL) OR public.is_admin()));
CREATE POLICY baselines_select ON public.baselines FOR SELECT TO authenticated USING (public.has_app_role(app_id, NULL) OR public.is_admin());
CREATE POLICY notifications_select ON public.notifications FOR SELECT TO authenticated USING (user_id = auth.uid() OR public.is_admin());
CREATE POLICY notifications_update ON public.notifications FOR UPDATE TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY hooks_admin ON public.hooks FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

-- 业务方看不到任务、合并请求、扫描结果和技术制品。
DROP POLICY IF EXISTS tasks_select ON public.tasks;
CREATE POLICY tasks_select ON public.tasks FOR SELECT TO authenticated USING (
  (public.has_app_role(app_id, NULL) OR public.is_admin()) AND NOT public.is_business_only(auth.uid()));
DROP POLICY IF EXISTS merge_requests_select ON public.merge_requests;
CREATE POLICY merge_requests_select ON public.merge_requests FOR SELECT TO authenticated USING (
  (public.has_app_role(app_id, NULL) OR public.is_admin()) AND NOT public.is_business_only(auth.uid()));
DROP POLICY IF EXISTS scan_findings_select ON public.scan_findings;
CREATE POLICY scan_findings_select ON public.scan_findings FOR SELECT TO authenticated USING (
  (public.has_app_role(app_id, NULL) OR public.is_admin()) AND NOT public.is_business_only(auth.uid()));
DROP POLICY IF EXISTS artifacts_select ON public.artifacts;
CREATE POLICY artifacts_select ON public.artifacts FOR SELECT TO authenticated USING (
  public.is_admin()
  OR (
    public.has_app_role(app_id, NULL)
    AND (
      NOT public.is_business_only(auth.uid())
      OR type IN ('prototype_html', 'business_summary', 'notes_business')
    )
  )
);

-- 验收不通过时生成缺陷反馈，并挂回原来的变更。
CREATE OR REPLACE FUNCTION public.sdf_on_uat_failed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE fid uuid; fcode text; cr uuid;
BEGIN
  IF NEW.result IS DISTINCT FROM 'failed' OR OLD.result = 'failed' THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.hooks WHERE event_key = 'uat.item_failed' AND enabled) THEN RETURN NEW; END IF;
  IF COALESCE(trim(NEW.fail_reason), '') = '' THEN RAISE EXCEPTION 'SDF_VALIDATION: fail reason'; END IF;
  fcode := public.next_code(NEW.app_id, 'FB');
  INSERT INTO public.feedback_items(app_id, code, title, body, status, category, created_by)
  VALUES (NEW.app_id, fcode, '验收未通过 ' || NEW.ac_code, NEW.fail_reason, 'open', 'bug', NEW.assignee_profile_id)
  RETURNING id INTO fid;
  NEW.feedback_id := fid;
  SELECT s.change_request_id INTO cr FROM public.uat_sessions s WHERE s.id = NEW.session_id;
  IF cr IS NOT NULL THEN
    INSERT INTO public.cr_feedback(change_request_id, feedback_id) VALUES (cr, fid) ON CONFLICT DO NOTHING;
  END IF;
  INSERT INTO public.notifications(app_id, user_id, title, body)
  SELECT NEW.app_id, m.user_id, '有一条验收没有通过', NEW.ac_code || '：' || left(NEW.fail_reason, 120)
  FROM public.app_members m WHERE m.app_id = NEW.app_id AND m.role IN ('lead','qa');
  RETURN NEW;
END $$;
CREATE TRIGGER t_uat_failed BEFORE UPDATE ON public.uat_items
  FOR EACH ROW EXECUTE FUNCTION public.sdf_on_uat_failed();
