CREATE TABLE public.secrets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('llm_provider')),
  ciphertext text NOT NULL,
  last4 text NOT NULL CHECK (char_length(last4) = 4),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL
);
REVOKE ALL ON public.secrets FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.secrets TO service_role;
ALTER TABLE public.secrets ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.llm_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE CHECK (char_length(name) BETWEEN 1 AND 100),
  base_url text NOT NULL,
  models text[] NOT NULL DEFAULT '{}',
  secret_id uuid NOT NULL REFERENCES public.secrets(id) ON DELETE RESTRICT,
  allowed_for_sensitive boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  priority integer NOT NULL DEFAULT 100 CHECK (priority > 0),
  last_status text NOT NULL DEFAULT 'untested' CHECK (last_status IN ('untested','success','error')),
  last_checked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.llm_providers TO authenticated;
GRANT ALL ON public.llm_providers TO service_role;
ALTER TABLE public.llm_providers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins manage LLM providers" ON public.llm_providers
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE TABLE public.model_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_tier text NOT NULL CHECK (task_tier IN ('fast','standard','deep')),
  provider_id uuid NOT NULL REFERENCES public.llm_providers(id) ON DELETE CASCADE,
  model text NOT NULL CHECK (char_length(model) BETWEEN 1 AND 200),
  fallback_order integer NOT NULL CHECK (fallback_order BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  UNIQUE (task_tier, fallback_order),
  UNIQUE (task_tier, provider_id, model)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.model_routes TO authenticated;
GRANT ALL ON public.model_routes TO service_role;
ALTER TABLE public.model_routes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins manage model routes" ON public.model_routes
  FOR ALL TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());

CREATE TABLE public.llm_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trace_id text,
  actor_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  app_id uuid REFERENCES public.apps(id) ON DELETE SET NULL,
  provider_id uuid REFERENCES public.llm_providers(id) ON DELETE SET NULL,
  task_tier text NOT NULL CHECK (task_tier IN ('fast','standard','deep')),
  model text NOT NULL,
  status text NOT NULL CHECK (status IN ('success','error')),
  duration_ms integer NOT NULL DEFAULT 0 CHECK (duration_ms >= 0),
  prompt_tokens integer NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
  completion_tokens integer NOT NULL DEFAULT 0 CHECK (completion_tokens >= 0),
  total_tokens integer NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt > 0),
  redacted boolean NOT NULL DEFAULT false,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.llm_calls TO authenticated;
GRANT ALL ON public.llm_calls TO service_role;
ALTER TABLE public.llm_calls ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins read LLM calls" ON public.llm_calls
  FOR SELECT TO authenticated USING (public.is_admin());
CREATE INDEX llm_calls_created_at_idx ON public.llm_calls (created_at DESC);
CREATE INDEX llm_calls_trace_id_idx ON public.llm_calls (trace_id);

CREATE TRIGGER secrets_touch_updated_at BEFORE UPDATE ON public.secrets
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER llm_providers_touch_updated_at BEFORE UPDATE ON public.llm_providers
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();
CREATE TRIGGER model_routes_touch_updated_at BEFORE UPDATE ON public.model_routes
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();