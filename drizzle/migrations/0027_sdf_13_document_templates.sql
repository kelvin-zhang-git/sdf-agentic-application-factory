-- 报告模板：主表、不可变版本快照、制品类型绑定。内置 standard 不能删除、不能停用。
CREATE TABLE public.document_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE CHECK (key ~ '^[a-z][a-z0-9-]{0,40}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'retired')),
  is_builtin boolean NOT NULL DEFAULT false,
  is_default boolean NOT NULL DEFAULT false,
  current_version integer NOT NULL DEFAULT 1 CHECK (current_version >= 1),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX document_templates_one_default_idx
  ON public.document_templates (is_default)
  WHERE is_default AND status = 'active';

CREATE TABLE public.document_template_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id uuid NOT NULL REFERENCES public.document_templates(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  header_text text NOT NULL DEFAULT '{{app_name}} · {{classification}}',
  footer_text text NOT NULL DEFAULT '{{template_name}} · 内部交付资料',
  show_page_numbers boolean NOT NULL DEFAULT true,
  cover jsonb NOT NULL,
  style_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  change_note text NOT NULL DEFAULT '',
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (template_id, version)
);

CREATE TABLE public.template_bindings (
  artifact_type text PRIMARY KEY CHECK (char_length(artifact_type) BETWEEN 1 AND 60),
  template_id uuid NOT NULL REFERENCES public.document_templates(id) ON DELETE CASCADE,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.sdf_document_template_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_builtin THEN RAISE EXCEPTION '内置模板不能删除'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.is_builtin THEN
    IF NEW.key IS DISTINCT FROM OLD.key THEN RAISE EXCEPTION '内置模板不能改标识'; END IF;
    IF NEW.status IS DISTINCT FROM 'active' THEN RAISE EXCEPTION '内置模板不能停用'; END IF;
    IF NEW.is_builtin IS DISTINCT FROM true THEN RAISE EXCEPTION '内置模板不能取消内置标记'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER t_document_template_guard
  BEFORE UPDATE OR DELETE ON public.document_templates
  FOR EACH ROW EXECUTE FUNCTION public.sdf_document_template_guard();

GRANT SELECT, INSERT, UPDATE, DELETE ON public.document_templates, public.document_template_versions, public.template_bindings TO authenticated;
GRANT ALL ON public.document_templates, public.document_template_versions, public.template_bindings TO service_role;
ALTER TABLE public.document_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_template_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.template_bindings ENABLE ROW LEVEL SECURITY;
CREATE POLICY document_templates_read ON public.document_templates FOR SELECT TO authenticated USING (true);
CREATE POLICY document_templates_write ON public.document_templates FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY document_template_versions_read ON public.document_template_versions FOR SELECT TO authenticated USING (true);
CREATE POLICY document_template_versions_write ON public.document_template_versions FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY template_bindings_read ON public.template_bindings FOR SELECT TO authenticated USING (true);
CREATE POLICY template_bindings_write ON public.template_bindings FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

INSERT INTO public.document_templates (key, name, description, status, is_builtin, is_default, current_version)
VALUES ('standard', '标准交付文档', '平台内置模板。不能删除，也不能停用。未单独绑定的制品最终回退到这一套。', 'active', true, true, 1);

INSERT INTO public.document_template_versions (template_id, version, header_text, footer_text, show_page_numbers, cover, style_config, change_note)
SELECT id, 1, '{{app_name}} · {{classification}}', '{{template_name}} · 内部交付资料', true,
  '{"app_name":true,"classification":true,"artifact_version":true,"generated_at":true,"step_info":true,"agent_role":true}'::jsonb,
  '{"accent":"FF462D","font_ascii":"Calibri","font_east_asia":"Microsoft YaHei"}'::jsonb,
  '内置初始版本'
FROM public.document_templates WHERE key = 'standard';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'schema_migrations') THEN
    INSERT INTO public.schema_migrations(filename) VALUES ('0027_sdf_13_document_templates.sql') ON CONFLICT DO NOTHING;
  END IF;
END $$;
