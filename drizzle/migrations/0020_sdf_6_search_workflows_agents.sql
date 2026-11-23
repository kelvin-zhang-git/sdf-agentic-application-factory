-- 阶段 4：工作流可归属到应用，评论可 @人，智能体提示词按版本保存。
-- 内置工作流仍然不能改、不能删。自定义工作流可以改，也可以删。

ALTER TABLE public.workflows ADD COLUMN IF NOT EXISTS app_id uuid REFERENCES public.apps(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS workflows_app_idx ON public.workflows(app_id);

DROP POLICY IF EXISTS workflows_select ON public.workflows;
CREATE POLICY workflows_select ON public.workflows FOR SELECT TO authenticated
  USING (app_id IS NULL OR public.is_admin() OR public.has_app_role(app_id, NULL));

DROP TRIGGER IF EXISTS t_immutable ON public.workflows;
CREATE OR REPLACE FUNCTION public.sdf_workflow_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_builtin THEN RAISE EXCEPTION '内置工作流不能删除'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.is_builtin THEN RAISE EXCEPTION '内置工作流不能修改'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER t_workflow_guard BEFORE UPDATE OR DELETE ON public.workflows
  FOR EACH ROW EXECUTE FUNCTION public.sdf_workflow_guard();

ALTER TABLE public.comments ADD COLUMN IF NOT EXISTS mentioned_user_ids uuid[] NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS public.agent_roles (
  key text PRIMARY KEY,
  name text NOT NULL,
  summary text NOT NULL DEFAULT '',
  is_builtin boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS public.agent_prompt_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_key text NOT NULL REFERENCES public.agent_roles(key) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  prompt text NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (role_key, version)
);
GRANT SELECT ON public.agent_roles, public.agent_prompt_versions TO authenticated;
GRANT ALL ON public.agent_roles, public.agent_prompt_versions TO service_role;
ALTER TABLE public.agent_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_prompt_versions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS agent_roles_read ON public.agent_roles;
DROP POLICY IF EXISTS agent_prompts_read ON public.agent_prompt_versions;
CREATE POLICY agent_roles_read ON public.agent_roles FOR SELECT TO authenticated USING (true);
CREATE POLICY agent_prompts_read ON public.agent_prompt_versions FOR SELECT TO authenticated USING (true);

INSERT INTO public.agent_roles(key, name, summary) VALUES
  ('requirement_analyst', '需求分析师', '把资料整理成需求、验收标准和变更说明'),
  ('business_analyst', '业务分析师', '用业务语言说明这次改什么、不影响什么'),
  ('architect', '架构师', '写数据模型、接口和架构说明'),
  ('data_modeler', '数据建模师', '把业务对象落成可执行的表结构'),
  ('api_designer', '接口设计师', '描述页面会调用的接口'),
  ('test_designer', '测试设计师', '为每条验收标准补正常、例外和边界用例'),
  ('task_planner', '任务规划师', '把需求拆成可交接的开发任务'),
  ('handoff_coordinator', '开发交接员', '核对任务、分支和合并请求是否收齐'),
  ('document_writer', '文档撰写员', '生成规格、设计和发布说明'),
  ('business_assistant', '业务沟通助手', '整理澄清问题、确认点和验收清单')
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.agent_prompt_versions(role_key, version, prompt)
SELECT r.key, 1, '你是' || r.name || '。只用中文。先看已有制品，再给出可核对的结果。不要编造没有出处的编号，不要输出密钥。'
FROM public.agent_roles r
WHERE NOT EXISTS (SELECT 1 FROM public.agent_prompt_versions v WHERE v.role_key = r.key);
